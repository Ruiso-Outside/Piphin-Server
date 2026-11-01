// Docker de mentira para testar o Piphin Agent no Windows (sem Docker): imita a parte da API que o agente usa.
// Contêiner de instalação: escreve arquivos na pasta montada e termina. Contêiner de servidor: imprime "Done",
// responde aos comandos do console e para com "stop" (ou SIGTERM/kill).  uso: node fake-docker.js [porta]
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.argv[2] || 2375);
const images = new Set(["alpine:3.20"]);
const containers = new Map(); // id -> c
const events = new Set();
const frame = (type, text) => { const b = Buffer.from(text); const h = Buffer.alloc(8); h[0] = type; h.writeUInt32BE(b.length, 4); return Buffer.concat([h, b]); };
const find = (key) => containers.get(key) || [...containers.values()].find((c) => c.Name === "/" + key || c.Name === key) || [...containers.values()].find((c) => c.Id.startsWith(key));
const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(body == null ? "" : JSON.stringify(body)); };

function emit(c, action, extra = {}) {
  if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${new Date().toISOString().slice(17, 23)} EVENTO ${action} ${c.Name} ${JSON.stringify(extra)} ouvintes=${events.size}
`);
  const e = { Type: "container", Action: action, id: c.Id, Actor: { ID: c.Id, Attributes: { ...c.Config.Labels, name: c.Name.slice(1), ...extra } }, time: Math.floor(Date.now() / 1000) };
  for (const res of events) res.write(JSON.stringify(e) + "\n");
}
function out(c, text, type = 1) { c.logs.push(frame(type, text)); for (const s of c.sockets) s.write(frame(type, text)); }
function exit(c, code) {
  if (!c.State.Running) return;
  clearInterval(c.timer);
  c.State = { ...c.State, Running: false, ExitCode: code, FinishedAt: new Date().toISOString() };
  for (const w of c.waiters.splice(0)) w(code);
  emit(c, "die", { exitCode: String(code) });
}
function run(c) {
  const cmd = (c.Config.Cmd || []).join(" ");
  c.State = { Running: true, StartedAt: new Date().toISOString(), ExitCode: 0 };
  emit(c, "start");
  const bind = (c.HostConfig.Binds || [])[0];
  const host = bind ? bind.slice(0, bind.lastIndexOf(":")) : null;
  if (cmd.includes("/mnt/install/install.sh")) { // instalação de egg: confere o script e a pasta montados
    const bindScript = (c.HostConfig.Binds || []).find((b) => b.endsWith(":/mnt/install/install.sh:ro"));
    const scriptFile = bindScript ? bindScript.slice(0, bindScript.indexOf(":/mnt/install")) : "";
    out(c, `[fake] egg: ${cmd} · ${scriptFile && fs.existsSync(scriptFile) ? fs.readFileSync(scriptFile, "utf8").split("\n")[0] : "sem script"}\n`);
    setTimeout(() => { if (host) fs.writeFileSync(path.join(host, "server.jar"), "fake"); exit(c, 0); }, 300);
    return;
  }
  if (cmd.includes("/mnt/server")) { // instalação
    out(c, "[fake] instalando...\n");
    setTimeout(() => {
      if (host) { fs.writeFileSync(path.join(host, "server.jar"), "fake"); if (/mc_java/.test(cmd)) fs.writeFileSync(path.join(host, ".piphin-image"), "eclipse-temurin:21-jre\n"); fs.writeFileSync(path.join(host, "eula.txt"), "eula=true\n"); }
      out(c, "[fake] arquivos prontos\n");
      exit(c, /FALHAR/.test(cmd) ? 1 : 0);
    }, 400);
    return;
  }
  out(c, `[fake] iniciando: ${cmd.slice(0, 120)}\n`);
  const startupEnv = (c.Config.Env || []).find((e) => e.startsWith("STARTUP="));
  if (startupEnv) out(c, `[fake] ${startupEnv} cmd=${c.Config.Cmd ? "sim" : "nao"} usuario=${c.Config.User} portas=${Object.keys(c.Config.ExposedPorts || {}).sort().join(",")}\n`);
  setTimeout(() => out(c, "[Server] Done (1.234s)! For help, type \"help\"\n"), 800);
  let n = 0; c.timer = setInterval(() => out(c, `[Server] tick ${++n}\n`), 5000);
}
function stdin(c, text) {
  for (const line of text.split("\n").filter(Boolean)) {
    if (line.trim() === "stop") { out(c, "[Server] Stopping the server\n"); setTimeout(() => exit(c, 0), 300); }
    else if (line.trim() === "crash") { out(c, "[Server] crashing!\n", 2); setTimeout(() => exit(c, 1), 100); }
    else out(c, `[Server] comando recebido: ${line}\n`);
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://docker"), p = u.pathname.replace(/^\/v[\d.]+/, "");
  if (process.env.FAKE_LOG && !/\/(stats|json)$/.test(p)) fs.appendFileSync(process.env.FAKE_LOG, `${new Date().toISOString().slice(17, 23)} ${req.method} ${p}\n`);
  let m;
  if (p === "/version") return json(res, 200, { Version: "27.0.0-fake", ApiVersion: "1.47" });
  if (p === "/info") return json(res, 200, { Containers: containers.size });
  if ((m = /^\/images\/(.+)\/json$/.exec(p))) return images.has(decodeURIComponent(m[1])) ? json(res, 200, { Id: "img" }) : json(res, 404, { message: "No such image" });
  if (p === "/images/create" && req.method === "POST") {
    const img = `${u.searchParams.get("fromImage")}:${u.searchParams.get("tag")}`;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write(JSON.stringify({ status: "Pulling from " + img }) + "\n");
    setTimeout(() => { images.add(img); res.end(JSON.stringify({ status: "Downloaded newer image for " + img }) + "\n"); }, 300);
    return;
  }
  if (p === "/containers/create" && req.method === "POST") {
    let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
      const b = JSON.parse(body), name = u.searchParams.get("name");
      if (find(name)) return json(res, 409, { message: "Conflict. The container name is already in use" });
      if (!images.has(b.Image)) return json(res, 404, { message: "No such image: " + b.Image });
      const c = { Id: crypto.randomBytes(32).toString("hex"), Name: "/" + name, Config: { ...b, Labels: b.Labels || {} }, HostConfig: b.HostConfig || {}, State: { Running: false }, logs: [], sockets: new Set(), waiters: [] };
      containers.set(c.Id, c);
      json(res, 201, { Id: c.Id, Warnings: [] });
    });
    return;
  }
  if (p === "/containers/json") {
    return json(res, 200, [...containers.values()].map((c) => ({ Id: c.Id, Names: [c.Name], Labels: c.Config.Labels, State: c.State.Running ? "running" : "exited" })));
  }
  if (p === "/events") { res.writeHead(200, { "Content-Type": "application/json" }); events.add(res); req.on("close", () => events.delete(res)); return; }
  if ((m = /^\/containers\/([^/]+)(?:\/(\w+))?$/.exec(p))) {
    const c = find(decodeURIComponent(m[1])), act = m[2];
    if (!c) return json(res, 404, { message: "No such container" });
    if ((!act || act === "json") && req.method === "GET") return json(res, 200, { Id: c.Id, Name: c.Name, State: c.State, Config: c.Config, HostConfig: c.HostConfig });
    if (!act && req.method === "DELETE") { exit(c, 137); containers.delete(c.Id); return json(res, 204); }
    if (act === "start") { if (c.State.Running) return json(res, 304); run(c); return json(res, 204); }
    if (act === "stop") { if (!c.State.Running) return json(res, 304); out(c, "[fake] SIGTERM\n"); setTimeout(() => exit(c, 0), 200); return json(res, 204); }
    if (act === "kill") { if (!c.State.Running) return json(res, 409, { message: "not running" }); const sig = u.searchParams.get("signal") || "SIGKILL"; out(c, `[fake] ${sig}\n`); setTimeout(() => exit(c, sig === "SIGKILL" ? 137 : 0), 100); return json(res, 204); }
    if (act === "wait") { if (!c.State.Running && c.State.FinishedAt) return json(res, 200, { StatusCode: c.State.ExitCode }); c.waiters.push((code) => json(res, 200, { StatusCode: code })); return; }
    if (act === "logs") { res.writeHead(200, { "Content-Type": "application/vnd.docker.raw-stream" }); res.end(Buffer.concat(c.logs.slice(-Number(u.searchParams.get("tail") || 100)))); return; }
    if (act === "stats") return json(res, 200, { cpu_stats: { cpu_usage: { total_usage: 2e9 + Math.random() * 1e8 }, system_cpu_usage: 1e11, online_cpus: 8 }, precpu_stats: { cpu_usage: { total_usage: 2e9 }, system_cpu_usage: 1e11 - 1e9 },
      memory_stats: { usage: 512 * 1048576 + Math.random() * 1e7, limit: 4096 * 1048576, stats: { inactive_file: 0 } }, networks: { eth0: { rx_bytes: 123456, tx_bytes: 65432 } } });
  }
  json(res, 404, { message: "page not found: " + p });
});
// console: POST /containers/<id>/attach com Upgrade
server.on("upgrade", (req, socket) => {
  const u = new URL(req.url, "http://docker"), m = /^\/containers\/([^/]+)\/attach$/.exec(u.pathname.replace(/^\/v[\d.]+/, ""));
  const c = m && find(decodeURIComponent(m[1]));
  if (!c) { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
  socket.write("HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
  c.sockets.add(socket);
  socket.on("data", (d) => stdin(c, String(d)));
  socket.on("close", () => c.sockets.delete(socket));
  socket.on("error", () => {});
});
server.listen(PORT, "127.0.0.1", () => console.log("fake docker em http://127.0.0.1:" + PORT));
