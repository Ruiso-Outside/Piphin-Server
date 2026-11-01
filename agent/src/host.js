// Piphin Agent · números da máquina: processador, memória, disco, rede e há quanto tempo está ligada
"use strict";
const fs = require("fs");
const os = require("os");

let prevCpu = null, prevNet = null;
const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };

function cpuPercent() {
  const line = read("/proc/stat").split("\n")[0];
  let idle, total;
  if (line.startsWith("cpu ")) {
    const v = line.trim().split(/\s+/).slice(1).map(Number);
    idle = v[3] + (v[4] || 0); total = v.reduce((a, b) => a + b, 0);
  } else { // fora do Linux (testes)
    const c = os.cpus(); idle = c.reduce((a, x) => a + x.times.idle, 0); total = c.reduce((a, x) => a + Object.values(x.times).reduce((p, q) => p + q, 0), 0);
  }
  const p = prevCpu; prevCpu = { idle, total };
  if (!p || total === p.total) return null;
  return Math.round((1 - (idle - p.idle) / (total - p.total)) * 1000) / 10;
}
function memory() {
  const m = read("/proc/meminfo");
  if (m) {
    const g = (k) => Number((new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(m) || [])[1] || 0) * 1024;
    return { total: g("MemTotal"), used: g("MemTotal") - g("MemAvailable"), swapTotal: g("SwapTotal"), swapUsed: g("SwapTotal") - g("SwapFree") };
  }
  return { total: os.totalmem(), used: os.totalmem() - os.freemem(), swapTotal: 0, swapUsed: 0 };
}
function disk(dir) {
  try { const s = fs.statfsSync(dir); return { total: s.blocks * s.bsize, free: s.bavail * s.bsize, used: (s.blocks - s.bfree) * s.bsize }; } catch { return null; }
}
function network() {
  const t = read("/proc/net/dev");
  if (!t) return null;
  let rx = 0, tx = 0;
  for (const line of t.split("\n").slice(2)) {
    const m = /^\s*([^:]+):\s*(.*)$/.exec(line); if (!m) continue;
    if (/^(lo|docker\d*|veth|br-)/.test(m[1])) continue;
    const v = m[2].trim().split(/\s+/).map(Number); rx += v[0]; tx += v[8];
  }
  const now = Date.now(), p = prevNet; prevNet = { rx, tx, now };
  if (!p) return { rx: 0, tx: 0 };
  const dt = (now - p.now) / 1000;
  return { rx: Math.max(0, (rx - p.rx) / dt), tx: Math.max(0, (tx - p.tx) / dt) };
}
function osName() {
  const r = read("/etc/os-release");
  const n = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(r);
  return n ? n[1] : `${os.type()} ${os.release()}`;
}
// IPs da máquina na rede (para o painel mostrar o endereço dos servidores)
function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|docker|veth|br-|virbr|tailscale|zt)/.test(name)) continue;
    for (const a of list || []) if (a.family === "IPv4" && !a.internal) out.push({ iface: name, ip: a.address });
  }
  return out;
}

function info(dataDir) {
  const c = os.cpus();
  return { hostname: os.hostname(), os: osName(), kernel: os.release(), arch: os.arch(), cpu: c[0] ? c[0].model.trim() : "", cores: c.length,
    memory: memory().total, disk: disk(dataDir), uptime: os.uptime(), addresses: addresses(), load: os.loadavg() };
}
function stats(dataDir) {
  return { at: Date.now(), cpu: cpuPercent(), memory: memory(), disk: disk(dataDir), net: network(), load: os.loadavg(), uptime: os.uptime() };
}
cpuPercent(); network();
module.exports = { info, stats, addresses };
