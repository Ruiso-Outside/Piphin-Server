// Piphin Agent · a máquina inteira: monitoramento (núcleos, temperatura, ventoinhas, discos, rede, processos, histórico)
// e controle (atualizações, ligar e desligar, serviços, firewall, logs, fuso e nome). Tudo com comandos fixos, sem shell.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile, spawn } = require("child_process");

const PROC = process.env.PIPHIN_PROC || "/proc";
const SYS = process.env.PIPHIN_SYS || "/sys";
const FAKE_CMD = process.env.PIPHIN_FAKE_CMD; // só nos testes: um script no lugar de systemctl, apt, ufw...
const REBOOT_FLAG = process.env.PIPHIN_REBOOT_FLAG || "/var/run/reboot-required";
const INSTALL_URL = "https://github.com/Ruiso-Outside/Piphin-Server/releases/latest/download/install.sh";
const ENV = { ...process.env, LC_ALL: "C", LANG: "C", DEBIAN_FRONTEND: "noninteractive", NEEDRESTART_MODE: "l", PATH: `${process.env.PATH || ""}:/usr/sbin:/sbin:/usr/bin:/bin` };

const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const list = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const argv = (cmd, args) => (FAKE_CMD ? [process.execPath, [FAKE_CMD, cmd, ...args]] : [cmd, args]);
function run(cmd, args = [], { timeout = 30000, ok = false } = {}) {
  return new Promise((resolve, reject) => {
    const [c, a] = argv(cmd, args);
    execFile(c, a, { env: ENV, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, out, errOut) => {
      if (err && err.code === "ENOENT") return reject(bad(`Este sistema não tem o comando ${cmd}`, 501));
      if (err && !ok) return reject(bad(String(errOut || err.message).trim().split("\n").slice(-3).join(" ").slice(0, 400) || `${cmd} falhou`, 500));
      resolve(String(out));
    });
  });
}
const has = (cmd) => run("which", [cmd], { ok: true }).then((o) => !!o.trim()).catch(() => false);

// ---------------------------------------------------------------- sensores
function hwmon() {
  const temps = [], fans = [];
  const base = path.join(SYS, "class", "hwmon");
  for (const d of list(base)) {
    const dir = path.join(base, d), chip = read(path.join(dir, "name")).trim() || d;
    for (const f of list(dir)) {
      const t = /^temp(\d+)_input$/.exec(f);
      if (t) {
        const v = Number(read(path.join(dir, f))) / 1000; if (!isFinite(v) || v <= -50 || v >= 200) continue;
        const crit = Number(read(path.join(dir, `temp${t[1]}_crit`))) / 1000 || Number(read(path.join(dir, `temp${t[1]}_max`))) / 1000 || null;
        temps.push({ chip, label: read(path.join(dir, `temp${t[1]}_label`)).trim() || `temp${t[1]}`, c: Math.round(v * 10) / 10, crit: crit && crit < 200 ? crit : null });
      }
      const n = /^fan(\d+)_input$/.exec(f);
      if (n) fans.push({ chip, label: read(path.join(dir, `fan${n[1]}_label`)).trim() || `fan${n[1]}`, rpm: Number(read(path.join(dir, f))) || 0 });
    }
  }
  if (!temps.length) { // sem hwmon: as zonas térmicas do kernel
    const tz = path.join(SYS, "class", "thermal");
    for (const d of list(tz)) {
      if (!d.startsWith("thermal_zone")) continue;
      const v = Number(read(path.join(tz, d, "temp"))) / 1000;
      if (isFinite(v) && v > 0 && v < 200) temps.push({ chip: "thermal", label: read(path.join(tz, d, "type")).trim() || d, c: Math.round(v * 10) / 10, crit: null });
    }
  }
  return { temps, fans };
}
// a temperatura "do processador": o sensor geral do pacote, ou o mais quente dos sensores do processador
function cpuTemp(temps) {
  const cpu = temps.filter((t) => /coretemp|k10temp|zenpower|cpu_thermal|x86_pkg_temp|acpitz/i.test(`${t.chip} ${t.label}`));
  const main = cpu.find((t) => /package|tctl|tdie/i.test(t.label));
  if (main) return main.c;
  return cpu.length ? Math.max(...cpu.map((t) => t.c)) : null;
}

