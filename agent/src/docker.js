// Piphin Agent · cliente da API do Docker Engine (sem dependências): pelo socket /var/run/docker.sock ou, nos testes,
// por um endereço http (PIPHIN_DOCKER=http://127.0.0.1:2375).
"use strict";
const http = require("http");

const API = "/v1.41";
function target() {
  const env = process.env.PIPHIN_DOCKER;
  if (env && /^https?:\/\//.test(env)) { const u = new URL(env); return { host: u.hostname, port: Number(u.port) || 80 }; }
  return { socketPath: env || "/var/run/docker.sock" };
}

// pedido simples: devolve { status, body (JSON se der) }
function request(method, path, body, { timeout = 60000, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request({ ...target(), method, path: API + path, timeout,
      headers: { ...(data ? { "Content-Type": "application/json", "Content-Length": data.length } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (raw) return resolve({ status: res.statusCode, body: buf });
        let parsed = buf.toString("utf8");
        try { parsed = parsed ? JSON.parse(parsed) : null; } catch { /* texto */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("timeout", () => req.destroy(new Error("O Docker não respondeu")));
    req.on("error", (e) => reject(e.code === "ENOENT" || e.code === "ECONNREFUSED" ? new Error("O Docker não está rodando nesta máquina") : e));
    if (data) req.write(data);
    req.end();
  });
}
async function ok(method, path, body, opts) {
  const r = await request(method, path, body, opts);
  if (r.status >= 400) throw new Error((r.body && r.body.message) || `Docker: erro ${r.status}`);
  return r.body;
}

// resposta em fluxo (eventos, progresso do download de imagens): uma chamada de onLine por objeto JSON
function stream(method, path, onLine, { body = null } = {}) {
  let req;
  const done = new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    req = http.request({ ...target(), method, path: API + path, headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} }, (res) => {
      if (res.statusCode >= 400) {
        const chunks = []; res.on("data", (c) => chunks.push(c));
        res.on("end", () => { let m = Buffer.concat(chunks).toString(); try { m = JSON.parse(m).message; } catch {} reject(new Error(m || `Docker: erro ${res.statusCode}`)); });
        return;
      }
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        buf += d;
        for (let i; (i = buf.indexOf("\n")) >= 0; ) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { try { onLine(JSON.parse(line)); } catch { onLine({ raw: line }); } } }
      });
      res.on("end", () => { if (buf.trim()) { try { onLine(JSON.parse(buf)); } catch {} } resolve(); });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
  return { done, abort: () => req && req.destroy() };
}

// saída do contêiner sem TTY vem em quadros: [tipo, 0, 0, 0, tamanho (4 bytes)] + dados
function demuxer(onData) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const type = buf[0], len = buf.readUInt32BE(4);
      if (type > 2 || buf[1] || buf[2] || buf[3]) { onData(buf.toString("utf8"), 1); buf = Buffer.alloc(0); return; } // não é multiplexado
      if (buf.length < 8 + len) return;
      onData(buf.subarray(8, 8 + len).toString("utf8"), type);
      buf = buf.subarray(8 + len);
    }
  };
}

// liga o console do contêiner: devolve { write(texto), close() }; a saída chega em onData(texto)
function attach(id, onData, onEnd) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...target(), method: "POST", path: `${API}/containers/${id}/attach?stream=1&stdin=1&stdout=1&stderr=1&logs=0`,
      headers: { Connection: "Upgrade", Upgrade: "tcp", "Content-Type": "application/vnd.docker.raw-stream" } });
    req.on("upgrade", (res, socket) => {
      const feed = demuxer(onData);
      socket.on("data", feed);
      socket.on("close", () => onEnd && onEnd());
      socket.on("error", () => {});
      resolve({ write: (t) => socket.write(t), close: () => socket.destroy() });
    });
    req.on("response", (res) => reject(new Error(`Docker: não deu para ligar o console (${res.statusCode})`)));
    req.on("error", reject);
    req.end();
  });
}

const docker = {
  version: () => ok("GET", "/version"),
  info: () => ok("GET", "/info"),
  df: () => ok("GET", "/system/df", null, { timeout: 120000 }),
  // imagens sem contêiner nenhum, e contêineres parados que não são de um servidor do Piphin
  prune: (what) => (what === "images"
    ? ok("POST", `/images/prune?filters=${encodeURIComponent(JSON.stringify({ dangling: ["false"] }))}`, null, { timeout: 600000 })
    : ok("POST", `/containers/prune?filters=${encodeURIComponent(JSON.stringify({ "label!": ["piphin.server"] }))}`, null, { timeout: 600000 })),
  imageExists: async (image) => (await request("GET", `/images/${encodeURIComponent(image)}/json`)).status === 200,
  async pull(image, onProgress) {
    // "eclipse-temurin:21-jre" -> nome + tag; "registro:5000/imagem" não tem tag (o ":" é da porta)
    const i = image.lastIndexOf(":"), tagged = i > 0 && !image.slice(i).includes("/");
    const name = tagged ? image.slice(0, i) : image, tag = tagged ? image.slice(i + 1) : "latest";
    let err = null;
    await stream("POST", `/images/create?fromImage=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}`, (o) => { if (o.error) err = o.error; else if (onProgress) onProgress(o); }).done;
    if (err) throw new Error(err);
  },
  create: (name, body) => ok("POST", `/containers/create?name=${encodeURIComponent(name)}`, body),
  inspect: async (id) => { const r = await request("GET", `/containers/${encodeURIComponent(id)}/json`); return r.status === 200 ? r.body : null; },
  start: async (id) => { const r = await request("POST", `/containers/${id}/start`); if (r.status >= 400 && r.status !== 304) throw new Error((r.body && r.body.message) || "Docker: não iniciou"); },
  stop: async (id, t = 30) => { const r = await request("POST", `/containers/${id}/stop?t=${t}`, null, { timeout: (t + 15) * 1000 }); if (r.status >= 400 && r.status !== 304 && r.status !== 404) throw new Error((r.body && r.body.message) || "Docker: não parou"); },
  kill: async (id, signal) => { const r = await request("POST", `/containers/${id}/kill${signal ? `?signal=${encodeURIComponent(signal)}` : ""}`); if (r.status >= 400 && r.status !== 409 && r.status !== 404) throw new Error((r.body && r.body.message) || "Docker: não parou"); },
  remove: async (id) => { const r = await request("DELETE", `/containers/${id}?force=1&v=1`); if (r.status >= 400 && r.status !== 404) throw new Error((r.body && r.body.message) || "Docker: não removeu"); },
  wait: (id) => ok("POST", `/containers/${id}/wait`, null, { timeout: 6 * 3600 * 1000 }),
  stats: (id) => ok("GET", `/containers/${id}/stats?stream=false`, null, { timeout: 15000 }),
  async logs(id, tail = 300) {
    const r = await request("GET", `/containers/${id}/logs?stdout=1&stderr=1&tail=${tail}`, null, { raw: true });
    if (r.status >= 400) return "";
    let out = ""; demuxer((t) => { out += t; })(r.body);
    return out;
  },
  list: (all = true) => ok("GET", `/containers/json?all=${all ? 1 : 0}&filters=${encodeURIComponent(JSON.stringify({ label: ["piphin.server"] }))}`),
  events: (onEvent) => stream("GET", `/events?filters=${encodeURIComponent(JSON.stringify({ type: ["container"], label: ["piphin.server"] }))}`, onEvent),
  attach, demuxer,
};
module.exports = docker;
