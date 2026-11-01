// Piphin Agent · eggs do Pterodactyl (PTDL_v1/v2): vira um modelo igual aos de agent/templates e fica salvo em dataDir/eggs.
// As imagens dos eggs já sabem ligar sozinhas: recebem a linha de início na variável STARTUP (por isso o contêiner não leva Cmd).
"use strict";
const fs = require("fs");
const path = require("path");

const IMAGE = /^[\w./:@-]+$/;
const fail = (msg) => Object.assign(new Error(msg), { status: 400 });
const slugOf = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
const parseMaybe = (x, d) => { if (x && typeof x === "object") return x; try { return JSON.parse(x); } catch { return d; } };

// ^C e ^^C = Ctrl+C; ^SIGKILL = o sinal com esse nome; o resto é um comando no console
function stopOf(stop) {
  const s = String(stop || "").trim();
  if (!s) return "SIGTERM";
  if (!s.startsWith("^")) return s;
  const sig = s.replace(/^\^+/, "").toUpperCase();
  return /^SIG[A-Z]+$/.test(sig) ? sig : sig === "C" ? "SIGINT" : "SIGTERM";
}
// a frase que indica que ligou: texto puro (ou lista de textos); "regex:" = expressão pronta
function doneOf(startup) {
  const d = parseMaybe(startup, {}).done;
  const one = (x) => (String(x).startsWith("regex:") ? String(x).slice(6) : String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const list = (Array.isArray(d) ? d : [d]).filter((x) => x != null && x !== "");
  return list.length ? list.map(one).join("|") : null;
}
// regras do painel (required|string|max:20...) -> campo do formulário
function varOf(v) {
  const rules = String(v.rules || "").split("|").map((r) => r.trim()), has = (n) => rules.includes(n);
  const arg = (n) => { const r = rules.find((x) => x.toLowerCase().startsWith(n + ":")); return r ? r.slice(n.length + 1) : null; };
  const key = String(v.env_variable || "").trim(), d = v.default_value == null ? "" : String(v.default_value);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,80}$/.test(key)) return null;
  const nullable = rules.some((r) => r.toLowerCase() === "nullable");
  const out = { key, name: String(v.name || key).slice(0, 100), description: String(v.description || "").replace(/\s*\r?\n\s*/g, " ").trim().slice(0, 400), default: d, required: has("required"), allowEmpty: !has("required") };
  if (v.user_editable === false || v.user_viewable === false) out.hidden = true;
  const within = arg("in");
  const isNum = has("numeric") || has("integer") || has("int");
  const yesNo = (a, b) => ({ type: "select", options: [{ value: a, name: "Sim" }, { value: b, name: "Não" }] });
  if (has("boolean")) Object.assign(out, /^(true|false)$/i.test(d) ? yesNo("true", "false") : yesNo("1", "0"));
  else if (within != null) {
    const list = within.split(",").map((x) => x.trim().replace(/^"(.*)"$/, "$1"));
    const set = [...list].sort().join();
    if (set === "0,1") Object.assign(out, yesNo("1", "0"));
    else if (set === "false,true") Object.assign(out, yesNo("true", "false"));
    else { out.type = "select"; out.options = (nullable ? [""] : []).concat(list).map((x) => ({ value: x, name: x || "-" })); }
  } else if (isNum) {
    out.type = "number";
    const b = arg("between"); if (b) { const [a, c] = b.split(",").map(Number); if (isFinite(a)) out.min = a; if (isFinite(c)) out.max = c; }
    const mn = Number(arg("min")), mx = Number(arg("max")); if (arg("min") != null && isFinite(mn)) out.min = mn; if (arg("max") != null && isFinite(mx)) out.max = mx;
  } else if (/PASS(WORD|WD)?($|_)|TOKEN|SECRET|API_?KEY/i.test(key)) out.type = "password";
  return out;
}
// as portas que o programa usa além da principal vêm em variáveis (QUERY_PORT, RCON_PORT...) e precisam ser abertas
const isPortVar = (k) => /(^|_)PORT(_?\d*)?$|[A-Z](GAME|QUERY|RCON|STEAM|WEB|HTTP|VOICE)PORT$|^(GAME|QUERY|RCON|STEAM|WEB|HTTP|VOICE)PORT$/i.test(k)
  && !/^(SERVER_PORT|PORT)$/i.test(k) && !/DB|DATABASE|MYSQL|MARIA|REDIS|POSTGRES|MONGO|SMTP|MAIL|LAVALINK|REMOTE|PROXY|EXTERNAL/i.test(k);

