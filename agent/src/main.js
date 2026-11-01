#!/usr/bin/env node
// Piphin Agent: roda no Ubuntu Server e deixa o Piphin Hub criar e controlar servidores (jogos, sites, bots, bancos)
// nesta máquina. API HTTPS com certificado próprio (o Hub guarda a impressão digital) e token por cliente pareado.
//   piphin-agent            inicia o serviço (o systemd chama assim)
//   piphin-agent pair       mostra um código novo para parear o Hub
//   piphin-agent status     mostra o endereço, a impressão digital e os servidores
//   piphin-agent clients    lista os Hubs pareados;  piphin-agent revoke <id>  tira o acesso de um
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const dgram = require("dgram");
const crypto = require("crypto");
const docker = require("./docker");
const templates = require("./templates");
const eggs = require("./eggs");
const Servers = require("./servers");
const Backups = require("./backups");
const schedules = require("./schedules");
const files = require("./files");
const host = require("./host");
const Auth = require("./auth");
const system = require("./system");
const Terminals = require("./terminal");

const VERSION = require("../package.json").version;
const CONFIG = process.env.PIPHIN_CONFIG || "/etc/piphin-agent/config.json";
const log = (...a) => console.log(new Date().toISOString(), ...a);

function loadConfig() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch (e) { if (process.argv[2] !== "version") { console.error(`Configuração não encontrada em ${CONFIG}. Rode o instalador.`); process.exit(1); } }
  return { name: require("os").hostname(), port: 8443, discoveryPort: 8444, dataDir: "/var/lib/piphin-agent", key: "/etc/piphin-agent/key.pem", cert: "/etc/piphin-agent/cert.pem", maxUpload: 4 * 1024 ** 3, ...c };
}
const fingerprintOf = (pem) => new crypto.X509Certificate(pem).fingerprint256;

// ---------------------------------------------------------------- linha de comando
const cmd = process.argv[2];
if (cmd === "version") { console.log(VERSION); process.exit(0); }
const cfg = loadConfig();
fs.mkdirSync(cfg.dataDir, { recursive: true });
const auth = new Auth(cfg.dataDir);
if (cmd && cmd !== "run") {
  const cert = fs.existsSync(cfg.cert) ? fs.readFileSync(cfg.cert, "utf8") : null;
  const ips = host.addresses().map((a) => a.ip);
  if (cmd === "pair") {
    const code = auth.newCode();
    console.log(`\n  Código para parear no Piphin Hub:  ${code}\n  (vale 30 minutos e uma vez só)\n`);
    console.log(`  Endereço desta máquina: ${ips.map((ip) => `${ip}:${cfg.port}`).join("  ") || "?"}`);
    if (cert) console.log(`  Impressão digital: ${fingerprintOf(cert).slice(0, 23)}...\n`);
  } else if (cmd === "status") {
    console.log(`Piphin Agent ${VERSION} · ${cfg.name}\nEndereço: ${ips.map((ip) => `${ip}:${cfg.port}`).join("  ")}`);
    if (cert) console.log(`Impressão digital: ${fingerprintOf(cert)}`);
    console.log(`Hubs pareados: ${auth.clients().length}`);
    const dir = path.join(cfg.dataDir, "servers");
    for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) { try { const s = JSON.parse(fs.readFileSync(path.join(dir, id, "server.json"), "utf8")); console.log(`  ${id}  ${s.name}  (${s.templateName})  portas ${(s.ports || []).map((p) => p.host).join(",")}`); } catch {} }
  } else if (cmd === "clients") {
    for (const c of auth.clients()) console.log(`${c.id}  ${c.name}  último acesso ${new Date(c.lastUsed).toLocaleString()} de ${c.lastIp || "?"}`);
  } else if (cmd === "revoke") {
    console.log(auth.revoke(process.argv[3]) ? "Acesso removido." : "Não encontrado.");
  } else console.log("Uso: piphin-agent [pair | status | clients | revoke <id> | version]");
  process.exit(0);
}

// ---------------------------------------------------------------- serviço
templates.setEggs(eggs.load(cfg));
const servers = new Servers(cfg, log);
const backups = new Backups(servers);
const certPem = fs.readFileSync(cfg.cert, "utf8");
const fingerprint = fingerprintOf(certPem);

