// Piphin Agent · "Meus jogos": jogos próprios (um build do jogo, como o pacote Linux da Unreal) guardados na máquina.
// Cada jogo tem um modelo que diz como rodar (o Unreal automático ou um egg) e as versões enviadas pelo Hub.
// Um servidor criado a partir do jogo recebe o pacote extraído na pasta do jogo; atualizar troca os arquivos e mantém os saves.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const KEEP_VERSIONS = 3; // versões guardadas por jogo (a mais nova e duas para voltar atrás)
const PACKAGE = /\.(tar\.gz|tgz|tar|zip)$/i;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

class Games {
  constructor(dataDir) {
    this.root = path.join(dataDir, "games");
    fs.mkdirSync(this.root, { recursive: true });
    this.map = new Map();
    for (const id of fs.readdirSync(this.root)) {
      try { this.map.set(id, JSON.parse(fs.readFileSync(path.join(this.root, id, "game.json"), "utf8"))); } catch { /* pasta quebrada */ }
    }
    // envios que não terminaram (o agente caiu no meio)
    for (const id of this.map.keys()) for (const f of fs.readdirSync(this.dir(id))) if (f.endsWith(".uploading")) fs.rmSync(path.join(this.dir(id), f), { force: true });
  }
  dir(id) { return path.join(this.root, id); }
  save(g) { fs.mkdirSync(this.dir(g.id), { recursive: true }); fs.writeFileSync(path.join(this.dir(g.id), "game.json.tmp"), JSON.stringify(g, null, 1)); fs.renameSync(path.join(this.dir(g.id), "game.json.tmp"), path.join(this.dir(g.id), "game.json")); }
  get(id) { const g = this.map.get(id); if (!g) throw bad("Jogo não encontrado", 404); return g; }
  list() { return [...this.map.values()].sort((a, b) => a.name.localeCompare(b.name)); }
  latest(id) { const g = this.get(id); return g.versions[0] || null; }
  file(id, vid) { const g = this.get(id), v = g.versions.find((x) => x.id === vid); if (!v) throw bad("Versão não encontrada", 404); return { ...v, path: path.join(this.dir(id), v.file) }; }
  create({ name, template }) {
    name = String(name || "").trim().slice(0, 60);
    if (!name) throw bad("Dê um nome ao jogo");
    if (!template) throw bad("Escolha como o jogo roda");
    const g = { id: crypto.randomBytes(4).toString("hex"), name, template: String(template), createdAt: Date.now(), versions: [] };
    this.map.set(g.id, g); this.save(g);
    return g;
  }
  update(id, { name, template }) {
    const g = this.get(id);
    if (name != null) g.name = String(name).trim().slice(0, 60) || g.name;
    if (template) g.template = String(template);
    this.save(g);
    return g;
  }
  remove(id, usedBy) {
    const g = this.get(id);
    if (usedBy.length) throw bad(`Este jogo está em uso por: ${usedBy.join(", ")}`, 409);
    fs.rmSync(this.dir(id), { recursive: true, force: true });
    this.map.delete(id);
    return g;
  }
  // recebe o pacote em fluxo (centenas de MB), confere o espaço livre e guarda o hash
  async upload(id, req, name) {
    const g = this.get(id);
    name = path.basename(String(name || "")).replace(/[^\w.\- ]/g, "_");
    if (!PACKAGE.test(name)) throw bad("Envie o pacote do jogo em .tar.gz, .tar ou .zip");
    const size = Number(req.headers["content-length"]) || 0;
    try { const s = fs.statfsSync(this.root); if (size && size > s.bavail * s.bsize - 512 * 1048576) throw bad("Falta espaço no disco da máquina para este pacote", 507); } catch (e) { if (e.status) throw e; }
    const vid = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + crypto.randomBytes(2).toString("hex");
    const file = `${vid}-${name}`, tmp = path.join(this.dir(id), file + ".uploading");
    const hash = crypto.createHash("sha256");
    let got = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      req.on("data", (c) => { got += c.length; hash.update(c); });
      req.pipe(out);
      out.on("finish", resolve); out.on("error", reject);
      req.on("error", reject); req.on("aborted", () => reject(bad("O envio foi interrompido")));
    }).catch((e) => { fs.rmSync(tmp, { force: true }); throw e; });
    if (size && got !== size) { fs.rmSync(tmp, { force: true }); throw bad("O envio foi interrompido"); }
    fs.renameSync(tmp, path.join(this.dir(id), file));
    const v = { id: vid, file, name, size: got, sha256: hash.digest("hex"), at: Date.now() };
    g.versions.unshift(v);
    for (const old of g.versions.slice(KEEP_VERSIONS)) fs.rmSync(path.join(this.dir(id), old.file), { force: true });
    g.versions = g.versions.slice(0, KEEP_VERSIONS);
    this.save(g);
    return v;
  }
}
module.exports = Games;