// ---------------------------------------------------------------- amostras
class Monitor {
  constructor(dataDir, docker) {
    this.dataDir = dataDir; this.docker = docker;
    this.prev = {}; this.latest = null;
    this.hour = []; this.day = []; this.minute = [];
    this.gpu = null; this.failed = 0; this.dockerOk = true;
  }
  start() {
    this.sample();
    setInterval(() => this.sample(), 5000).unref();
    const slow = () => {
      this.slowGpu().catch(() => {});
      run("systemctl", ["list-units", "--state=failed", "--type=service", "--no-legend", "--plain", "--no-pager"], { ok: true, timeout: 10000 }).then((o) => { this.failed = o.split("\n").filter((l) => l.trim()).length; }).catch(() => {});
      this.docker.version().then(() => { this.dockerOk = true; }).catch(() => { this.dockerOk = false; });
    };
    slow(); setInterval(slow, 30000).unref();
  }
  async slowGpu() {
    if (this.gpuMissing) return;
    if (!(await has("nvidia-smi"))) { this.gpuMissing = true; return; }
    const o = await run("nvidia-smi", ["--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], { timeout: 8000 });
    this.gpu = o.trim().split("\n").filter(Boolean).map((l) => { const [name, util, temp, used, total] = l.split(",").map((x) => x.trim()); return { name, util: Number(util), temp: Number(temp), memUsed: Number(used) * 1048576, memTotal: Number(total) * 1048576 }; });
  }
  cores() {
    const lines = read(path.join(PROC, "stat")).split("\n").filter((l) => /^cpu\d* /.test(l));
    let cur;
    if (lines.length) cur = lines.map((l) => { const v = l.trim().split(/\s+/).slice(1).map(Number); return { idle: v[3] + (v[4] || 0), total: v.reduce((a, b) => a + b, 0), iowait: v[4] || 0 }; });
    else { // fora do Linux
      const c = os.cpus().map((x) => ({ idle: x.times.idle, total: Object.values(x.times).reduce((a, b) => a + b, 0), iowait: 0 }));
      cur = [{ idle: c.reduce((a, x) => a + x.idle, 0), total: c.reduce((a, x) => a + x.total, 0), iowait: 0 }, ...c];
    }
    const prev = this.prev.cpu; this.prev.cpu = cur;
    const pct = (a, b) => (b && a.total > b.total ? Math.round((1 - (a.idle - b.idle) / (a.total - b.total)) * 1000) / 10 : 0);
    const freqs = (read(path.join(PROC, "cpuinfo")).match(/^cpu MHz\s*:\s*[\d.]+/gm) || []).map((l) => Math.round(Number(l.split(":")[1])));
    return {
      total: pct(cur[0], prev && prev[0]),
      iowait: prev && cur[0].total > prev[0].total ? Math.round(((cur[0].iowait - prev[0].iowait) / (cur[0].total - prev[0].total)) * 1000) / 10 : 0,
      cores: cur.slice(1).map((c, i) => ({ pct: pct(c, prev && prev[i + 1]), mhz: freqs[i] || null })),
    };
  }
  memory() {
    const m = read(path.join(PROC, "meminfo"));
    if (!m) return { total: os.totalmem(), used: os.totalmem() - os.freemem(), available: os.freemem(), cached: 0, buffers: 0, swapTotal: 0, swapUsed: 0 };
    const g = (k) => Number((new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(m) || [])[1] || 0) * 1024;
    return { total: g("MemTotal"), used: g("MemTotal") - g("MemAvailable"), available: g("MemAvailable"), cached: g("Cached") + g("SReclaimable"), buffers: g("Buffers"), swapTotal: g("SwapTotal"), swapUsed: g("SwapTotal") - g("SwapFree") };
  }
  network(dt) {
    const out = [], cur = {};
    for (const line of read(path.join(PROC, "net", "dev")).split("\n").slice(2)) {
      const m = /^\s*([^:]+):\s*(.*)$/.exec(line); if (!m || /^(lo|veth|br-|docker)/.test(m[1])) continue;
      const v = m[2].trim().split(/\s+/).map(Number), p = (this.prev.net || {})[m[1]];
      cur[m[1]] = { rx: v[0], tx: v[8] };
      out.push({ name: m[1], rx: p && dt ? Math.max(0, (v[0] - p.rx) / dt) : 0, tx: p && dt ? Math.max(0, (v[8] - p.tx) / dt) : 0, rxTotal: v[0], txTotal: v[8], errors: (v[2] || 0) + (v[10] || 0) });
    }
    this.prev.net = cur;
    return out;
  }
  diskIo(dt) {
    const out = [], cur = {};
    const real = new Set(list(path.join(SYS, "block")).filter((d) => !/^(loop|ram|zram|sr|fd)/.test(d)));
    for (const line of read(path.join(PROC, "diskstats")).split("\n")) {
      const v = line.trim().split(/\s+/); if (v.length < 14 || !real.has(v[2])) continue;
      const r = Number(v[5]) * 512, w = Number(v[9]) * 512, busy = Number(v[12]), p = (this.prev.io || {})[v[2]];
      cur[v[2]] = { r, w, busy };
      out.push({ name: v[2], read: p && dt ? Math.max(0, (r - p.r) / dt) : 0, write: p && dt ? Math.max(0, (w - p.w) / dt) : 0, busy: p && dt ? Math.min(100, Math.round((busy - p.busy) / (dt * 10))) : 0 });
    }
    this.prev.io = cur;
    return out;
  }
  mounts() {
    const seen = new Set(), out = [];
    for (const line of read(path.join(PROC, "mounts")).split("\n")) {
      const [dev, dir, type] = line.split(" ");
      if (!dev || !dev.startsWith("/dev/") || /^\/dev\/loop/.test(dev) || seen.has(dev) || /^(squashfs|tmpfs|overlay)$/.test(type)) continue;
      const where = dir.replace(/\\040/g, " ");
      try { const s = fs.statfsSync(where); seen.add(dev); out.push({ device: dev, mount: where, type, total: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize, free: s.bavail * s.bsize }); } catch {}
    }
    if (!out.length) { try { const s = fs.statfsSync(this.dataDir); out.push({ device: "", mount: this.dataDir, type: "", total: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize, free: s.bavail * s.bsize }); } catch {} }
    return out;
  }
  sample() {
    const t = Date.now(), dt = this.prev.t ? (t - this.prev.t) / 1000 : 0;
    this.prev.t = t;
    const cpu = this.cores(), { temps, fans } = hwmon(), net = this.network(dt), io = this.diskIo(dt), memory = this.memory();
    const temp = cpuTemp(temps);
    this.latest = { at: t, cpu, memory, temps, fans, cpuTemp: temp, net, io, mounts: this.mounts(), load: os.loadavg(), uptime: os.uptime(), gpu: this.gpu, procs: list(PROC).filter((d) => /^\d+$/.test(d)).length };
    const point = { t, cpu: cpu.total, mem: memory.total ? Math.round((memory.used / memory.total) * 1000) / 10 : 0, temp,
      rx: net.reduce((a, n) => a + n.rx, 0), tx: net.reduce((a, n) => a + n.tx, 0), read: io.reduce((a, d) => a + d.read, 0), write: io.reduce((a, d) => a + d.write, 0) };
    this.hour.push(point); if (this.hour.length > 720) this.hour.shift();
    // 24 horas: a média de cada minuto
    this.minute.push(point);
    if (t - this.minute[0].t >= 60000) {
      const avg = (k) => { const v = this.minute.map((p) => p[k]).filter((x) => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
      this.day.push({ t, cpu: avg("cpu"), mem: avg("mem"), temp: avg("temp"), rx: avg("rx"), tx: avg("tx"), read: avg("read"), write: avg("write") });
      if (this.day.length > 1440) this.day.shift();
      this.minute = [];
    }
    return this.latest;
  }
  history(range) { return range === "24h" ? this.day : this.hour; }
  alerts() {
    const out = [], l = this.latest; if (!l) return out;
    const add = (level, code, values = {}) => out.push({ level, code, ...values });
    for (const m of l.mounts) { const p = m.total ? Math.round((m.used / m.total) * 100) : 0; if (p >= 90) add(p >= 96 ? "bad" : "warn", "disk", { mount: m.mount, pct: p }); }
    const mp = l.memory.total ? Math.round((l.memory.used / l.memory.total) * 100) : 0; if (mp >= 90) add(mp >= 97 ? "bad" : "warn", "memory", { pct: mp });
    for (const t of l.temps) { const lim = t.crit || 95; if (t.c >= lim - 5) add(t.c >= lim ? "bad" : "warn", "temp", { sensor: `${t.chip} ${t.label}`, c: t.c }); }
    if (this.failed) add("warn", "services", { count: this.failed });
    if (fs.existsSync(REBOOT_FLAG)) add("warn", "reboot");
    if (!this.dockerOk) add("bad", "docker");
    return out;
  }
}

// ---------------------------------------------------------------- processos (uso real entre duas leituras)
function procRead() {
  const out = new Map();
  for (const d of list(PROC)) {
    if (!/^\d+$/.test(d)) continue;
    const s = read(path.join(PROC, d, "stat")), i = s.lastIndexOf(")"); if (i < 0) continue;
    const f = s.slice(i + 2).split(" ");
    out.set(Number(d), { pid: Number(d), name: s.slice(s.indexOf("(") + 1, i), state: f[0], ticks: Number(f[11]) + Number(f[12]), rss: Number(f[21]) * 4096 });
  }
  return out;
}
async function processes(limit = 40) {
  const a = procRead(), t0 = Date.now();
  await new Promise((r) => setTimeout(r, 600));
  const b = procRead(), secs = (Date.now() - t0) / 1000;
  const users = {};
  for (const l of read("/etc/passwd").split("\n")) { const p = l.split(":"); if (p[2]) users[p[2]] = p[0]; }
  const rows = [...b.values()].map((p) => ({ ...p, cpu: a.has(p.pid) ? Math.max(0, Math.round(((p.ticks - a.get(p.pid).ticks) / 100 / secs) * 1000) / 10) : 0 }));
  rows.sort((x, y) => y.cpu - x.cpu || y.rss - x.rss);
  return rows.slice(0, Math.min(200, limit)).map((p) => {
    const uid = (/^Uid:\s+(\d+)/m.exec(read(path.join(PROC, String(p.pid), "status"))) || [])[1];
    return { pid: p.pid, name: p.name, state: p.state, cpu: p.cpu, rss: p.rss, user: users[uid] || uid || "", cmd: read(path.join(PROC, String(p.pid), "cmdline")).replace(/\0+/g, " ").trim().slice(0, 300) };
  });
}
function killProcess(pid, signal) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 1) throw bad("Esse processo não pode ser parado");
  if (pid === process.pid) throw bad("Esse processo é o próprio agente");
  if (!["SIGTERM", "SIGKILL"].includes(signal)) throw bad("Sinal inválido");
  try { process.kill(pid, signal); } catch (e) { throw bad(e.code === "ESRCH" ? "Esse processo já terminou" : e.message); }
  return true;
}

// ---------------------------------------------------------------- discos: saúde (smartctl, se existir)
async function smart() {
  if (!(await has("smartctl"))) return { available: false, disks: [] };
  let devs = [];
  try { devs = (JSON.parse(await run("smartctl", ["--scan-open", "-j"], { ok: true })).devices || []).map((d) => d.name); } catch { /* sem discos */ }
  const disks = [];
  for (const dev of devs.slice(0, 16)) {
    try {
      const j = JSON.parse(await run("smartctl", ["-a", "-j", dev], { ok: true, timeout: 20000 }));
      const nvme = j.nvme_smart_health_information_log || {};
      disks.push({ device: dev, model: j.model_name || "", size: (j.user_capacity && j.user_capacity.bytes) || 0, healthy: j.smart_status ? j.smart_status.passed !== false : null,
        temp: (j.temperature && j.temperature.current) ?? null, hours: (j.power_on_time && j.power_on_time.hours) ?? null, wear: nvme.percentage_used ?? null });
    } catch { /* disco sem suporte */ }
  }
  return { available: true, disks };
}

// ---------------------------------------------------------------- tarefas demoradas (atualizar o sistema, desligar): uma por vez, com o texto ao vivo
class Jobs {
  constructor(emit) { this.emit = emit; this.cur = null; }
  view() { return this.cur && { id: this.cur.id, kind: this.cur.kind, state: this.cur.state, lines: this.cur.lines.slice(-400), startedAt: this.cur.startedAt, code: this.cur.code }; }
  line(text) { const j = this.cur; if (!j) return; for (const l of String(text).replace(/\r/g, "\n").split("\n")) { if (!l.trim()) continue; j.lines.push(l); if (j.lines.length > 2000) j.lines.shift(); this.emit({ id: j.id, kind: j.kind, line: l }); } }
  begin(kind) {
    if (this.cur && this.cur.state === "running") throw bad("Já tem uma tarefa rodando nesta máquina. Espere ela terminar", 409);
    this.cur = { id: Date.now().toString(36), kind, state: "running", lines: [], startedAt: Date.now(), code: null };
    this.emit({ id: this.cur.id, kind, state: "running" });
    return this.cur;
  }
  end(code) { const j = this.cur; j.state = code === 0 ? "done" : "failed"; j.code = code; this.emit({ id: j.id, kind: j.kind, state: j.state, code }); }
  exec(cmd, args, timeout = 3600000) {
    return new Promise((resolve) => {
      const [c, a] = argv(cmd, args);
      const p = spawn(c, a, { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => p.kill("SIGKILL"), timeout);
      let partial = "";
      const feed = (d) => { partial += d; const i = partial.lastIndexOf("\n"); if (i >= 0) { this.line(partial.slice(0, i)); partial = partial.slice(i + 1); } };
      p.stdout.on("data", feed); p.stderr.on("data", feed);
      p.on("error", (e) => { clearTimeout(timer); this.line(e.code === "ENOENT" ? `Este sistema não tem o comando ${cmd}` : e.message); resolve(127); });
      p.on("close", (code) => { clearTimeout(timer); if (partial) this.line(partial); resolve(code == null ? 1 : code); });
    });
  }
  // em segundo plano: quem pediu recebe a resposta na hora e acompanha pelos eventos
  run(kind, steps) {
    this.begin(kind);
    (async () => {
      let code = 0;
      try { code = await steps(); } catch (e) { this.line(e.message); code = 1; }
      this.end(code);
    })();
    return this.view();
  }
}

// ---------------------------------------------------------------- atualizações do sistema
const parseUpgradable = (o) => o.split("\n").map((l) => /^([^/\s]+)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from: ([^\]]+)\]/.exec(l)).filter(Boolean)
  .map((m) => ({ name: m[1], origin: m[2], version: m[3], from: m[4], security: /security/.test(m[2]) }));
const upgradable = async () => parseUpgradable(await run("apt", ["list", "--upgradable"], { ok: true, timeout: 60000 }));
const APT_UPGRADE = ["-y", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold"];

// ---------------------------------------------------------------- serviços
const UNIT = /^[\w@.:-]+\.service$/;
const PROTECTED = new Set(["piphin-agent.service"]);
async function services() {
  const [units, files] = await Promise.all([
    run("systemctl", ["list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager"]),
    run("systemctl", ["list-unit-files", "--type=service", "--no-legend", "--plain", "--no-pager"], { ok: true }),
  ]);
  const enabled = {};
  for (const l of files.split("\n")) { const p = l.trim().split(/\s+/); if (p[0]) enabled[p[0]] = p[1]; }
  const out = [];
  for (const l of units.split("\n")) {
    const m = /^\s*\S*?\s*([\w@.:-]+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(l);
    if (!m || m[2] === "not-found") continue;
    out.push({ name: m[1], load: m[2], active: m[3], sub: m[4], description: m[5], enabled: enabled[m[1]] || "", protected: PROTECTED.has(m[1]) });
  }
  return out;
}
async function serviceAction(name, action) {
  if (!UNIT.test(name || "")) throw bad("Serviço inválido");
  if (!["start", "stop", "restart", "enable", "disable"].includes(action)) throw bad("Ação inválida");
  if (PROTECTED.has(name) && action !== "restart" && action !== "start") throw bad("Parar o agente deixaria o Hub sem acesso a esta máquina");
  // reiniciar o próprio agente derruba este pedido: responde antes
  if (PROTECTED.has(name)) { setTimeout(() => run("systemctl", [action, name], { ok: true }).catch(() => {}), 300); return true; }
  await run("systemctl", [action, name], { timeout: 90000 });
  return true;
}

// ---------------------------------------------------------------- logs
async function logs({ unit, lines, priority, kernel, grep }) {
  const args = ["--no-pager", "-o", "short-iso", "-n", String(Math.min(2000, Math.max(10, Number(lines) || 300)))];
  if (unit) { if (!UNIT.test(unit)) throw bad("Serviço inválido"); args.push("-u", unit); }
  if (kernel) args.push("-k");
  if (priority != null && /^[0-7]$/.test(String(priority))) args.push("-p", String(priority));
  if (grep) args.push("--grep", String(grep).slice(0, 200), "--case-sensitive=no");
  return (await run("journalctl", args, { ok: true, timeout: 30000 })).split("\n").filter(Boolean);
}

// ---------------------------------------------------------------- rede e firewall
function interfaces() {
  const out = [], base = path.join(SYS, "class", "net"), addrs = os.networkInterfaces();
  for (const name of list(base)) {
    if (/^(lo|veth|br-|docker)/.test(name)) continue;
    const speed = Number(read(path.join(base, name, "speed")));
    out.push({ name, mac: read(path.join(base, name, "address")).trim(), state: read(path.join(base, name, "operstate")).trim(), speed: speed > 0 ? speed : null, wireless: fs.existsSync(path.join(base, name, "wireless")),
      ips: (addrs[name] || []).filter((a) => !a.internal).map((a) => a.address) });
  }
  return out;
}
const macOf = () => { const up = interfaces().filter((i) => i.mac && i.ips.length && !i.wireless); return up[0] ? up[0].mac : null; };
async function listening() {
  const o = await run("ss", ["-H", "-tuln", "-p"], { ok: true });
  const out = [];
  for (const l of o.split("\n")) {
    const p = l.trim().split(/\s+/); if (p.length < 5) continue;
    const at = p[4].lastIndexOf(":"); const port = Number(p[4].slice(at + 1)); if (!port) continue;
    out.push({ proto: p[0], address: p[4].slice(0, at), port, program: (/users:\(\("([^"]+)"/.exec(l) || [])[1] || "" });
  }
  const seen = new Set();
  return out.filter((x) => { const k = `${x.proto}/${x.port}/${x.program}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.port - b.port);
}
const parseUfw = (o) => ({
  active: /^Status: active/m.test(o),
  rules: o.split("\n").map((l) => /^\[\s*(\d+)\]\s+(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)\s*(IN|OUT|FWD)?\s+(.+?)\s*$/.exec(l)).filter(Boolean).map((m) => ({ n: Number(m[1]), to: m[2].trim(), action: m[3], dir: m[4] || "IN", from: m[5] })),
});
const AGENT_RULES = ["8443/tcp", "8444/udp", "22/tcp"]; // sem estas o Hub e o SSH ficam de fora
async function firewall() {
  if (!(await has("ufw"))) return { installed: false, active: false, rules: [] };
  return { installed: true, ...parseUfw(await run("ufw", ["status", "numbered"], { ok: true })) };
}
async function firewallAction(b, agentPort = 8443) {
  const act = b.action;
  if (act === "enable") {
    for (const r of AGENT_RULES.map((x) => (x === "8443/tcp" ? `${agentPort}/tcp` : x))) await run("ufw", ["allow", r]);
    await run("ufw", ["--force", "enable"]);
  } else if (act === "disable") await run("ufw", ["disable"]);
  else if (act === "add") {
    const port = Number(b.port), proto = b.proto;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad(`Porta inválida: ${b.port}`);
    if (!["tcp", "udp", "both"].includes(proto) || !["allow", "deny"].includes(b.rule)) throw bad("Regra inválida");
    if (b.rule === "deny" && port === agentPort) throw bad("Bloquear essa porta deixaria o Hub sem acesso a esta máquina");
    await run("ufw", [b.rule, proto === "both" ? String(port) : `${port}/${proto}`]);
  } else if (act === "delete") {
    const fw = parseUfw(await run("ufw", ["status", "numbered"])), r = fw.rules.find((x) => x.n === Number(b.n));
    if (!r) throw bad("Regra não encontrada", 404);
    if (r.action === "ALLOW" && new RegExp(`^${agentPort}(/tcp)?\\b`).test(r.to)) throw bad("Tirar essa regra deixaria o Hub sem acesso a esta máquina");
    await run("ufw", ["--force", "delete", String(r.n)]);
  } else throw bad("Ação inválida");
  return firewall();
}

// ---------------------------------------------------------------- nome e fuso
async function overview() {
  const tz = (await run("timedatectl", ["show", "-p", "Timezone", "--value"], { ok: true }).catch(() => "")).trim();
  const ntp = (await run("timedatectl", ["show", "-p", "NTPSynchronized", "--value"], { ok: true }).catch(() => "")).trim();
  return { hostname: os.hostname(), timezone: tz, ntp: ntp === "yes", now: Date.now(), rebootRequired: fs.existsSync(REBOOT_FLAG), rebootPackages: read(`${REBOOT_FLAG}.pkgs`).split("\n").filter(Boolean), mac: macOf(), interfaces: interfaces() };
}
const timezones = async () => (await run("timedatectl", ["list-timezones"], { ok: true })).split("\n").filter(Boolean);
async function setTimezone(tz) { if (!/^[A-Za-z0-9_+\-/]{1,60}$/.test(tz || "")) throw bad("Fuso horário inválido"); await run("timedatectl", ["set-timezone", tz]); return true; }
async function setHostname(name) { if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(name || "")) throw bad("Nome inválido: use só letras, números e hífen"); await run("hostnamectl", ["set-hostname", name]); return true; }

// ---------------------------------------------------------------- atualizar o agente: fora do serviço, para sobreviver quando o serviço reiniciar
async function updateAgent(dataDir) {
  const logFile = path.join(dataDir, "agent-update.log");
  fs.writeFileSync(logFile, "");
  const script = `curl -fsSL ${INSTALL_URL} -o /tmp/piphin-install.sh && PIPHIN_UPDATE=1 bash /tmp/piphin-install.sh; rm -f /tmp/piphin-install.sh`;
  await run("systemd-run", ["--unit=piphin-agent-update", "--collect", `--property=StandardOutput=append:${logFile}`, `--property=StandardError=append:${logFile}`, "/bin/bash", "-c", script]);
  return true;
}
const agentUpdateLog = (dataDir) => read(path.join(dataDir, "agent-update.log")).split("\n").slice(-80).join("\n");

async function power(action) {
  if (!["reboot", "poweroff"].includes(action)) throw bad("Ação inválida");
  return run("systemctl", [action]);
}

module.exports = { Monitor, Jobs, processes, killProcess, smart, upgradable, parseUpgradable, APT_UPGRADE, services, serviceAction, logs, interfaces, listening, firewall, firewallAction, parseUfw, overview, timezones, setTimezone, setHostname, updateAgent, agentUpdateLog, power };