// eventos para os Hubs conectados (Server-Sent Events)
const subscribers = new Set();
const broadcast = (type, data) => { const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of subscribers) res.write(msg); };
servers.on("line", (l) => broadcast("line", l));
servers.on("state", (s) => broadcast("state", s));
servers.on("changed", (c) => broadcast("changed", c));
const monitor = new system.Monitor(cfg.dataDir, docker);
const jobs = new system.Jobs((j) => broadcast("job", j));
const terminals = new Terminals(log);
monitor.start();

function send(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": data.length, "Cache-Control": "no-store" });
  res.end(data);
}
function readJson(req, max = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > max) { reject(Object.assign(new Error("Pedido grande demais"), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(Object.assign(new Error("JSON inválido"), { status: 400 })); } });
    req.on("error", reject);
  });
}
function sendFile(res, f) {
  res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": f.size, "Content-Disposition": `attachment; filename="${encodeURIComponent(f.name)}"` });
  f.stream.pipe(res);
}

// rotas: [método, padrão, precisa de token, função(req, res, params, query)]
const R = [];
const route = (m, p, needAuth, fn) => R.push([m, new RegExp("^" + p.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), needAuth, fn]);

route("GET", "/api/hello", false, () => ({ agent: "piphin", version: VERSION, name: cfg.name, fingerprint, paired: auth.clients().length > 0, pairing: !!auth.pending() }));
route("POST", "/api/pair", false, async (req) => {
  const b = await readJson(req);
  const r = auth.pair(b.code, b.client, req.socket.remoteAddress);
  log("pareado:", b.client, req.socket.remoteAddress);
  return { ...r, name: cfg.name, fingerprint, version: VERSION };
});
route("GET", "/api/node", true, async () => {
  let d = null; try { const v = await docker.version(); d = { ok: true, version: v.Version }; } catch (e) { d = { ok: false, error: e.message }; }
  return { name: cfg.name, version: VERSION, info: host.info(cfg.dataDir), docker: d, servers: servers.map.size, clients: auth.clients() };
});
route("PATCH", "/api/node", true, async (req) => {
  const b = await readJson(req);
  if (b.name) { cfg.name = String(b.name).trim().slice(0, 60) || cfg.name; const disk = JSON.parse(fs.readFileSync(CONFIG, "utf8")); disk.name = cfg.name; fs.writeFileSync(CONFIG, JSON.stringify(disk, null, 2)); }
  return { name: cfg.name };
});
route("GET", "/api/node/stats", true, () => host.stats(cfg.dataDir));
route("DELETE", "/api/clients/:cid", true, (req, res, p) => ({ ok: auth.revoke(p.cid) }));
route("GET", "/api/templates", true, () => templates.all().map(templates.pub));
// eggs do Pterodactyl importados pelo Hub: viram modelos desta máquina
route("POST", "/api/eggs", true, async (req) => {
  const b = await readJson(req, 3 * 1024 * 1024);
  const t = eggs.convert(b.egg, { slug: b.slug });
  eggs.save(cfg, t); templates.addEgg(t);
  log("egg importado:", t.id);
  return templates.pub(t);
});
route("DELETE", "/api/eggs/:eid", true, (req, res, p) => {
  const inUse = [...servers.map.values()].filter((s) => s.template === p.eid);
  if (inUse.length) throw Object.assign(new Error(`Este egg está em uso por: ${inUse.map((s) => s.name).join(", ")}`), { status: 409 });
  eggs.remove(cfg, p.eid); templates.dropEgg(p.eid);
  return { ok: true };
});
route("GET", "/api/cron/next", true, (req, res, p, q) => { try { return { next: schedules.next(q.get("expr")) }; } catch (e) { throw Object.assign(e, { status: 400 }); } });
route("GET", "/api/events", true, (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  res.write(`event: hello\ndata: ${JSON.stringify({ name: cfg.name })}\n\n`);
  subscribers.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => { clearInterval(ping); subscribers.delete(res); });
  return undefined; // resposta aberta
});