function convert(egg, { slug } = {}) {
  if (!egg || typeof egg !== "object" || !/^PTDL_v[12]$/.test((egg.meta && egg.meta.version) || "")) throw fail("Esse arquivo não é um egg do Pterodactyl");
  const name = String(egg.name || "").trim().slice(0, 80);
  const raw = egg.docker_images || (Array.isArray(egg.images) ? Object.fromEntries(egg.images.map((i) => [i, i])) : egg.image ? { [egg.image]: egg.image } : {});
  const images = Object.entries(raw).map(([n, i]) => ({ name: String(n).trim().slice(0, 60), image: String(i).trim() })).filter((x) => IMAGE.test(x.image));
  const ins = (egg.scripts && egg.scripts.installation) || {};
  if (!name || !images.length || !egg.startup) throw fail("Esse egg está incompleto (falta nome, imagem ou comando de início)");
  const container = String(ins.container || "").trim(), entrypoint = String(ins.entrypoint || "bash").trim();
  if (ins.script && (!IMAGE.test(container) || !/^[\w./-]+$/.test(entrypoint))) throw fail("Esse egg tem um script de instalação inválido");
  const vars = (egg.variables || []).map(varOf).filter(Boolean);
  const features = Array.isArray(egg.features) ? egg.features : [];
  const eula = features.includes("eula");
  if (eula) vars.unshift({ key: "PIPHIN_EULA", name: "Aceito o EULA do Minecraft (minecraft.net/eula)", type: "bool", default: "false", mustBe: "true", mustBeMessage: "É preciso aceitar o EULA do Minecraft" });
  const hay = `${slug || ""} ${name}`.toLowerCase();
  return {
    id: `egg-${slugOf(slug || name) || "sem-nome"}`, order: 200, egg: true, name, category: "eggs", icon: "egg", author: String(egg.author || "").slice(0, 100),
    description: String(egg.description || "").replace(/\s+/g, " ").trim().slice(0, 300),
    image: images[0].image, images, editableStartup: true, startup: String(egg.startup).trim(), stop: stopOf(egg.config && egg.config.stop), done: doneOf(egg.config && egg.config.startup),
    mount: "/home/container", user: "1000:1000", chown: "1000:1000",
    ports: [{ name: "Principal", container: "same", protocol: "both", default: /minecraft|paper|spigot|forge|fabric/.test(hay) ? 25565 : slug && /^applications-/.test(slug) ? 8080 : 27015 }],
    limits: { memory: 4096, cpu: 0, disk: 0 }, vars, eula,
    configFiles: parseMaybe(egg.config && egg.config.files, {}) || {},
    eggInstall: ins.script ? { script: String(ins.script).replace(/\r\n/g, "\n"), container, entrypoint } : null,
  };
}

// ---------------------------------------------------------------- guardar
const dirOf = (cfg) => path.join(cfg.dataDir, "eggs");
function load(cfg) {
  try { return fs.readdirSync(dirOf(cfg)).filter((f) => f.endsWith(".json")).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dirOf(cfg), f), "utf8")); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
}
function save(cfg, t) { fs.mkdirSync(dirOf(cfg), { recursive: true }); fs.writeFileSync(path.join(dirOf(cfg), t.id + ".json"), JSON.stringify(t)); }
function remove(cfg, id) { if (!/^egg-[a-z0-9-]+$/.test(id)) throw fail("Egg inválido"); fs.rmSync(path.join(dirOf(cfg), id + ".json"), { force: true }); }

