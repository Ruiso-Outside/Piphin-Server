// Piphin Agent · backups: um .tar.gz da pasta do servidor em servers/<id>/backups
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const KEEP_AUTO = 7; // backups automáticos (agendados) guardados por servidor
// no Windows (só nos testes) usa o tar do próprio Windows: o do Git acha que "C:" é um computador remoto
const TAR = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
const tar = (args, cwd) => new Promise((resolve, reject) => execFile(TAR, args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 6 * 3600 * 1000 },
  (err, out, errOut) => (err ? reject(new Error("tar: " + String(errOut || err.message).trim().slice(0, 300))) : resolve(out))));

class Backups {
  constructor(servers) { this.servers = servers; this.running = new Set(); }
  dir(id) { return path.join(this.servers.dir(id), "backups"); }
  index(id) { try { return JSON.parse(fs.readFileSync(path.join(this.dir(id), "index.json"), "utf8")); } catch { return []; } }
  saveIndex(id, list) { fs.mkdirSync(this.dir(id), { recursive: true }); fs.writeFileSync(path.join(this.dir(id), "index.json"), JSON.stringify(list, null, 1)); }
  list(id) { this.servers.get(id); return this.index(id).filter((b) => fs.existsSync(path.join(this.dir(id), b.file))); }

  async create(id, { note = "", auto = false } = {}) {
    this.servers.get(id);
    if (this.running.has(id)) throw new Error("Já tem um backup deste servidor em andamento");
    this.running.add(id);
    try {
      const bid = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + "-" + crypto.randomBytes(2).toString("hex");
      const file = `${bid}.tar.gz`, out = path.join(this.dir(id), file);
      fs.mkdirSync(this.dir(id), { recursive: true });
      this.servers.system(id, auto ? "Backup automático começou..." : "Backup começou...");
      const t0 = Date.now();
      await tar(["-czf", out, "-C", this.servers.dataDir(id), "."]);
      const size = fs.statSync(out).size;
      const item = { id: bid, file, size, at: Date.now(), note: String(note).slice(0, 100), auto, seconds: Math.round((Date.now() - t0) / 1000) };
      let list = [item, ...this.index(id)];
      // os automáticos mais antigos saem; os feitos à mão ficam
      const autos = list.filter((b) => b.auto);
      for (const old of autos.slice(KEEP_AUTO)) { fs.rmSync(path.join(this.dir(id), old.file), { force: true }); list = list.filter((b) => b !== old); }
      this.saveIndex(id, list);
      this.servers.system(id, `Backup pronto (${(size / 1048576).toFixed(1)} MB).`);
      return item;
    } catch (e) {
      this.servers.system(id, `O backup falhou: ${e.message}`);
      throw e;
    } finally { this.running.delete(id); }
  }
  // restaurar: o servidor precisa estar desligado; a pasta atual é trocada pelo conteúdo do backup
  async restore(id, bid) {
    const s = this.servers.get(id), b = this.index(id).find((x) => x.id === bid);
    if (!b) throw Object.assign(new Error("Backup não encontrado"), { status: 404 });
    const state = this.servers.r(id).state;
    if (state !== "offline") await this.servers.power(id, "stop");
    const data = this.servers.dataDir(id), tmp = data + ".restaurando";
    fs.rmSync(tmp, { recursive: true, force: true }); fs.mkdirSync(tmp, { recursive: true });
    this.servers.system(id, "Restaurando o backup...");
    await tar(["-xzf", path.join(this.dir(id), b.file), "-C", tmp]);
    fs.rmSync(data, { recursive: true, force: true });
    fs.renameSync(tmp, data);
    this.servers.system(id, "Backup restaurado.");
    void s;
    return true;
  }
  remove(id, bid) {
    const list = this.index(id), b = list.find((x) => x.id === bid);
    if (!b) throw Object.assign(new Error("Backup não encontrado"), { status: 404 });
    fs.rmSync(path.join(this.dir(id), b.file), { force: true });
    this.saveIndex(id, list.filter((x) => x !== b));
    return true;
  }
  file(id, bid) {
    const b = this.index(id).find((x) => x.id === bid);
    if (!b) throw Object.assign(new Error("Backup não encontrado"), { status: 404 });
    const f = path.join(this.dir(id), b.file);
    return { size: fs.statSync(f).size, name: `${id}-${b.file}`, stream: fs.createReadStream(f) };
  }
}
module.exports = Backups;