// ---------------------------------------------------------------- a máquina inteira
const sysRoute = (m, p, fn) => route(m, "/api/system" + p, true, fn);
sysRoute("GET", "/overview", () => system.overview());
sysRoute("GET", "/monitor", () => ({ ...monitor.latest, alerts: monitor.alerts() }));
sysRoute("GET", "/history", (req, res, p, q) => monitor.history(q.get("range")));
sysRoute("GET", "/processes", (req, res, p, q) => system.processes(Number(q.get("limit")) || 40));
sysRoute("POST", "/processes/:pid/kill", async (req, res, p) => { const b = await readJson(req); log("processo parado:", p.pid, b.signal); return { ok: system.killProcess(p.pid, b.signal) }; });
sysRoute("GET", "/smart", () => system.smart());
// atualizações do sistema
sysRoute("GET", "/updates", async () => ({ packages: await system.upgradable(), job: jobs.view() }));
sysRoute("POST", "/updates/check", () => jobs.run("apt-check", () => jobs.exec("apt-get", ["update"], 600000)));
sysRoute("POST", "/updates/install", async (req) => {
  const b = await readJson(req);
  log("atualizando o sistema", b.full ? "(completo)" : "");
  return jobs.run("apt-upgrade", () => jobs.exec("apt-get", [b.full ? "dist-upgrade" : "upgrade", ...system.APT_UPGRADE]));
});
sysRoute("GET", "/job", () => jobs.view());
// atualizar o agente
sysRoute("POST", "/agent-update", async () => { log("atualizando o agente"); return { ok: await system.updateAgent(cfg.dataDir) }; });
sysRoute("GET", "/agent-update", () => ({ log: system.agentUpdateLog(cfg.dataDir), version: VERSION }));
// reiniciar e desligar: antes para os servidores do jeito certo; os que estavam ligados voltam quando a máquina voltar
sysRoute("POST", "/power", async (req) => {
  const { action } = await readJson(req);
  if (!["reboot", "poweroff"].includes(action)) throw Object.assign(new Error("Ação inválida"), { status: 400 });
  log("energia:", action);
  return jobs.run("power", async () => {
    for (const s of servers.map.values()) {
      if (servers.r(s.id).state === "offline") continue;
      jobs.line(`${s.name}...`);
      await servers.stopContainer(s, false).catch((e) => jobs.line(e.message));
    }
    await system.power(action);
    return 0;
  });
});
// serviços, logs, rede, firewall
sysRoute("GET", "/services", () => system.services());
sysRoute("POST", "/services/:name/:action", async (req, res, p) => { log("serviço:", p.name, p.action); return { ok: await system.serviceAction(p.name, p.action) }; });
sysRoute("GET", "/logs", (req, res, p, q) => system.logs({ unit: q.get("unit"), lines: q.get("lines"), priority: q.get("priority"), kernel: q.get("kernel") === "1", grep: q.get("grep") }));
sysRoute("GET", "/network", async () => ({ interfaces: system.interfaces(), listening: await system.listening().catch(() => []), firewall: await system.firewall().catch(() => ({ installed: false, active: false, rules: [] })) }));
sysRoute("POST", "/firewall", async (req) => { const b = await readJson(req); log("firewall:", b.action, b.port || b.n || ""); return system.firewallAction(b, cfg.port); });
// nome, fuso e outros Hubs
sysRoute("GET", "/timezones", () => system.timezones());
sysRoute("POST", "/timezone", async (req) => ({ ok: await system.setTimezone((await readJson(req)).timezone) }));
sysRoute("POST", "/hostname", async (req) => ({ ok: await system.setHostname((await readJson(req)).hostname) }));
sysRoute("POST", "/pair-code", () => ({ code: auth.newCode() }));
// Docker
sysRoute("GET", "/docker", async () => {
  const [info, df] = await Promise.all([docker.info(), docker.df()]);
  const size = (l, k = "Size") => (l || []).reduce((a, x) => a + (x[k] || 0), 0);
  return { version: info.ServerVersion || "", storage: info.Driver || "", root: info.DockerRootDir || "", running: info.ContainersRunning || 0, stopped: info.ContainersStopped || 0,
    images: (df.Images || []).map((i) => ({ id: i.Id, tags: i.RepoTags || [], size: i.Size, containers: i.Containers, created: i.Created })).sort((a, b) => b.size - a.size),
    containers: (df.Containers || []).map((c) => ({ id: c.Id, name: (c.Names || [""])[0].replace(/^\//, ""), image: c.Image, state: c.State, status: c.Status, piphin: !!(c.Labels && (c.Labels["piphin.server"] || c.Labels["piphin.install"])) })),
    disk: { images: size(df.Images), layers: df.LayersSize || 0, containers: size(df.Containers, "SizeRw"), volumes: (df.Volumes || []).reduce((a, v) => a + ((v.UsageData && v.UsageData.Size) || 0), 0), cache: size(df.BuildCache) } };
});
sysRoute("POST", "/docker/prune", async (req) => {
  const { what } = await readJson(req);
  if (what !== "images" && what !== "containers") throw Object.assign(new Error("Ação inválida"), { status: 400 });
  log("docker: limpeza", what);
  // contêineres e imagens dos servidores do Piphin nunca entram: os parados ficam com a etiqueta deles e as imagens em uso são poupadas
  return docker.prune(what);
});
// terminal da máquina
const terminalOff = () => { if (cfg.terminal === false) throw Object.assign(new Error("O terminal está desligado na configuração desta máquina"), { status: 403 }); };
route("GET", "/api/terminals", true, () => { terminalOff(); return terminals.list(); });
route("POST", "/api/terminals", true, async (req) => { terminalOff(); const b = await readJson(req); return terminals.open({ cols: b.cols, rows: b.rows, who: req.socket.remoteAddress }); });
route("POST", "/api/terminals/:tid/resize", true, async (req, res, p) => { const b = await readJson(req); return { ok: terminals.resize(p.tid, b.cols, b.rows) }; });
route("DELETE", "/api/terminals/:tid", true, (req, res, p) => ({ ok: terminals.close(p.tid) }));

route("GET", "/api/servers", true, () => servers.list());
route("POST", "/api/servers", true, async (req) => servers.create(await readJson(req)));
route("GET", "/api/servers/:id", true, (req, res, p) => servers.view(servers.get(p.id)));
route("PATCH", "/api/servers/:id", true, async (req, res, p) => servers.update(p.id, await readJson(req)));
route("DELETE", "/api/servers/:id", true, (req, res, p) => servers.remove(p.id).then(() => ({ ok: true })));
route("POST", "/api/servers/:id/power", true, async (req, res, p) => servers.power(p.id, (await readJson(req)).action));
route("POST", "/api/servers/:id/command", true, async (req, res, p) => { servers.command(p.id, (await readJson(req)).line); return { ok: true }; });
route("POST", "/api/servers/:id/reinstall", true, (req, res, p) => { servers.install(p.id, { reinstall: true }).catch(() => {}); return { ok: true }; });
route("GET", "/api/servers/:id/console", true, (req, res, p, q) => { servers.get(p.id); return servers.history(p.id, Math.min(1500, Number(q.get("n")) || 500)); });
route("GET", "/api/servers/:id/stats", true, async (req, res, p) => {
  servers.get(p.id);
  // o uso de disco é medido de novo quando tem mais de 1 minuto (em segundo plano: pastas grandes demoram)
  const d = servers.r(p.id).disk;
  if (!d) await servers.diskUsage(p.id).catch(() => {}); else if (Date.now() - d.at > 60000) servers.diskUsage(p.id).catch(() => {});
  return { stats: await servers.stats(p.id), disk: servers.r(p.id).disk };
});

const root = (id) => { servers.get(id); return servers.dataDir(id); };
route("GET", "/api/servers/:id/files", true, (req, res, p, q) => files.list(root(p.id), q.get("path")));
route("GET", "/api/servers/:id/files/content", true, (req, res, p, q) => files.read(root(p.id), q.get("path")));
route("PUT", "/api/servers/:id/files/content", true, async (req, res, p, q) => ({ ok: await files.write(root(p.id), q.get("path"), (await readJson(req, 6 * 1024 * 1024)).content) }));
route("POST", "/api/servers/:id/files/mkdir", true, async (req, res, p) => ({ ok: await files.mkdir(root(p.id), (await readJson(req)).path) }));
route("POST", "/api/servers/:id/files/rename", true, async (req, res, p) => { const b = await readJson(req); return { ok: await files.rename(root(p.id), b.from, b.to) }; });
route("POST", "/api/servers/:id/files/delete", true, async (req, res, p) => ({ ok: await files.remove(root(p.id), (await readJson(req)).paths) }));
route("PUT", "/api/servers/:id/files/upload", true, (req, res, p, q) => files.upload(root(p.id), q.get("path"), req, cfg.maxUpload));
route("GET", "/api/servers/:id/files/download", true, async (req, res, p, q) => { sendFile(res, await files.stream(root(p.id), q.get("path"))); });

route("GET", "/api/servers/:id/backups", true, (req, res, p) => backups.list(p.id));
route("POST", "/api/servers/:id/backups", true, async (req, res, p) => backups.create(p.id, await readJson(req)));
route("POST", "/api/servers/:id/backups/:bid/restore", true, async (req, res, p) => ({ ok: await backups.restore(p.id, p.bid) }));
route("DELETE", "/api/servers/:id/backups/:bid", true, (req, res, p) => ({ ok: backups.remove(p.id, p.bid) }));
route("GET", "/api/servers/:id/backups/:bid/download", true, (req, res, p) => { sendFile(res, backups.file(p.id, p.bid)); });

const server = https.createServer({ key: fs.readFileSync(cfg.key), cert: certPem, minVersion: "TLSv1.2" }, async (req, res) => {
  const url = new URL(req.url, "https://agent");
  const ip = req.socket.remoteAddress;
  for (const [m, re, needAuth, fn] of R) {
    if (m !== req.method) continue;
    const match = re.exec(url.pathname); if (!match) continue;
    if (needAuth && !auth.check(req.headers.authorization, ip)) return send(res, 401, { error: "Acesso negado: pareie o Hub de novo" });
    try {
      const out = await fn(req, res, match.groups || {}, url.searchParams);
      if (out !== undefined && !res.headersSent) send(res, 200, out);
    } catch (e) {
      if (!e.status) log("erro", req.method, url.pathname, e.message);
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
      else res.destroy();
    }
    return;
  }
  send(res, 404, { error: "Não encontrado" });
});
// o terminal é um canal direto de bytes: GET /api/terminals/<id>/attach com "Upgrade: piphin-terminal"
server.on("upgrade", (req, socket) => {
  const m = /^\/api\/terminals\/([a-f0-9]+)\/attach$/.exec(new URL(req.url, "https://agent").pathname);
  const refuse = (code) => { socket.end(`HTTP/1.1 ${code} Refused\r\nConnection: close\r\n\r\n`); };
  if (!m || req.headers.upgrade !== "piphin-terminal") return refuse(404);
  if (!auth.check(req.headers.authorization, req.socket.remoteAddress) || cfg.terminal === false) return refuse(401);
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: piphin-terminal\r\nConnection: Upgrade\r\n\r\n");
  socket.setNoDelay(true);
  if (!terminals.attach(m[1], socket)) socket.end();
});
server.listen(cfg.port, cfg.bind || "0.0.0.0", () => log(`Piphin Agent ${VERSION} ouvindo em https://0.0.0.0:${cfg.port} · impressão digital ${fingerprint.slice(0, 23)}...`));

// ---------------------------------------------------------------- descoberta na rede (o Hub manda "PIPHIN-DISCOVER" por broadcast)
const udp = dgram.createSocket({ type: "udp4", reuseAddr: true });
udp.on("message", (msg, rinfo) => {
  if (String(msg).trim() !== "PIPHIN-DISCOVER") return;
  const reply = Buffer.from(JSON.stringify({ agent: "piphin", name: cfg.name, port: cfg.port, version: VERSION, fingerprint, pairing: !!auth.pending() }));
  udp.send(reply, rinfo.port, rinfo.address);
});
udp.on("error", (e) => log("descoberta:", e.message));
udp.bind(cfg.discoveryPort);

servers.boot().catch((e) => log("boot", e.message));
schedules.start(servers, backups, log);
const bye = () => { log("parando"); terminals.closeAll(); server.close(); udp.close(); process.exit(0); };
process.on("SIGTERM", bye); process.on("SIGINT", bye);
