// Piphin Server como módulo do Piphin Hub: o painel das máquinas com o Piphin Agent (Ubuntu Server).
// Cada máquina pareada fica salva com o endereço, a impressão digital do certificado (conferida em toda conexão)
// e o token. A tela fala só com este backend; ele fala com os agentes por HTTPS e recebe os eventos ao vivo.
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const dgram = require("dgram");
const crypto = require("crypto");

const INSTALL_CMD = "curl -fsSL https://github.com/Ruiso-Outside/Piphin-Server/releases/latest/download/install.sh | sudo bash";

exports.activate = (ctx) => {
  const FILE = path.join(ctx.dataDir, "nodes.json");
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
  let nodes = readJson(FILE, []);
  const save = () => { fs.mkdirSync(ctx.dataDir, { recursive: true }); fs.writeFileSync(FILE + ".tmp", JSON.stringify(nodes, null, 1), { mode: 0o600 }); fs.renameSync(FILE + ".tmp", FILE); };
  const node = (id) => { const n = nodes.find((x) => x.id === id); if (!n) throw new Error("Máquina não encontrada"); return n; };
  const pub = (n) => ({ id: n.id, name: n.name, host: n.host, port: n.port, addedAt: n.addedAt, online: !!(live.get(n.id) || {}).online, version: n.version || "", fingerprint: n.fingerprint.slice(0, 23) });

  // ---------------------------------------------------------------- HTTPS com a impressão digital conferida
  function call(n, method, p, body, { raw = null, timeout = 30000, fingerprint = null, auth = true, onResponse = null } = {}) {
    return new Promise((resolve, reject) => {
      const data = body == null || raw ? null : Buffer.from(JSON.stringify(body));
      const fp = fingerprint || n.fingerprint;
      const req = https.request({ host: n.host, port: n.port, method, path: p, timeout, rejectUnauthorized: false,
        checkServerIdentity: (h, cert) => (fp === "*" || cert.fingerprint256 === fp ? undefined : new Error("A identidade da máquina mudou (certificado diferente). Por segurança, remova e pareie de novo.")),
        headers: { ...(auth && n.token ? { Authorization: "Bearer " + n.token } : {}), ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}), ...(raw ? raw.headers || {} : {}) } }, (res) => {
        if (onResponse) return onResponse(res, resolve, reject);
        const cert = res.socket && res.socket.getPeerCertificate ? res.socket.getPeerCertificate() : null;
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let b = Buffer.concat(chunks).toString("utf8");
          try { b = b ? JSON.parse(b) : null; } catch { /* texto */ }
          if (res.statusCode >= 400) return reject(new Error((b && b.error) || `Erro ${res.statusCode}`));
          resolve({ body: b, cert });
        });
      });
      req.on("timeout", () => req.destroy(new Error("A máquina não respondeu")));
      req.on("error", (e) => reject(/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT/.test(e.code || "") ? new Error("Não deu para falar com a máquina: confira se ela está ligada e na mesma rede") : e));
      if (raw && raw.stream) raw.stream.pipe(req);
      else { if (data) req.write(data); req.end(); }
    });
  }
  const api = async (id, method, p, body, opts) => (await call(node(id), method, p, body, opts)).body;
  const sid = (x) => encodeURIComponent(String(x || ""));

  // ---------------------------------------------------------------- achar máquinas na rede
  function broadcasts() {
    const out = new Set(["255.255.255.255"]);
    for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const ip = a.address.split(".").map(Number), mask = a.netmask.split(".").map(Number);
      out.add(ip.map((v, i) => (v & mask[i]) | (~mask[i] & 255)).join("."));
    }
    return [...out];
  }
  ctx.handle("discover", () => new Promise((resolve) => {
    const found = new Map(), sock = dgram.createSocket("udp4");
    sock.on("message", (m, r) => { try { const j = JSON.parse(String(m)); if (j.agent === "piphin") found.set(`${r.address}:${j.port}`, { host: r.address, port: j.port, name: j.name, version: j.version, pairing: j.pairing, known: nodes.some((n) => n.host === r.address && n.port === j.port) }); } catch {} });
    sock.on("error", () => {});
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const msg = Buffer.from("PIPHIN-DISCOVER");
      for (const b of broadcasts()) sock.send(msg, 8444, b, () => {});
      setTimeout(() => { for (const b of broadcasts()) sock.send(msg, 8444, b, () => {}); }, 500);
    });
    setTimeout(() => { try { sock.close(); } catch {} resolve([...found.values()]); }, 1800);
  }));
  ctx.handle("install-command", () => INSTALL_CMD);

  // ---------------------------------------------------------------- parear
  ctx.handle("pair", async ({ host, port = 8443, code }) => {
    host = String(host || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const m = /^(.+):(\d+)$/.exec(host); if (m) { host = m[1]; port = Number(m[2]); }
    if (!host) throw new Error("Informe o endereço da máquina");
    const tmp = { host, port: Number(port) || 8443 };
    // primeiro contato: pega o certificado (confiança no primeiro uso, confirmada pelo código de uso único)
    const hello = await call(tmp, "GET", "/api/hello", null, { fingerprint: "*", auth: false, timeout: 8000 });
    if (!hello.body || hello.body.agent !== "piphin") throw new Error("Nesse endereço não tem um Piphin Agent");
    const fp = hello.cert && hello.cert.fingerprint256;
    if (!fp || fp !== hello.body.fingerprint) throw new Error("O certificado da máquina não confere");
    const r = (await call(tmp, "POST", "/api/pair", { code: String(code || "").trim(), client: `Piphin Hub (${os.hostname()})` }, { fingerprint: fp, auth: false })).body;
    const existing = nodes.find((n) => n.host === tmp.host && n.port === tmp.port);
    const n = { id: existing ? existing.id : crypto.randomBytes(4).toString("hex"), name: r.name, host: tmp.host, port: tmp.port, fingerprint: fp, token: r.token, clientId: r.clientId, version: r.version, addedAt: Date.now() };
    nodes = nodes.filter((x) => x !== existing).concat(n);
    save();
    connect(n);
    return pub(n);
  });
  ctx.handle("node-remove", async (id) => {
    const n = node(id);
    try { await call(n, "DELETE", `/api/clients/${sid(n.clientId)}`, null, { timeout: 5000 }); } catch { /* máquina fora do ar: só esquece aqui */ }
    disconnect(id);
    nodes = nodes.filter((x) => x !== n); save();
    return true;
  });
  ctx.handle("node-rename", async ({ id, name }) => { const r = await api(id, "PATCH", "/api/node", { name }); node(id).name = r.name; save(); return pub(node(id)); });

  // ---------------------------------------------------------------- eventos ao vivo de cada máquina
  const live = new Map(); // id -> { req, online, retry }
  function connect(n) {
    disconnect(n.id);
    const st = { online: false, retry: null, req: null, stopped: false };
    live.set(n.id, st);
    const open = () => {
      if (st.stopped) return;
      st.req = https.request({ host: n.host, port: n.port, method: "GET", path: "/api/events", rejectUnauthorized: false,
        checkServerIdentity: (h, cert) => (cert.fingerprint256 === n.fingerprint ? undefined : new Error("certificado diferente")),
        headers: { Authorization: "Bearer " + n.token, Accept: "text/event-stream" } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return fail(res.statusCode === 401 ? "pareamento perdido" : `erro ${res.statusCode}`); }
        setOnline(true);
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          buf += d;
          for (let i; (i = buf.indexOf("\n\n")) >= 0; ) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const type = (/^event: (.+)$/m.exec(block) || [])[1], data = (/^data: (.+)$/m.exec(block) || [])[1];
            if (type && data) { try { ctx.emit("agent-event", { node: n.id, type, data: JSON.parse(data) }); } catch {} }
          }
        });
        res.on("end", () => fail("fim"));
        res.on("error", () => fail("erro"));
      });
      st.req.on("error", (e) => fail(e.message));
      st.req.end();
    };
    const setOnline = (v) => { if (st.online !== v) { st.online = v; ctx.emit("node-status", { id: n.id, online: v }); } };
    const fail = () => { setOnline(false); if (!st.stopped && !st.retry) st.retry = setTimeout(() => { st.retry = null; open(); }, 5000); };
    open();
  }
  function disconnect(id) { const st = live.get(id); if (!st) return; st.stopped = true; clearTimeout(st.retry); try { st.req && st.req.destroy(); } catch {} live.delete(id); }
  for (const n of nodes) connect(n);
  ctx.onStop(() => { for (const id of [...live.keys()]) disconnect(id); });

  // ---------------------------------------------------------------- canais da tela (repassados ao agente)
  ctx.handle("nodes", () => nodes.map(pub));
  ctx.handle("node-info", (id) => api(id, "GET", "/api/node"));
  ctx.handle("node-stats", (id) => api(id, "GET", "/api/node/stats", null, { timeout: 8000 }));
  ctx.handle("templates", (id) => api(id, "GET", "/api/templates"));
  ctx.handle("servers", (id) => api(id, "GET", "/api/servers"));
  ctx.handle("all-servers", async () => {
    const out = [];
    await Promise.all(nodes.map(async (n) => { try { for (const s of await api(n.id, "GET", "/api/servers", null, { timeout: 6000 })) out.push({ ...s, node: n.id, nodeName: n.name, host: n.host }); } catch {} }));
    return out;
  });
  ctx.handle("server-create", ({ node: id, spec }) => api(id, "POST", "/api/servers", spec, { timeout: 60000 }));
  ctx.handle("server-get", ({ node: id, server }) => api(id, "GET", `/api/servers/${sid(server)}`));
  ctx.handle("server-update", ({ node: id, server, patch }) => api(id, "PATCH", `/api/servers/${sid(server)}`, patch));
  ctx.handle("server-delete", ({ node: id, server }) => api(id, "DELETE", `/api/servers/${sid(server)}`, null, { timeout: 120000 }));
  ctx.handle("server-power", ({ node: id, server, action }) => api(id, "POST", `/api/servers/${sid(server)}/power`, { action }, { timeout: 120000 }));
  ctx.handle("server-command", ({ node: id, server, line }) => api(id, "POST", `/api/servers/${sid(server)}/command`, { line }));
  ctx.handle("server-reinstall", ({ node: id, server }) => api(id, "POST", `/api/servers/${sid(server)}/reinstall`, {}));
  ctx.handle("server-console", ({ node: id, server }) => api(id, "GET", `/api/servers/${sid(server)}/console?n=800`));
  ctx.handle("server-stats", ({ node: id, server }) => api(id, "GET", `/api/servers/${sid(server)}/stats`, null, { timeout: 20000 }));
  ctx.handle("cron-next", ({ node: id, expr }) => api(id, "GET", `/api/cron/next?expr=${encodeURIComponent(expr)}`));

  const q = (p) => `?path=${encodeURIComponent(p || "/")}`;
  ctx.handle("files", ({ node: id, server, path: p }) => api(id, "GET", `/api/servers/${sid(server)}/files${q(p)}`));
  ctx.handle("file-read", ({ node: id, server, path: p }) => api(id, "GET", `/api/servers/${sid(server)}/files/content${q(p)}`));
  ctx.handle("file-write", ({ node: id, server, path: p, content }) => api(id, "PUT", `/api/servers/${sid(server)}/files/content${q(p)}`, { content }));
  ctx.handle("file-mkdir", ({ node: id, server, path: p }) => api(id, "POST", `/api/servers/${sid(server)}/files/mkdir`, { path: p }));
  ctx.handle("file-rename", ({ node: id, server, from, to }) => api(id, "POST", `/api/servers/${sid(server)}/files/rename`, { from, to }));
  ctx.handle("file-delete", ({ node: id, server, paths }) => api(id, "POST", `/api/servers/${sid(server)}/files/delete`, { paths }));

  // enviar arquivos do PC para a pasta do servidor (com progresso)
  async function uploadFile(id, server, dir, file) {
    const size = fs.statSync(file).size, name = path.basename(file);
    let sent = 0, last = 0;
    const stream = fs.createReadStream(file);
    stream.on("data", (c) => { sent += c.length; if (Date.now() - last > 300) { last = Date.now(); ctx.emit("transfer", { name, done: sent, total: size }); } });
    const dest = path.posix.join(dir || "/", name);
    await call(node(id), "PUT", `/api/servers/${sid(server)}/files/upload${q(dest)}`, null, { timeout: 0, raw: { stream, headers: { "Content-Type": "application/octet-stream", "Content-Length": size } } });
    ctx.emit("transfer", { name, done: size, total: size, finished: true });
  }
  ctx.handle("file-upload", async ({ node: id, server, dir, files }) => {
    let list = files;
    if (!list || !list.length) list = await ctx.host.openDialog({ title: "Enviar arquivos para o servidor", properties: ["openFile", "multiSelections"] });
    if (!list || !list.length) return 0;
    for (const f of list) await uploadFile(id, server, dir, f);
    return list.length;
  });
  // arquivos arrastados para a tela chegam como bytes (a tela não vê o caminho no disco)
  ctx.handle("file-upload-bytes", async ({ node: id, server, dir, name, bytes }) => {
    const buf = Buffer.from(bytes);
    if (buf.length > 512 * 1024 * 1024) throw new Error("Arquivo grande demais para arrastar: use o botão Enviar");
    const { Readable } = require("stream");
    const dest = path.posix.join(dir || "/", path.posix.basename(String(name || "arquivo")));
    await call(node(id), "PUT", `/api/servers/${sid(server)}/files/upload${q(dest)}`, null, { timeout: 0, raw: { stream: Readable.from([buf]), headers: { "Content-Type": "application/octet-stream", "Content-Length": buf.length } } });
    return true;
  });
  // baixar um arquivo ou backup para o PC
  async function download(id, apiPath, suggested) {
    const dest = await ctx.host.saveDialog({ title: "Salvar no PC", defaultPath: path.join(os.homedir(), "Downloads", suggested) });
    if (!dest) return null;
    await call(node(id), "GET", apiPath, null, { timeout: 0, onResponse: (res, resolve, reject) => {
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`Erro ${res.statusCode}`)); }
      const total = Number(res.headers["content-length"]) || 0; let done = 0, last = 0;
      const out = fs.createWriteStream(dest);
      res.on("data", (c) => { done += c.length; if (Date.now() - last > 300) { last = Date.now(); ctx.emit("transfer", { name: path.basename(dest), done, total }); } });
      res.pipe(out);
      out.on("finish", () => { ctx.emit("transfer", { name: path.basename(dest), done: total || done, total: total || done, finished: true }); resolve(); });
      out.on("error", reject); res.on("error", reject);
    } });
    return dest;
  }
  ctx.handle("file-download", ({ node: id, server, path: p }) => download(id, `/api/servers/${sid(server)}/files/download${q(p)}`, path.posix.basename(p)));
  ctx.handle("show-item", (f) => ctx.host.showItem(f));

  ctx.handle("backups", ({ node: id, server }) => api(id, "GET", `/api/servers/${sid(server)}/backups`));
  ctx.handle("backup-create", ({ node: id, server, note }) => api(id, "POST", `/api/servers/${sid(server)}/backups`, { note }, { timeout: 6 * 3600 * 1000 }));
  ctx.handle("backup-restore", ({ node: id, server, backup }) => api(id, "POST", `/api/servers/${sid(server)}/backups/${sid(backup)}/restore`, {}, { timeout: 6 * 3600 * 1000 }));
  ctx.handle("backup-delete", ({ node: id, server, backup }) => api(id, "DELETE", `/api/servers/${sid(server)}/backups/${sid(backup)}`));
  ctx.handle("backup-download", ({ node: id, server, backup }) => download(id, `/api/servers/${sid(server)}/backups/${sid(backup)}/download`, `backup-${backup}.tar.gz`));

  // ---------------------------------------------------------------- ferramentas da IA (module.json "tools")
  const findServer = async (name) => {
    const all = [];
    for (const n of nodes) { try { for (const s of await api(n.id, "GET", "/api/servers", null, { timeout: 6000 })) all.push({ ...s, node: n.id, nodeName: n.name, host: n.host }); } catch {} }
    const k = String(name || "").toLowerCase().trim();
    const hit = all.find((s) => s.id === k) || all.find((s) => s.name.toLowerCase() === k) || all.filter((s) => s.name.toLowerCase().includes(k));
    if (Array.isArray(hit)) { if (hit.length === 1) return hit[0]; throw new Error(hit.length ? `Mais de um servidor com esse nome: ${hit.map((s) => s.name).join(", ")}` : "Servidor não encontrado"); }
    if (!hit) throw new Error("Servidor não encontrado");
    return hit;
  };
  ctx.handle("tool:servers_overview", async () => {
    const out = [];
    for (const n of nodes) {
      const st = live.get(n.id);
      let list = [], info = null;
      try { list = await api(n.id, "GET", "/api/servers", null, { timeout: 6000 }); info = await api(n.id, "GET", "/api/node/stats", null, { timeout: 6000 }); } catch {}
      out.push({ machine: n.name, address: n.host, online: !!(st && st.online), cpu_percent: info && info.cpu, memory_used_gb: info && +(info.memory.used / 1e9).toFixed(1), memory_total_gb: info && +(info.memory.total / 1e9).toFixed(1),
        servers: list.map((s) => ({ name: s.name, type: s.templateName, state: s.state, address: s.ports && s.ports[0] ? `${n.host}:${s.ports[0].host}` : null, memory_limit_mb: s.limits.memory || null })) });
    }
    return { machines: out };
  });
  ctx.handle("tool:server_logs", async ({ server, lines = 60 }) => {
    const s = await findServer(server);
    const log = await api(s.node, "GET", `/api/servers/${sid(s.id)}/console?n=${Math.min(300, Number(lines) || 60)}`);
    return { server: s.name, state: s.state, lines: log.map((l) => l.s) };
  });
  ctx.handle("tool:server_power", async ({ server, action }) => {
    if (!["start", "stop", "restart"].includes(action)) throw new Error("Ação inválida: use start, stop ou restart");
    const s = await findServer(server);
    const verb = { start: "ligar", stop: "desligar", restart: "reiniciar" }[action];
    if (await ctx.host.messageBox({ message: `A IA quer ${verb} o servidor "${s.name}"`, detail: `Na máquina ${s.nodeName}.`, buttons: [verb[0].toUpperCase() + verb.slice(1), "Cancelar"] }) !== 0) throw new Error("A pessoa não autorizou");
    const r = await api(s.node, "POST", `/api/servers/${sid(s.id)}/power`, { action }, { timeout: 120000 });
    return { server: s.name, state: r.state };
  });
  ctx.handle("tool:server_command", async ({ server, command }) => {
    const s = await findServer(server);
    if (await ctx.host.messageBox({ message: `A IA quer mandar um comando para "${s.name}"`, detail: String(command), buttons: ["Mandar", "Cancelar"] }) !== 0) throw new Error("A pessoa não autorizou");
    await api(s.node, "POST", `/api/servers/${sid(s.id)}/command`, { line: command });
    await new Promise((r) => setTimeout(r, 1500));
    const log = await api(s.node, "GET", `/api/servers/${sid(s.id)}/console?n=15`);
    return { server: s.name, sent: command, recent_output: log.map((l) => l.s) };
  });
};