// ---------------------------------------------------------------- arquivos de configuração do egg (config.files), refeitos a cada início
function fill(text, env, port, memory) {
  return String(text).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (all, k) => {
    if (k === "server.build.default.port") return port;
    if (k === "server.build.default.ip") return "0.0.0.0";
    if (k === "server.build.memory") return memory;
    if (k === "config.docker.interface") return "172.17.0.1"; // o Docker visto de dentro do contêiner
    const m = /^(?:server\.build\.env\.|env\.)?([\w]+)$/.exec(k);
    return m ? env[m[1]] ?? "" : all;
  });
}
const typed = (v) => (typeof v !== "string" ? v : v === "true" ? true : v === "false" ? false : /^-?(0|[1-9]\d{0,15})$/.test(v) ? Number(v) : v);
// valor do egg: texto = troca; objeto = troca só o trecho encontrado no valor atual ({ "127.0.0.1": "novo" })
function nextValue(rule, current) {
  if (!rule || typeof rule !== "object") return rule;
  let cur = current == null ? "" : String(current);
  for (const [a, b] of Object.entries(rule)) {
    if (a.startsWith("regex:")) { try { cur = cur.replace(new RegExp(a.slice(6), "g"), String(b)); } catch {} } else cur = cur.split(a).join(String(b));
  }
  return cur;
}
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pathTokens = (k) => String(k).replace(/\[(\d+)\]/g, ".[$1]").split(".").filter(Boolean);

