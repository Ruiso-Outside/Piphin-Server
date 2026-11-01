// Piphin Agent · modelos de servidor (agent/templates/*.js): imagem, script de instalação, linha de início, portas e variáveis.
"use strict";
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "templates");
let cache = null;
function all() {
  if (cache) return cache;
  cache = fs.readdirSync(DIR).filter((f) => f.endsWith(".js") && !f.startsWith("_")).map((f) => require(path.join(DIR, f))).sort((a, b) => (a.order || 99) - (b.order || 99));
  return cache;
}
const get = (id) => all().find((t) => t.id === id) || null;

// o que vai para o painel (sem os scripts)
const pub = (t) => ({ id: t.id, name: t.name, category: t.category, description: t.description, icon: t.icon, image: t.image, images: t.images || null,
  ports: (t.ports || []).map((p) => ({ name: p.name, protocol: p.protocol || "tcp", default: p.default || (typeof p.container === "number" ? p.container : 0) })),
  vars: (t.vars || []).map(({ key, name, description, type, default: d, options, required, min, max }) => ({ key, name, description, type: type || "text", default: d ?? "", options, required: !!required, min, max })),
  limits: t.limits || {}, editableStartup: !!t.editableStartup, startup: t.editableStartup ? t.startup : undefined, notes: t.notes || "" });

// valida e completa as variáveis (texto sempre); partial = mudando um servidor já criado
function resolveVars(t, given, partial = false) {
  const out = {};
  for (const v of t.vars || []) {
    let x = given[v.key];
    if (x === undefined || x === null || x === "") x = v.default ?? "";
    if (v.type === "bool") x = x === true || x === "true" || x === "1" ? "true" : "false";
    else x = String(x).replace(/[\r\n]/g, " ").trim();
    if (v.type === "number" && x !== "") {
      const n = Number(x);
      if (!isFinite(n)) throw new Error(`${v.name}: precisa ser um número`);
      if (v.min != null && n < v.min) throw new Error(`${v.name}: no mínimo ${v.min}`);
      if (v.max != null && n > v.max) throw new Error(`${v.name}: no máximo ${v.max}`);
    }
    if (v.type === "select" && v.options && x !== "" && !v.options.some((o) => String(o.value) === x)) throw new Error(`${v.name}: opção inválida`);
    if (v.required && x === "" && !partial) throw new Error(`Preencha: ${v.name}`);
    if (v.mustBe != null && x !== String(v.mustBe)) throw new Error(v.mustBeMessage || `${v.name}: valor obrigatório`);
    if (v.minLength && x.length && x.length < v.minLength) throw new Error(`${v.name}: pelo menos ${v.minLength} caracteres`);
    out[v.key] = x;
  }
  for (const [k, x] of Object.entries(given)) if (!(k in out) && /^[A-Z][A-Z0-9_]{0,40}$/.test(k) && t.id === "custom") out[k] = String(x);
  return out;
}

module.exports = { all, get, pub, resolveVars };
