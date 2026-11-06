// Piphin Agent · servidores: cada um é uma pasta (dataDir/servers/<id>) e um contêiner Docker "piphin-<id>".
// Instalar = rodar o script do modelo num contêiner temporário com a pasta montada em /mnt/server.
// Iniciar = recriar o contêiner com a configuração atual e ligar o console (stdin/stdout).
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const docker = require("./docker");
const templates = require("./templates");
const files = require("./files");
const eggs = require("./eggs");

const MAX_LINES = 1500;
const now = () => Date.now();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class Servers extends EventEmitter {
  constructor(cfg, log) {
    super();
    this.cfg = cfg; this.log = log;
    this.root = path.join(cfg.dataDir, "servers");
    fs.mkdirSync(this.root, { recursive: true });
    this.map = new Map();      // id -> config salva
    this.rt = new Map();       // id -> { state, lines[], con, stopping, crashes[], started }
    this.games = null;         // Meus jogos (main.js liga)
    this.updatingGame = new Set();
    for (const id of fs.readdirSync(this.root)) {
      const f = path.join(this.root, id, "server.json");
      try { this.map.set(id, JSON.parse(fs.readFileSync(f, "utf8"))); } catch { /* pasta quebrada */ }
    }
  }
  dir(id) { return path.join(this.root, id); }
  dataDir(id) { return path.join(this.root, id, "data"); }
  save(s) { fs.mkdirSync(this.dir(s.id), { recursive: true }); fs.writeFileSync(path.join(this.dir(s.id), "server.json") + ".tmp", JSON.stringify(s, null, 1)); fs.renameSync(path.join(this.dir(s.id), "server.json") + ".tmp", path.join(this.dir(s.id), "server.json")); }
  r(id) { if (!this.rt.has(id)) this.rt.set(id, { state: "offline", lines: [], con: null, stopping: false, crashes: [], started: 0, stats: null, disk: null }); return this.rt.get(id); }
  get(id) { const s = this.map.get(id); if (!s) throw Object.assign(new Error("Servidor não encontrado"), { status: 404 }); return s; }
  setState(id, state) { const r = this.r(id); if (r.state === state) return; r.state = state; this.emit("state", { id, state }); }

  // ---------------------------------------------------------------- console
  print(id, text, kind = "out") {
    const r = this.r(id);
    const parts = String(text).replace(/\r\n/g, "\n").split("\n");
    if (r.partial) { parts[0] = r.partial + parts[0]; r.partial = ""; }
    if (kind === "out" && !String(text).endsWith("\n")) r.partial = parts.pop();
    for (const line of parts) {
      if (line === "" && kind === "out") continue;
      const item = { t: now(), k: kind, s: line };
      r.lines.push(item); if (r.lines.length > MAX_LINES) r.lines.shift();
      this.emit("line", { id, ...item });
      const s = this.map.get(id);
      if (r.state === "starting" && kind === "out" && s && s.done && safeRegex(s.done).test(line)) this.setState(id, "running");
    }
  }
  system(id, text) { this.print(id, text, "sys"); }
  history(id, n = 500) { return this.r(id).lines.slice(-n); }

  // ---------------------------------------------------------------- lista e detalhes
  view(s) {
    const r = this.r(s.id);
    return { id: s.id, name: s.name, template: s.template, templateName: s.templateName, icon: s.icon, category: s.category, image: s.image,
      state: s.installState === "installing" ? "installing" : s.installState === "failed" ? "install_failed" : r.state,
      ports: s.ports, limits: s.limits, autostart: s.autostart, autoRestart: s.autoRestart, vars: s.vars, startup: s.startup, createdAt: s.createdAt,
      egg: !!s.egg, extraPorts: s.extraPorts || [], game: s.game || null, gameVersion: s.gameVersion || null, stats: r.stats, disk: r.disk, startedAt: r.started || null, schedules: s.schedules || [], description: s.description || "" };
  }
  list() { return [...this.map.values()].map((s) => this.view(s)).sort((a, b) => a.createdAt - b.createdAt); }

  // ---------------------------------------------------------------- criar e instalar
  usedPorts(except) { const out = new Set(); for (const s of this.map.values()) if (s.id !== except) for (const p of s.ports || []) out.add(`${p.host}/${p.protocol}`); return out; }
  // porta livre a partir de "want" (as já usadas por outros servidores e as escolhidas agora em "taken")
  pickPort(want, protocol, taken = new Set(), except) {
    const used = this.usedPorts(except);
    const busy = (p, pr) => used.has(`${p}/${pr}`) || used.has(`${p}/both`) || taken.has(p);
    for (let p = want; p < want + 200 && p <= 65535; p++) if (!busy(p, protocol) && !(protocol === "both" && (busy(p, "tcp") || busy(p, "udp")))) return p;
    throw new Error(`Não há porta livre perto da ${want}`);
  }
  async create(spec) {
    const game = spec.game ? this.games.get(spec.game) : null;
    if (game && !game.versions.length) throw new Error("Envie o pacote do jogo antes de criar o servidor");
    const t = templates.get(game ? game.template : spec.template);
    if (!t) throw new Error(game ? "O modelo deste jogo não existe mais nesta máquina: escolha outro nos Meus jogos" : "Modelo desconhecido");
    const name = String(spec.name || t.name).trim().slice(0, 60) || t.name;
    const vars = templates.resolveVars(t, spec.vars || {});
    const id = crypto.randomBytes(4).toString("hex");
    // "container": "same" = o programa escuta na mesma porta de fora (jogos); número = porta fixa dentro do contêiner (sites)
    const taken = new Set();
    // "offset": porta seguida da primeira (o Valheim usa a porta do jogo + 1)
    const ports = [];
    for (const [i, p] of (t.ports || []).entries()) {
      let host;
      if (p.offset != null && ports[0]) {
        host = ports[0].host + p.offset;
        if (this.usedPorts().has(`${host}/${p.protocol || "tcp"}`) || taken.has(host)) throw new Error(`A porta ${host} (${p.name}) já está em uso: escolha outra porta para o jogo`);
      } else host = this.pickPort(Number(spec.ports && spec.ports[i]) || p.default || p.container, p.protocol || "tcp", taken);
      taken.add(host);
      ports.push({ name: p.name, container: p.container === "same" ? host : p.container, host, protocol: p.protocol || "tcp", ...(p.offset != null ? { offset: p.offset } : {}) });
    }
    const L = { ...(t.limits || {}), ...(spec.limits || {}) };
    const s = {
      id, name, template: t.id, templateName: t.name, icon: t.icon, category: t.category, description: String(spec.description || "").slice(0, 200),
      image: spec.image && t.images ? (t.images.find((x) => x.image === spec.image) || t.images[0]).image : t.image,
      startup: spec.startup && t.editableStartup ? String(spec.startup) : t.startup, stop: t.stop || "SIGTERM", done: t.done || null,
      mount: t.mount || "/home/container", user: t.user || "1000:1000", chown: t.chown != null ? t.chown : (t.user && t.user !== "root" ? t.user : "1000:1000"),
      env: t.env || {}, envFromVars: t.envFromVars || null, vars, ports,
      limits: { memory: Math.max(0, Number(L.memory) || 0), cpu: Math.max(0, Number(L.cpu) || 0), disk: Math.max(0, Number(L.disk) || 0) },
      autostart: spec.autostart !== false, autoRestart: spec.autoRestart !== false, wanted: "offline",
      createdAt: now(), installState: "installing", schedules: [],
    };
    if (t.id === "custom") {
      s.image = vars.IMAGE; s.mount = /^\/[\w./-]*$/.test(vars.MOUNT || "") ? vars.MOUNT : "/home/container";
      if (!/^[\w./:@-]+$/.test(s.image)) throw new Error("Imagem do Docker inválida");
    }
    if (t.egg) { s.egg = true; s.extraPorts = parseExtraPorts(spec.extraPorts); this.syncEggPorts(s, true); }
    if (game) { s.game = game.id; s.gameDir = t.gameDir || "game"; s.icon = "joystick"; if (!spec.name) s.name = game.name; }
    fs.mkdirSync(this.dataDir(id), { recursive: true });
    this.map.set(id, s); this.save(s);
    this.emit("changed", { id });
    this.install(id).catch(() => {});
    return this.view(s);
  }
  async install(id, { reinstall = false } = {}) {
    const s = this.get(id), t = templates.get(s.template);
    if (reinstall) { await this.power(id, "kill").catch(() => {}); }
    s.installState = "installing"; this.save(s); this.setState(id, "offline"); this.emit("changed", { id });
    this.system(id, reinstall ? "Reinstalando..." : "Instalando...");
    try {
      await this.ensureImage(id, s.image);
      if (t && t.eggInstall) await this.installEgg(id, s, t);
      if (t && t.install) {
        const img = t.installImage || "alpine:3.20";
        await this.ensureImage(id, img);
        const name = `piphin-install-${id}`;
        await docker.remove(name).catch(() => {});
        const chown = s.chown ? `\nchown -R ${s.chown} /mnt/server` : "";
        const c = await docker.create(name, {
          Image: img, Cmd: ["/bin/sh", "-c", `set -e\ncd /mnt/server\n${t.install}${chown}`], WorkingDir: "/mnt/server", User: "0:0",
          Env: this.envList(s), Labels: { "piphin.install": id },
          HostConfig: { Binds: [`${this.dataDir(id)}:/mnt/server`], NetworkMode: "bridge", Memory: 1024 * 1024 * 1024 },
        });
        const con = await docker.attach(c.Id, (txt) => this.print(id, txt, "install"));
        await docker.start(c.Id);
        const res = await docker.wait(c.Id);
        con.close();
        await docker.remove(c.Id).catch(() => {});
        if (res.StatusCode !== 0) throw new Error(`O script de instalação terminou com erro (código ${res.StatusCode})`);
        // o script pode escolher a imagem certa (ex.: a versão do Java que a versão do Minecraft pede)
        const pick = path.join(this.dataDir(id), ".piphin-image");
        if (t.autoImage && fs.existsSync(pick)) {
          const img = fs.readFileSync(pick, "utf8").trim();
          fs.rmSync(pick, { force: true });
          if (/^[\w./:@-]+$/.test(img) && img !== s.image) { s.image = img; this.system(id, `Imagem escolhida: ${img}`); await this.ensureImage(id, img); }
        }
      }
      if (s.game) await this.extractGame(id, s);
      // sem script de instalação: a pasta ainda precisa ser do usuário do contêiner (ex.: 1000 no Redis)
      if ((!t || !t.install) && s.chown && process.platform === "linux") require("child_process").execFileSync("chown", ["-R", s.chown, this.dataDir(id)]);
      s.installState = "done"; this.save(s);
      this.system(id, "Instalação concluída.");
      this.emit("changed", { id });
      if (s.autostart && !reinstall) await this.power(id, "start").catch((e) => this.system(id, e.message));
    } catch (e) {
      s.installState = "failed"; this.save(s);
      this.system(id, `A instalação falhou: ${e.message}`);
      this.emit("changed", { id });
      throw e;
    }
  }
  // jogo próprio: o pacote é extraído num contêiner (os links que o servidor tiver criado na pasta não levam para fora dela).
  // Extrai por cima: arquivos novos entram, os que o jogo criou (saves, configurações) ficam
  async extractGame(id, s, vid) {
    const g = this.games.get(s.game), v = vid ? this.games.file(s.game, vid) : (g.versions[0] && this.games.file(s.game, g.versions[0].id));
    if (!v) throw new Error("Este jogo ainda não tem um pacote enviado");
    this.system(id, `Instalando ${g.name}: ${v.name} (${(v.size / 1048576).toFixed(0)} MB)...`);
    const img = "alpine:3.20", name = `piphin-install-${id}`;
    await this.ensureImage(id, img);
    await docker.remove(name).catch(() => {});
    const script = `set -e
D="/mnt/server/$GAME_DIR"
mkdir -p "$D"
case "$PKG" in
  *.zip) unzip -oq "/pkg/$PKG" -d "$D" ;;
  *.tar) tar -xof "/pkg/$PKG" -C "$D" ;;
  *) tar -xzof "/pkg/$PKG" -C "$D" ;;
esac
find "$D" -type f \\( -name "*.sh" -o -path "*/Binaries/Linux/*" \\) -exec chmod +x {} +
chown -R ${s.chown || "1000:1000"} "$D"
echo "Pacote extraído."`;
    const c = await docker.create(name, {
      Image: img, Cmd: ["/bin/sh", "-c", script], User: "0:0", Labels: { "piphin.install": id }, Env: [`PKG=${v.file}`, `GAME_DIR=${s.gameDir || "game"}`],
      HostConfig: { Binds: [`${this.dataDir(id)}:/mnt/server`, `${v.path}:/pkg/${v.file}:ro`], NetworkMode: "none", Memory: 1024 * 1024 * 1024 },
    });
    const con = await docker.attach(c.Id, (txt) => this.print(id, txt, "install"));
    await docker.start(c.Id);
    const res = await docker.wait(c.Id);
    con.close();
    await docker.remove(c.Id).catch(() => {});
    if (res.StatusCode !== 0) throw new Error(`Não deu para extrair o pacote (código ${res.StatusCode}). Confira se o arquivo não está corrompido.`);
    s.gameVersion = v.id; this.save(s);
    this.system(id, `${g.name} instalado: versão de ${new Date(v.at).toLocaleString("pt-BR")}.`);
    this.emit("changed", { id });
  }
  // atualizar o jogo de um servidor: desliga, extrai a versão pedida (ou a mais nova) e liga de novo se estava ligado
  async updateGame(id, vid) {
    const s = this.get(id), r = this.r(id);
    if (!s.game) throw new Error("Este servidor não é de um jogo próprio");
    if (s.installState === "installing" || this.updatingGame.has(id)) throw new Error("Aguarde a instalação terminar");
    this.updatingGame.add(id);
    const wasOn = r.state !== "offline";
    try {
      if (wasOn) { this.system(id, "Desligando para atualizar o jogo..."); await this.stopContainer(s, false); }
      await this.extractGame(id, s, vid);
      if (wasOn) { s.wanted = "running"; this.save(s); await this.startContainer(s); }
    } catch (e) { this.system(id, e.message); throw e; } finally { this.updatingGame.delete(id); }
    return this.view(s);
  }
  // egg: o script roda como no Pterodactyl, em /mnt/install/install.sh com a pasta do servidor em /mnt/server
  async installEgg(id, s, t) {
    const { script, container, entrypoint } = t.eggInstall;
    await this.ensureImage(id, container);
    const name = `piphin-install-${id}`, file = path.join(this.dir(id), "install.sh");
    fs.writeFileSync(file, script);
    await docker.remove(name).catch(() => {});
    const c = await docker.create(name, {
      Image: container, Cmd: [entrypoint, "/mnt/install/install.sh"], User: "0:0", Env: this.envList(s), Labels: { "piphin.install": id },
      HostConfig: { Binds: [`${this.dataDir(id)}:/mnt/server`, `${file}:/mnt/install/install.sh:ro`], NetworkMode: "bridge", Memory: Math.max(s.limits.memory, 1024) * 1024 * 1024 },
    });
    const con = await docker.attach(c.Id, (txt) => this.print(id, txt, "install"));
    await docker.start(c.Id);
    const res = await docker.wait(c.Id);
    con.close();
    await docker.remove(c.Id).catch(() => {});
    fs.rmSync(file, { force: true });
    // muitos scripts de egg terminam com um comando sem importância que falha: o Pterodactyl segue em frente, aqui também
    if (res.StatusCode !== 0) this.system(id, `O script de instalação terminou com o código ${res.StatusCode}. Se o servidor não ligar, veja as mensagens acima.`);
  }
  // portas do egg: a principal, as das variáveis (QUERY_PORT...) e as extras; bump = trocar por uma livre em vez de recusar
  syncEggPorts(s, bump = false) {
    const t = templates.get(s.template), main = s.ports[0], used = this.usedPorts(s.id), seen = new Set([main.host]), out = [main];
    const busy = (p) => ["tcp", "udp", "both"].some((x) => used.has(`${p}/${x}`));
    const add = (host, name) => { seen.add(host); out.push({ name, container: host, host, protocol: "both", auto: true }); };
    for (const [k, val] of Object.entries(s.vars || {})) {
      let p = Number(val);
      if (!eggs.isPortVar(k) || !Number.isInteger(p) || p < 1 || p > 65535) continue;
      if (seen.has(p) && !bump) continue;
      if (seen.has(p) || busy(p)) {
        if (!bump) throw new Error(`A porta ${p} já é usada por outro servidor`);
        while (seen.has(p) || busy(p)) if (++p > 65535) throw new Error(`Não há porta livre perto da ${val}`);
        s.vars[k] = String(p);
      }
      const v = t && (t.vars || []).find((x) => x.key === k);
      add(p, v ? v.name : k);
    }
    for (const p of s.extraPorts || []) {
      if (seen.has(p)) continue;
      if (busy(p)) throw new Error(`A porta ${p} já é usada por outro servidor`);
      add(p, "Extra");
    }
    s.ports = out;
  }
  // o que o egg pede antes de ligar: EULA aceito e os arquivos de configuração com as portas e opções atuais
  async applyEggFiles(s) {
    const t = templates.get(s.template), root = this.dataDir(s.id); if (!t) return;
    const env = this.envMap(s), port = s.ports[0] ? String(s.ports[0].container) : "", mem = String(s.limits.memory || 1024);
    const owner = process.platform === "linux" && s.chown ? s.chown.split(":").map(Number) : null;
    const put = async (full, text) => {
      const made = fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
      if (owner) { if (made) require("child_process").execFileSync("chown", ["-R", s.chown, made]); fs.lchownSync(full, owner[0], owner[1]); }
    };
    if (t.eula) { const f = files.resolve(root, "eula.txt"); await files.real(root, f); await put(f, "eula=true\n"); }
    for (const [rel, c] of Object.entries(t.configFiles || {})) {
      try {
        const edit = c && eggs.PARSERS[c.parser]; if (!edit) continue;
        const f = files.resolve(root, rel); await files.real(root, f);
        let before = ""; try { before = fs.readFileSync(f, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; if (c.parser === "file") continue; }
        const find = {};
        for (const [k, v] of Object.entries(c.find || {})) {
          const fix = (x) => (typeof x === "string" ? eggs.fill(x, env, port, mem) : x);
          find[fix(k)] = v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([a, b]) => [a, fix(b)])) : fix(v);
        }
        const after = edit(before, find);
        if (after !== before) await put(f, after);
      } catch (e) { this.system(s.id, `Não deu para ajustar ${rel}: ${e.message}`); }
    }
  }
  async ensureImage(id, image) {
    if (await docker.imageExists(image)) return;
    this.system(id, `Baixando a imagem ${image}...`);
    let last = 0;
    await docker.pull(image, (o) => { if (o.status && now() - last > 2500) { last = now(); this.system(id, `${o.status}${o.progress ? " " + o.progress.replace(/\s+/g, " ") : ""}`); } });
    this.system(id, `Imagem ${image} pronta.`);
  }

  // variáveis do modelo + as do sistema, para o contêiner e para trocar {{NOME}} na linha de início
  envMap(s) {
    const p0 = (s.ports || [])[0], mem = s.limits.memory || 1024;
    const fromVars = Object.fromEntries(Object.entries(s.envFromVars || {}).map(([k, v]) => [k, s.vars[v] ?? ""]));
    const port = p0 ? String(p0.container) : "";
    // a JVM usa um pouco mais que o heap: deixa 15% de folga para o contêiner não ser morto por falta de memória
    if (s.egg) return { PORT: port, ...s.vars, SERVER_PORT: port, SERVER_MEMORY: String(mem), SERVER_IP: "0.0.0.0", HOME: s.mount, USER: "container", TZ: process.env.TZ || "America/Sao_Paulo",
      P_SERVER_LOCATION: "piphin", P_SERVER_UUID: s.id, P_SERVER_ALLOCATION_LIMIT: "0", PIPHIN_SERVER: s.id, STARTUP: eggStartup(s.startup) };
    return { ...s.env, ...s.vars, ...fromVars, SERVER_PORT: port, PORT: port, SERVER_MEMORY: String(mem), SERVER_MEMORY_JVM: String(Math.max(256, Math.floor(mem * 0.85))),
      SERVER_IP: "0.0.0.0", HOME: s.mount, TZ: process.env.TZ || "America/Sao_Paulo", PIPHIN_SERVER: s.id };
  }
  envList(s) { return Object.entries(this.envMap(s)).map(([k, v]) => `${k}=${v}`); }
  // comando que a pessoa não edita vem sempre do modelo atual: correções do modelo chegam aos servidores que já existem
  startupLine(s) { const e = this.envMap(s), t = templates.get(s.template); return String((t && !t.editableStartup && t.startup) || s.startup || "").replace(/\{\{([A-Z0-9_]+)\}\}/g, (all, k) => (e[k] !== undefined ? e[k] : all)); }

  // ---------------------------------------------------------------- ligar e desligar
  async power(id, action) {
    const s = this.get(id), r = this.r(id);
    if (s.installState === "installing") throw new Error("Aguarde a instalação terminar");
    if (action === "start") {
      if (s.installState === "failed") throw new Error("A instalação falhou. Reinstale o servidor nas configurações");
      if (r.state === "running" || r.state === "starting") return this.view(s);
      if (s.limits.disk && r.disk && r.disk.used > s.limits.disk * 1024 * 1024) throw new Error("O servidor passou do limite de disco. Apague arquivos ou aumente o limite");
      s.wanted = "running"; this.save(s);
      await this.startContainer(s);
    } else if (action === "stop") {
      s.wanted = "offline"; this.save(s);
      await this.stopContainer(s, false);
    } else if (action === "restart") {
      s.wanted = "running"; this.save(s);
      await this.stopContainer(s, false);
      await this.startContainer(s);
    } else if (action === "kill") {
      s.wanted = "offline"; this.save(s);
      await this.stopContainer(s, true);
    } else throw new Error("Ação desconhecida");
    return this.view(s);
  }
  async startContainer(s) {
    const id = s.id, r = this.r(id), name = `piphin-${id}`;
    this.setState(id, "starting");
    try {
      await this.ensureImage(id, s.image);
      if (s.egg) await this.applyEggFiles(s);
      await docker.remove(name).catch(() => {});
      const exposed = {}, bindings = {};
      for (const p of s.ports || []) for (const proto of p.protocol === "both" ? ["tcp", "udp"] : [p.protocol]) {
        exposed[`${p.container}/${proto}`] = {};
        bindings[`${p.container}/${proto}`] = [{ HostIp: "", HostPort: String(p.host) }];
      }
      const line = s.egg ? "" : this.startupLine(s);
      const body = {
        Image: s.image, Env: this.envList(s), Labels: { "piphin.server": id }, ExposedPorts: exposed,
        Tty: false, OpenStdin: true, StdinOnce: false, AttachStdin: true, AttachStdout: true, AttachStderr: true,
        ...(line ? { Cmd: ["/bin/sh", "-c", line] } : {}), ...(s.mount ? { WorkingDir: s.mount } : {}), ...(s.user && s.user !== "root" ? { User: s.user } : {}),
        HostConfig: {
          Binds: [`${this.dataDir(id)}:${s.mount || "/home/container"}`], PortBindings: bindings, RestartPolicy: { Name: "no" },
          LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "2" } }, PidsLimit: 1024, Init: true,
          ...(s.limits.memory ? { Memory: s.limits.memory * 1024 * 1024, MemorySwap: s.limits.memory * 1024 * 1024 } : {}),
          ...(s.limits.cpu ? { NanoCpus: Math.round(s.limits.cpu * 1e9) } : {}),
        },
      };
      const c = await docker.create(name, body);
      r.containerId = c.Id;
      if (r.con) { try { r.con.close(); } catch {} }
      r.con = await docker.attach(c.Id, (txt) => this.print(id, txt));
      r.stopping = false;
      await docker.start(c.Id);
      r.started = now();
      this.system(id, "Servidor iniciado.");
      if (!s.done) this.setState(id, "running");
    } catch (e) {
      this.setState(id, "offline");
      this.system(id, `Não foi possível iniciar: ${e.message}`);
      throw e;
    }
  }
  async stopContainer(s, kill) {
    const id = s.id, r = this.r(id), name = `piphin-${id}`;
    const info = await docker.inspect(name);
    if (!info || !info.State.Running) { this.setState(id, "offline"); return; }
    r.stopping = true;
    this.setState(id, "stopping");
    const until = async (ms) => { const t0 = now(); while (now() - t0 < ms) { await wait(1000); const i = await docker.inspect(name); if (!i || !i.State.Running) return true; } return false; };
    if (kill) { await docker.kill(name); this.system(id, "Servidor forçado a parar."); }
    else if (s.stop && /^SIG[A-Z]+$/.test(s.stop) && s.stop !== "SIGTERM") {
      // sinal próprio do programa (ex.: SIGINT no Valheim salva o mundo)
      await docker.kill(name, s.stop);
      if (!(await until(60000))) { this.system(id, "Não parou sozinho em 60 segundos: parando à força."); await docker.kill(name); }
    } else if (s.stop && !/^(SIG|\^C)/.test(s.stop) && r.con) {
      // comando de parada do próprio servidor (ex.: "stop" no Minecraft); se não parar em 60 s, para à força
      r.con.write(s.stop + "\n");
      if (!(await until(60000))) { this.system(id, "Não parou sozinho em 60 segundos: parando à força."); await docker.kill(name); }
    } else await docker.stop(name, 30);
    this.setState(id, "offline");
  }
  command(id, line) {
    const r = this.r(id);
    if (!r.con || (r.state !== "running" && r.state !== "starting")) throw new Error("O servidor está desligado");
    const text = String(line).replace(/[\r\n]+/g, " ").slice(0, 2000);
    this.print(id, "> " + text, "cmd");
    r.con.write(text + "\n");
  }

  // o contêiner parou (evento do Docker): queda inesperada reinicia sozinho, com limite
  async onDie(id, exitCode, containerId) {
    const s = this.map.get(id); if (!s) return;
    const r = this.r(id);
    // só o contêiner atual conta (trocar o contêiner também gera "die" do antigo)
    if (containerId && r.containerId && containerId !== r.containerId) return;
    if (r.con) { try { r.con.close(); } catch {} r.con = null; }
    this.setState(id, "offline");
    if (r.stopping || s.wanted !== "running") { this.system(id, "Servidor desligado."); return; }
    this.system(id, `O servidor parou sozinho (código ${exitCode}).`);
    if (!s.autoRestart) { s.wanted = "offline"; this.save(s); return; }
    r.crashes = r.crashes.filter((t) => now() - t < 5 * 60000); r.crashes.push(now());
    if (r.crashes.length > 3) { this.system(id, "Caiu 4 vezes em 5 minutos: o reinício automático foi pausado. Veja o console para entender o erro."); s.wanted = "offline"; this.save(s); return; }
    this.system(id, "Reiniciando em 5 segundos...");
    await wait(5000);
    if (s.wanted === "running") await this.startContainer(s).catch(() => {});
  }

  // ---------------------------------------------------------------- mudar e apagar
  // jogo próprio: troca o modelo (o Jogo Unreal ou um egg) e instala de novo por cima; a pasta do jogo e os saves ficam
  async changeTemplate(id, tid, given = {}) {
    const s = this.get(id), t = templates.get(tid);
    if (!s.game) throw Object.assign(new Error("Só os servidores dos Meus jogos podem trocar de modelo"), { status: 400 });
    if (!t || !(t.egg || t.id === "unreal-game")) throw Object.assign(new Error("Modelo desconhecido"), { status: 400 });
    if (s.installState === "installing" || this.updatingGame.has(id)) throw new Error("Aguarde a instalação terminar");
    const vars = templates.resolveVars(t, { ...s.vars, ...given });
    const wasOn = this.r(id).state !== "offline";
    if (wasOn) await this.stopContainer(s, false);
    const main = (s.ports || [])[0], p = (t.ports || [])[0] || { name: "Jogo", protocol: "udp" };
    Object.assign(s, { template: t.id, templateName: t.name, vars, image: t.image, startup: t.startup, stop: t.stop || "SIGTERM", done: t.done || null,
      mount: t.mount || "/home/container", user: t.user || "1000:1000", chown: t.chown || "1000:1000", env: t.env || {}, envFromVars: t.envFromVars || null, gameDir: t.gameDir || "game" });
    s.ports = main ? [{ name: p.name, container: main.host, host: main.host, protocol: p.protocol || "tcp" }] : [];
    if (t.egg) { s.egg = true; s.extraPorts = s.extraPorts || []; this.syncEggPorts(s, true); } else { delete s.egg; delete s.extraPorts; }
    this.save(s);
    this.system(id, `Agora o jogo roda com: ${t.name}.`);
    this.games.update(s.game, { template: t.id }); // os próximos servidores do jogo também
    await this.install(id, { reinstall: true });
    if (wasOn) await this.power(id, "start").catch((e) => this.system(id, e.message));
    return this.view(s);
  }
  async update(id, patch) {
    const s = this.get(id), t = templates.get(s.template);
    if (patch.name != null) s.name = String(patch.name).trim().slice(0, 60) || s.name;
    if (patch.description != null) s.description = String(patch.description).slice(0, 200);
    if (patch.vars) s.vars = templates.resolveVars(t || { vars: [] }, { ...s.vars, ...patch.vars }, true);
    if (patch.limits) for (const k of ["memory", "cpu", "disk"]) if (patch.limits[k] != null) s.limits[k] = Math.max(0, Number(patch.limits[k]) || 0);
    if (patch.autostart != null) s.autostart = !!patch.autostart;
    if (patch.autoRestart != null) s.autoRestart = !!patch.autoRestart;
    if (patch.startup != null && t && t.editableStartup) s.startup = String(patch.startup);
    if (patch.startup != null && s.egg && !String(patch.startup).trim()) s.startup = t ? t.startup : s.startup;
    if (patch.image && t && t.images && t.images.some((x) => x.image === patch.image)) s.image = patch.image;
    if (patch.image && s.template === "custom") s.image = String(patch.image).trim();
    if (Array.isArray(patch.ports)) {
      const used = this.usedPorts(id);
      s.ports = s.ports.map((p, i) => {
        const h = Number(patch.ports[i]);
        if (!h || h === p.host) return p;
        if (h < 1 || h > 65535) throw new Error(`Porta inválida: ${h}`);
        if (["tcp", "udp", "both"].some((x) => (p.protocol === "both" || x === "both" || x === p.protocol) && used.has(`${h}/${x}`))) throw new Error(`A porta ${h} já é usada por outro servidor`);
        return { ...p, host: h, container: p.container === p.host ? h : p.container };
      });
      // portas seguidas acompanham a primeira
      for (const p of s.ports) if (p.offset != null) { const h = s.ports[0].host + p.offset; if (p.container === p.host) p.container = h; p.host = h; }
    }
    if (s.egg) { if (patch.extraPorts != null) s.extraPorts = parseExtraPorts(patch.extraPorts); this.syncEggPorts(s); }
    if (Array.isArray(patch.schedules)) s.schedules = patch.schedules.slice(0, 30).map((x) => ({ id: x.id || crypto.randomBytes(3).toString("hex"), cron: String(x.cron || ""), action: ["restart", "start", "stop", "backup", "command"].includes(x.action) ? x.action : "restart", payload: String(x.payload || "").slice(0, 500), enabled: x.enabled !== false, last: x.last || null }));
    this.save(s);
    this.emit("changed", { id });
    return this.view(s);
  }
  async remove(id) {
    const s = this.get(id);
    s.wanted = "offline";
    await docker.remove(`piphin-${id}`).catch(() => {});
    await docker.remove(`piphin-install-${id}`).catch(() => {});
    const r = this.r(id); if (r.con) { try { r.con.close(); } catch {} }
    this.map.delete(id); this.rt.delete(id);
    fs.rmSync(this.dir(id), { recursive: true, force: true });
    this.emit("changed", { id, removed: true });
    return true;
  }

  // ---------------------------------------------------------------- números
  async stats(id) {
    const r = this.r(id);
    if (r.state === "offline") { r.stats = null; return null; }
    try {
      const x = await docker.stats(`piphin-${id}`);
      const cpuDelta = x.cpu_stats.cpu_usage.total_usage - (x.precpu_stats.cpu_usage && x.precpu_stats.cpu_usage.total_usage || 0);
      const sysDelta = x.cpu_stats.system_cpu_usage - (x.precpu_stats.system_cpu_usage || 0);
      const cores = x.cpu_stats.online_cpus || (x.cpu_stats.cpu_usage.percpu_usage || []).length || 1;
      const net = Object.values(x.networks || {}).reduce((a, n) => ({ rx: a.rx + n.rx_bytes, tx: a.tx + n.tx_bytes }), { rx: 0, tx: 0 });
      const cache = (x.memory_stats.stats && (x.memory_stats.stats.inactive_file || x.memory_stats.stats.cache)) || 0;
      r.stats = { at: now(), cpu: sysDelta > 0 ? Math.round((cpuDelta / sysDelta) * cores * 1000) / 10 : 0, memory: Math.max(0, (x.memory_stats.usage || 0) - cache), memoryLimit: x.memory_stats.limit || 0, net };
    } catch { r.stats = null; }
    return r.stats;
  }
  async diskUsage(id) {
    const s = this.map.get(id); if (!s) return null;
    let used = 0, files = 0;
    const walk = async (d) => {
      let list; try { list = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of list) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) { try { used += (await fs.promises.stat(p)).size; files++; } catch {} }
      }
    };
    await walk(this.dataDir(id));
    const r = this.r(id);
    r.disk = { used, files, at: now() };
    if (s.limits.disk && used > s.limits.disk * 1024 * 1024 && r.state === "running") {
      this.system(id, "O servidor passou do limite de disco e foi desligado.");
      s.wanted = "offline"; this.save(s);
      await this.stopContainer(s, false).catch(() => {});
    }
    return r.disk;
  }

  // ---------------------------------------------------------------- ao abrir o agente
  async boot() {
    // volta a ligar o console dos que já estão rodando e liga os que deveriam estar ligados
    let live = [];
    try { live = await docker.list(true); } catch (e) { this.log("docker", e.message); return; }
    for (const s of this.map.values()) {
      if (s.installState === "installing") { s.installState = "failed"; this.save(s); this.system(s.id, "A instalação foi interrompida (o agente reiniciou). Reinstale nas configurações."); continue; }
      const c = live.find((x) => x.Labels && x.Labels["piphin.server"] === s.id);
      if (c && c.State === "running") {
        const r = this.r(s.id);
        r.containerId = c.Id;
        try { r.con = await docker.attach(c.Id, (txt) => this.print(s.id, txt)); } catch {}
        const old = await docker.logs(c.Id, 200).catch(() => "");
        if (old) this.print(s.id, old);
        r.started = Date.parse((await docker.inspect(c.Id)).State.StartedAt) || now();
        this.setState(s.id, "running");
      } else if (s.wanted === "running" && s.autostart && s.installState === "done") {
        this.startContainer(s).catch(() => {});
      }
    }
    // eventos: quedas e paradas feitas fora do agente
    const listen = () => {
      const ev = docker.events((e) => {
        const id = e.Actor && e.Actor.Attributes && e.Actor.Attributes["piphin.server"];
        if (id && e.Action === "die") this.onDie(id, Number(e.Actor.Attributes.exitCode || 0), e.Actor.ID || e.id);
      });
      ev.done.catch(() => {}).finally(() => setTimeout(listen, 3000));
    };
    listen();
    setInterval(() => { for (const id of this.map.keys()) this.diskUsage(id).catch(() => {}); }, 120000).unref();
    for (const id of this.map.keys()) this.diskUsage(id).catch(() => {});
  }
}

// a imagem do egg troca {{NOME}} sozinha; os nomes do painel viram os das variáveis
const eggStartup = (line) => String(line || "").replace(/\{\{\s*server\.build\.default\.port\s*\}\}/g, "{{SERVER_PORT}}").replace(/\{\{\s*server\.build\.default\.ip\s*\}\}/g, "{{SERVER_IP}}")
  .replace(/\{\{\s*server\.build\.memory\s*\}\}/g, "{{SERVER_MEMORY}}").replace(/\{\{\s*(?:server\.build\.env\.|env\.)(\w+)\s*\}\}/g, "{{$1}}");
function parseExtraPorts(x) {
  const list = Array.isArray(x) ? x : String(x || "").split(/[\s,;]+/).filter(Boolean);
  const out = [];
  for (const v of list) {
    const p = Number(v);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`Porta inválida: ${v}`);
    if (!out.includes(p)) out.push(p);
  }
  return out.slice(0, 30);
}
function safeRegex(src) { try { return new RegExp(src); } catch { return /$^/; } }
module.exports = Servers;
