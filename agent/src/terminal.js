// Piphin Agent · terminal da máquina dentro do Hub: um bash de verdade num pseudo-terminal, pelo comando "script"
// (vem no Ubuntu e dispensa módulos nativos). A sessão continua viva por 10 minutos se o Hub desconectar.
"use strict";
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const KEEP_DETACHED = 10 * 60000, MAX_REPLAY = 256 * 1024, MAX_SESSIONS = 8;
const FAKE_SHELL = process.env.PIPHIN_FAKE_SHELL; // só nos testes
const size = (v, d, max) => { const n = Math.floor(Number(v)); return n >= 2 && n <= max ? n : d; };

class Terminals {
  constructor(log) { this.log = log; this.map = new Map(); }
  list() { return [...this.map.values()].map((t) => ({ id: t.id, startedAt: t.startedAt, attached: !!t.socket, title: t.title })); }
  open({ cols, rows, who }) {
    if (this.map.size >= MAX_SESSIONS) throw Object.assign(new Error("Terminais demais abertos nesta máquina: feche algum"), { status: 409 });
    const c = size(cols, 120, 500), r = size(rows, 30, 200), id = crypto.randomBytes(6).toString("hex");
    const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", HOME: process.env.HOME || "/root", LANG: process.env.LANG || "C.UTF-8" };
    delete env.PIPHIN_CONFIG;
    let p;
    if (FAKE_SHELL) p = spawn(process.execPath, [FAKE_SHELL, String(c), String(r)], { env, stdio: ["pipe", "pipe", "pipe"] });
    else p = spawn("script", ["-qfc", `stty rows ${r} cols ${c}; cd ~; exec bash -l`, "/dev/null"], { env, cwd: "/", stdio: ["pipe", "pipe", "pipe"] });
    const t = { id, proc: p, socket: null, buf: [], bufSize: 0, startedAt: Date.now(), title: "bash", timer: null, exited: false, cols: c, rows: r };
    this.map.set(id, t);
    const feed = (d) => {
      t.buf.push(d); t.bufSize += d.length;
      while (t.bufSize > MAX_REPLAY && t.buf.length > 1) t.bufSize -= t.buf.shift().length;
      if (t.socket) t.socket.write(d);
    };
    p.stdout.on("data", feed); p.stderr.on("data", feed);
    p.on("error", (e) => feed(Buffer.from(`\r\nNão deu para abrir o terminal: ${e.message}\r\n`)));
    p.on("close", () => { t.exited = true; clearTimeout(t.timer); this.map.delete(id); if (t.socket) t.socket.end(); this.log("terminal fechado:", id); });
    p.stdin.on("error", () => {});
    this.log("terminal aberto:", id, who || "");
    this.detachLater(t);
    return { id, cols: c, rows: r };
  }
  detachLater(t) { clearTimeout(t.timer); t.timer = setTimeout(() => this.close(t.id), KEEP_DETACHED); t.timer.unref(); }
  attach(id, socket) {
    const t = this.map.get(id); if (!t) return false;
    if (t.socket) { try { t.socket.destroy(); } catch {} }
    t.socket = socket; clearTimeout(t.timer);
    for (const b of t.buf) socket.write(b); // o que apareceu enquanto estava fora
    socket.on("data", (d) => { if (t.socket === socket && !t.exited) t.proc.stdin.write(d); });
    const gone = () => { if (t.socket === socket) { t.socket = null; if (!t.exited) this.detachLater(t); } };
    socket.on("close", gone); socket.on("error", gone);
    return true;
  }
  // o tamanho fica no pseudo-terminal do bash: mudar avisa os programas (vim, top...) sozinho
  resize(id, cols, rows) {
    const t = this.map.get(id); if (!t) return false;
    const c = size(cols, t.cols, 500), r = size(rows, t.rows, 200);
    if (c === t.cols && r === t.rows) return true;
    t.cols = c; t.rows = r;
    if (FAKE_SHELL) { try { t.proc.stdin.write(`\u0001resize ${c} ${r}\n`); } catch {} return true; }
    try {
      const kids = fs.readFileSync(`/proc/${t.proc.pid}/task/${t.proc.pid}/children`, "utf8").trim().split(/\s+/);
      const pts = fs.readlinkSync(`/proc/${kids[0]}/fd/0`);
      if (/^\/dev\/pts\/\d+$/.test(pts)) execFile("stty", ["-F", pts, "rows", String(r), "cols", String(c)], () => {});
    } catch (e) { this.log("terminal: tamanho", e.message); }
    return true;
  }
  close(id) {
    const t = this.map.get(id); if (!t) return false;
    try { t.proc.kill("SIGHUP"); } catch {}
    const proc = t.proc;
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 2000).unref();
    return true;
  }
  closeAll() { for (const id of this.map.keys()) this.close(id); }
}
module.exports = Terminals;