function editProperties(text, find) {
  const lines = text.split(/\r?\n/); if (lines[lines.length - 1] === "") lines.pop();
  for (const [k, rule] of Object.entries(find)) {
    const re = new RegExp(`^\\s*${reEsc(k)}\\s*[=:]\\s?(.*)$`);
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) lines[i] = `${k}=${nextValue(rule, re.exec(lines[i])[1])}`;
    else if (typeof rule !== "object") lines.push(`${k}=${rule}`);
  }
  return lines.join("\n") + "\n";
}
function editPlainFile(text, find) {
  return text.split("\n").map((l) => { const clean = l.replace(/\r$/, ""); for (const [k, v] of Object.entries(find)) if (clean.startsWith(k)) return String(nextValue(v, clean)); return clean; }).join("\n");
}
function editIni(text, find) {
  const lines = text.split(/\r?\n/); if (lines[lines.length - 1] === "") lines.pop();
  for (const [full, rule] of Object.entries(find)) {
    let section = "", key = full;
    const br = /^\[([^\]]+)\]\.(.+)$/.exec(full);
    if (br) { section = br[1]; key = br[2]; } else if (full.includes(".")) { section = full.slice(0, full.indexOf(".")); key = full.slice(full.indexOf(".") + 1); }
    const isHead = (l) => /^\s*\[.*\]\s*$/.test(l);
    let start = 0, end = lines.findIndex(isHead); if (end < 0) end = lines.length;
    if (section) {
      start = lines.findIndex((l) => l.trim().toLowerCase() === `[${section}]`.toLowerCase());
      if (start < 0) { if (lines.length) lines.push(""); lines.push(`[${section}]`); start = lines.length - 1; }
      start++; end = start; while (end < lines.length && !isHead(lines[end])) end++;
    }
    const re = new RegExp(`^\\s*${reEsc(key)}\\s*=\\s*(.*)$`, "i");
    let hit = -1; for (let i = start; i < end; i++) if (re.test(lines[i])) { hit = i; break; }
    if (hit >= 0) lines[hit] = `${key}=${nextValue(rule, re.exec(lines[hit])[1])}`;
    else if (typeof rule !== "object") { let at = end; while (at > start && !lines[at - 1].trim()) at--; lines.splice(at, 0, `${key}=${rule}`); }
  }
  return lines.join("\n") + "\n";
}
function editJson(text, find) {
  let root; try { root = JSON.parse(text.replace(/^﻿/, "")); } catch { root = {}; }
  if (!root || typeof root !== "object") root = {};
  const walk = (o, toks, rule) => {
    const [t, ...rest] = toks;
    if (t === "*") { for (const k of Object.keys(o)) if (rest.length ? o[k] && typeof o[k] === "object" : true) { if (rest.length) walk(o[k], rest, rule); else o[k] = typed(nextValue(rule, o[k])); } return; }
    const k = /^\[\d+\]$/.test(t) ? Number(t.slice(1, -1)) : t;
    if (!rest.length) { if (typeof rule === "object" && o[k] === undefined) return; o[k] = typed(nextValue(rule, o[k])); return; }
    if (o[k] == null || typeof o[k] !== "object") { if (typeof rule === "object" || rest[0] === "*") return; o[k] = /^\[\d+\]$/.test(rest[0]) ? [] : {}; }
    walk(o[k], rest, rule);
  };
  for (const [k, rule] of Object.entries(find)) walk(root, pathTokens(k), rule);
  return JSON.stringify(root, null, 2) + "\n";
}
// YAML por linhas (sem biblioteca): mexe só no valor pedido e mantém os comentários e o resto do arquivo
function editYaml(text, find) {
  const lines = text.split(/\r?\n/); if (lines[lines.length - 1] === "") lines.pop();
  const useful = (l) => l.trim() && !l.trim().startsWith("#");
  const ind = (l) => l.length - l.trimStart().length;
  const keyRe = /^(\s*(?:-\s+)?)(?:"([^"]+)"|'([^']+)'|([^\s"'#:][^:#]*?))\s*:(?=\s|$)\s*(.*)$/;
  const scalar = (v) => {
    if (typeof v !== "string") return String(v);
    if (typeof typed(v) !== "string") return v;
    return v === "" || /^[\s&*!|>'"%@`#{[\]-]|: |\s#|\s$|^(null|~|yes|no|on|off)$/i.test(v) ? JSON.stringify(v) : v;
  };
  const clean = (v) => v.replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2");
  // [from, to) é o bloco; devolve as linhas dos filhos diretos
  const kids = (from, to) => {
    let first = from; while (first < to && !useful(lines[first])) first++;
    if (first >= to) return { indent: null, items: [] };
    const indent = ind(lines[first]), items = [];
    for (let i = first; i < to; i++) if (useful(lines[i]) && ind(lines[i]) === indent) items.push(i);
    return { indent, items };
  };
  const blockEnd = (i, to) => {
    const base = ind(lines[i]), dash = lines[i].trimStart().startsWith("-");
    let j = i + 1; while (j < to && (!useful(lines[j]) || ind(lines[j]) > base || (!dash && ind(lines[j]) === base && lines[j].trimStart().startsWith("- ")))) j++;
    return j;
  };
  const walk = (from, to, toks, rule, indentHint) => {
    const [t, ...rest] = toks;
    const { indent, items } = kids(from, to);
    const idx = /^\[(\d+)\]$/.exec(t);
    if (idx) {
      const list = items.filter((i) => lines[i].trimStart().startsWith("- "));
      const at = list[Number(idx[1])]; if (at == null) return;
      // o item da lista: a primeira chave está na linha do traço
      const m = /^(\s*)-\s+(.*)$/.exec(lines[at]);
      const end = blockEnd(at, to);
      lines[at] = `${m[1]}  ${m[2]}`;
      walk(at, end, rest, rule, ind(lines[at]));
      lines[at] = lines[at].replace(new RegExp(`^${m[1]}  `), `${m[1]}- `);
      return;
    }
    const match = (i) => { const m = keyRe.exec(lines[i]); return m ? { m, key: m[2] || m[3] || m[4] } : null; };
    if (t === "*") {
      for (const i of [...items].reverse()) { if (!match(i)) continue; const end = blockEnd(i, to); if (rest.length) walk(i + 1, end, rest, rule, ind(lines[i]) + 2); }
      return;
    }
    const at = items.find((i) => { const x = match(i); return x && x.key === t; });
    if (at != null) {
      const { m } = match(at), end = blockEnd(at, to);
      if (rest.length) { if (m[5] && !m[5].startsWith("#")) { if (typeof rule === "object") return; lines[at] = lines[at].slice(0, lines[at].length - m[5].length).trimEnd(); } return walk(at + 1, end, rest, rule, ind(lines[at]) + 2); }
      const key = lines[at].slice(0, lines[at].length - m[5].length).trimEnd();
      lines[at] = `${key} ${scalar(typed(nextValue(rule, clean(m[5]))))}`;
      return;
    }
    if (typeof rule === "object") return; // só troca o que já existe
    const pad = " ".repeat(indent != null ? indent : indentHint);
    let pos = to; while (pos > from && !useful(lines[pos - 1])) pos--;
    const add = []; let p = pad;
    for (const k of [t, ...rest]) { if (k === "*" || /^\[/.test(k)) return; add.push(k); }
    const out = add.map((k, i) => { const l = `${p}${k}:${i === add.length - 1 ? " " + scalar(typed(rule)) : ""}`; p += "  "; return l; });
    lines.splice(pos, 0, ...out);
  };
  for (const [k, rule] of Object.entries(find)) walk(0, lines.length, pathTokens(k), rule, 0);
  return lines.join("\n") + "\n";
}
// XML por trechos (sem biblioteca): caminho a.b.c = <a><b><c>valor</c></b></a>
function editXml(text, find) {
  let x = text;
  const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const mask = (s) => s.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => " ".repeat(m.length));
  const open = (m, from, to, tag) => { const re = new RegExp(`<${reEsc(tag)}(\\s[^>]*?)?(/?)>`, "g"); re.lastIndex = from; const r = re.exec(m); return r && r.index < to ? r : null; };
  const closeOf = (m, from, tag) => {
    const re = new RegExp(`<(/?)${reEsc(tag)}(?:\\s[^>]*?)?(/?)>`, "g"); re.lastIndex = from; let depth = 1, r;
    while ((r = re.exec(m))) { if (r[2]) continue; depth += r[1] ? -1 : 1; if (!depth) return r.index; }
    return -1;
  };
  for (const [k, rule] of Object.entries(find)) {
    const toks = pathTokens(k); if (toks.some((t) => !/^[\w:.-]+$/.test(t))) continue;
    let from = 0, to = x.length, m = mask(x), i = 0;
    for (; i < toks.length; i++) {
      const r = open(m, from, to, toks[i]); if (!r) break;
      const after = r.index + r[0].length;
      if (r[2]) { // <tag/> vira <tag></tag>
        const whole = `<${toks[i]}${r[1] || ""}></${toks[i]}>`;
        x = x.slice(0, r.index) + whole + x.slice(after); m = mask(x);
        from = r.index + whole.length - toks[i].length - 3; to = from;
      } else { const c = closeOf(m, after, toks[i]); if (c < 0) break; from = after; to = c; }
    }
    if (i === toks.length) { const cur = x.slice(from, to).trim(); x = x.slice(0, from) + esc(nextValue(rule, cur)) + x.slice(to); continue; }
    if (typeof rule === "object") continue;
    const body = toks.slice(i).reduceRight((acc, t) => `<${t}>${acc}</${t}>`, esc(rule));
    x = x.slice(0, to) + body + x.slice(to);
  }
  return x;
}

const PARSERS = { properties: editProperties, file: editPlainFile, ini: editIni, json: editJson, yaml: editYaml, yml: editYaml, xml: editXml };

module.exports = { convert, load, save, remove, isPortVar, fill, PARSERS, slugOf };
