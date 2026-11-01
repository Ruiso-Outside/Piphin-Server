// Piphin Agent · quem pode controlar esta máquina: o Hub pareia com um código de uso único e recebe um token.
// Só o hash do token fica salvo aqui.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O e 1/I
const sha = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

class Auth {
  constructor(dataDir) {
    this.file = path.join(dataDir, "auth.json");
    this.pairFile = path.join(dataDir, "pair.json");
    this.fails = new Map(); // ip -> { n, until }
  }
  load() { try { return JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { return { clients: [] }; } }
  save(d) { fs.writeFileSync(this.file + ".tmp", JSON.stringify(d, null, 1), { mode: 0o600 }); fs.renameSync(this.file + ".tmp", this.file); }
  clients() { return this.load().clients.map(({ id, name, createdAt, lastUsed, lastIp }) => ({ id, name, createdAt, lastUsed, lastIp })); }

  // código novo (vale 30 minutos e uma vez só)
  newCode() {
    let c = ""; const b = crypto.randomBytes(8);
    for (let i = 0; i < 8; i++) c += ALPHABET[b[i] % ALPHABET.length];
    const code = c.slice(0, 4) + "-" + c.slice(4);
    fs.writeFileSync(this.pairFile, JSON.stringify({ code, expires: Date.now() + 30 * 60000 }), { mode: 0o600 });
    return code;
  }
  pending() { try { const p = JSON.parse(fs.readFileSync(this.pairFile, "utf8")); return p.expires > Date.now() ? p : null; } catch { return null; } }

  pair(code, clientName, ip) {
    const f = this.fails.get(ip);
    if (f && f.until > Date.now()) throw Object.assign(new Error("Muitas tentativas erradas. Espere 15 minutos."), { status: 429 });
    const p = this.pending();
    const norm = (x) => String(x || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const good = p && norm(code).length === 8 && crypto.timingSafeEqual(Buffer.from(norm(code)), Buffer.from(norm(p.code)));
    if (!good) {
      const n = (f && f.until <= Date.now() ? 0 : f ? f.n : 0) + 1;
      this.fails.set(ip, { n, until: n >= 5 ? Date.now() + 15 * 60000 : 0 });
      throw Object.assign(new Error(p ? "Código errado" : "Não há código de pareamento ativo. Rode: sudo piphin-agent pair"), { status: 403 });
    }
    this.fails.delete(ip);
    fs.rmSync(this.pairFile, { force: true });
    const token = crypto.randomBytes(32).toString("base64url"), id = crypto.randomBytes(4).toString("hex");
    const d = this.load();
    d.clients.push({ id, name: String(clientName || "Piphin Hub").slice(0, 60), hash: sha(token), createdAt: Date.now(), lastUsed: Date.now(), lastIp: ip });
    this.save(d);
    return { token, clientId: id };
  }
  check(header, ip) {
    const m = /^Bearer\s+(\S+)$/.exec(header || "");
    if (!m) return null;
    const h = sha(m[1]), d = this.load();
    const c = d.clients.find((x) => x.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(x.hash), Buffer.from(h)));
    if (!c) return null;
    if (Date.now() - (c.lastUsed || 0) > 60000) { c.lastUsed = Date.now(); c.lastIp = ip; this.save(d); }
    return c;
  }
  revoke(id) { const d = this.load(); const n = d.clients.length; d.clients = d.clients.filter((c) => c.id !== id); this.save(d); return d.clients.length < n; }
}
module.exports = Auth;
