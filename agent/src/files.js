// Piphin Agent · arquivos de um servidor: tudo preso à pasta dele (nem "..", nem links simbólicos saem dela)
"use strict";
const fs = require("fs");
const path = require("path");

const MAX_EDIT = 5 * 1024 * 1024; // arquivos de texto abertos no editor

function bad(msg, status = 400) { return Object.assign(new Error(msg), { status }); }

// caminho relativo vindo do painel -> caminho real dentro de root
function resolve(root, rel) {
  rel = String(rel || "/").replace(/\\/g, "/");
  if (rel.includes("\0")) throw bad("Caminho inválido");
  const full = path.resolve(root, "." + path.posix.normalize("/" + rel));
  if (full !== root && !full.startsWith(root + path.sep)) throw bad("Caminho fora do servidor", 403);
  return full;
}
// o que existe no caminho não pode apontar para fora (link simbólico criado pelo servidor)
async function real(root, full) {
  let p = full;
  for (;;) {
    try {
      const r = await fs.promises.realpath(p);
      const rr = await fs.promises.realpath(root);
      if (r !== rr && !r.startsWith(rr + path.sep)) throw bad("Caminho fora do servidor", 403);
      return;
    } catch (e) {
      if (e.status) throw e;
      if (e.code !== "ENOENT") throw e;
      const up = path.dirname(p); if (up === p) return; p = up; // ainda não existe: confere a pasta de cima
    }
  }
}
const relOf = (root, full) => "/" + path.relative(root, full).split(path.sep).join("/");

async function list(root, rel) {
  const dir = resolve(root, rel); await real(root, dir);
  const items = await fs.promises.readdir(dir, { withFileTypes: true }).catch((e) => { if (e.code === "ENOENT") throw bad("Pasta não encontrada", 404); throw e; });
  const out = [];
  for (const e of items) {
    const p = path.join(dir, e.name);
    let st; try { st = await fs.promises.lstat(p); } catch { continue; }
    out.push({ name: e.name, dir: st.isDirectory(), link: st.isSymbolicLink(), size: st.isFile() ? st.size : 0, mtime: st.mtimeMs, mode: (st.mode & 0o777).toString(8) });
  }
  out.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  return { path: relOf(root, dir), items: out };
}
async function read(root, rel) {
  const f = resolve(root, rel); await real(root, f);
  const st = await fs.promises.stat(f).catch(() => { throw bad("Arquivo não encontrado", 404); });
  if (!st.isFile()) throw bad("Não é um arquivo");
  if (st.size > MAX_EDIT) throw bad("Arquivo grande demais para abrir aqui (mais de 5 MB). Baixe para editar.");
  const buf = await fs.promises.readFile(f);
  if (buf.subarray(0, 8000).includes(0)) throw bad("Este arquivo não é de texto. Baixe para abrir.");
  return { path: relOf(root, f), content: buf.toString("utf8"), size: st.size, mtime: st.mtimeMs };
}
async function write(root, rel, content) {
  const f = resolve(root, rel); await real(root, f);
  await fs.promises.mkdir(path.dirname(f), { recursive: true });
  await fs.promises.writeFile(f, String(content));
  return true;
}
async function mkdir(root, rel) { const d = resolve(root, rel); await real(root, d); await fs.promises.mkdir(d, { recursive: true }); return true; }
async function rename(root, from, to) {
  const a = resolve(root, from), b = resolve(root, to);
  if (a === root) throw bad("Não dá para renomear a pasta principal");
  await real(root, a); await real(root, b);
  if (fs.existsSync(b)) throw bad("Já existe um item com esse nome");
  await fs.promises.mkdir(path.dirname(b), { recursive: true });
  await fs.promises.rename(a, b);
  return true;
}
async function remove(root, rels) {
  for (const rel of [].concat(rels)) {
    const p = resolve(root, rel);
    if (p === root) throw bad("Não dá para apagar a pasta principal");
    await real(root, path.dirname(p));
    await fs.promises.rm(p, { recursive: true, force: true });
  }
  return true;
}
// envio: o corpo do pedido vai direto para o arquivo
async function upload(root, rel, req, maxBytes) {
  const f = resolve(root, rel); await real(root, f);
  await fs.promises.mkdir(path.dirname(f), { recursive: true });
  const tmp = f + ".piphin-upload";
  let size = 0;
  await new Promise((resolveP, reject) => {
    const out = fs.createWriteStream(tmp);
    req.on("data", (c) => { size += c.length; if (size > maxBytes) { req.destroy(); out.destroy(); reject(bad("Arquivo grande demais")); } });
    req.pipe(out);
    out.on("finish", resolveP); out.on("error", reject); req.on("error", reject);
  }).catch(async (e) => { await fs.promises.rm(tmp, { force: true }); throw e; });
  await fs.promises.rename(tmp, f);
  return { size };
}
async function stream(root, rel) {
  const f = resolve(root, rel); await real(root, f);
  const st = await fs.promises.stat(f).catch(() => { throw bad("Arquivo não encontrado", 404); });
  if (!st.isFile()) throw bad("Não é um arquivo");
  return { size: st.size, name: path.basename(f), stream: fs.createReadStream(f) };
}

module.exports = { resolve, list, read, write, mkdir, rename, remove, upload, stream };
