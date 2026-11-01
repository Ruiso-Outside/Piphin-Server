// Piphin Server · tela. Máquinas (com o Piphin Agent) e seus servidores: painel, console ao vivo, arquivos, backups,
// agendamentos e configurações. Tudo passa pelo backend do módulo (canais em module/backend.js).
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const call = async (ch, ...a) => { const r = await piphin.invoke(ch, ...a); if (!r.ok) throw new Error(r.error); return r.data; };
const num = (v, d = 0) => (v == null || isNaN(v) ? "--" : Number(v).toLocaleString("pt-BR", { maximumFractionDigits: d }));
// base 1024, como o Windows mostra (4096 MB = 4 GB)
const K = 1024;
const bytes = (n) => (n == null ? "--" : n >= K ** 4 ? `${num(n / K ** 4, 1)} TB` : n >= K ** 3 ? `${num(n / K ** 3, 1)} GB` : n >= K ** 2 ? `${num(n / K ** 2, 0)} MB` : n >= K ? `${num(n / K, 0)} KB` : `${num(n)} B`);
const rate = (b) => { const x = (b || 0) * 8; return x >= 1e6 ? `${num(x / 1e6, 1)} Mbps` : `${num(x / 1e3, 0)} kbps`; };
const ago = (t) => new Date(t).toLocaleString("pt-BR");
function uptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}
const STATE = { running: "Rodando", starting: "Iniciando", stopping: "Parando", offline: "Desligado", installing: "Instalando", install_failed: "Instalação falhou" };
const CATS = [["jogos", "Jogos", "gamepad-2"], ["bots", "Bots", "bot"], ["sites", "Sites e apps", "globe"], ["bancos", "Bancos de dados", "database"], ["outros", "Outros", "box"], ["eggs", "Eggs", "egg"]];
const EGG_GROUPS = [["", "Todos"], ["games", "Jogos"], ["applications", "Aplicativos"], ["generic", "Linguagens"]];
const EGG_MIN_AGENT = "1.1.0";
const olderThan = (v, min) => { const a = String(v || "0").split(".").map(Number), b = min.split(".").map(Number); for (let i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) < b[i]; return false; };
const protoName = (p) => (p === "both" ? "TCP+UDP" : String(p).toUpperCase());

const S = { nodes: [], servers: {}, templates: {}, view: { kind: "home" }, tab: "console", nodeInfo: null, nodeStats: null,
  srv: null, console: [], stats: null, files: null, filesPath: "/", backups: null, cmdHistory: [], cmdIdx: -1, busy: {} };

// ---------------------------------------------------------------- avisos e diálogos
function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind; el.textContent = text;
  $("#toasts").appendChild(el); setTimeout(() => el.remove(), 4200);
}
const modal = $("#modal"), box = $("#modalBox");
const openModal = (html, cls = "") => { box.className = "modal-box " + cls; box.innerHTML = html; modal.hidden = false; };
const closeModal = () => { modal.hidden = true; box.innerHTML = ""; };
modal.addEventListener("mousedown", (e) => { if (e.target === modal && !box.querySelector("[data-sticky]")) closeModal(); });
const confirmBox = (title, text, yes = "Continuar", danger = false) => new Promise((resolve) => {
  openModal(`<h3>${esc(title)}</h3><p class="muted">${esc(text)}</p><div class="modal-actions"><button class="btn" data-n>Cancelar</button><button class="btn ${danger ? "danger solid" : "primary"}" data-y>${esc(yes)}</button></div>`);
  box.querySelector("[data-y]").onclick = () => { closeModal(); resolve(true); };
  box.querySelector("[data-n]").onclick = () => { closeModal(); resolve(false); };
});
const promptBox = (title, label, value = "") => new Promise((resolve) => {
  openModal(`<h3>${esc(title)}</h3><div class="form"><label>${esc(label)}<input type="text" id="pIn" value="${esc(value)}" maxlength="200"></label></div>
    <div class="modal-actions"><button class="btn" data-n>Cancelar</button><button class="btn primary" data-y>OK</button></div>`);
  // OK com o campo vazio devolve ""; Cancelar devolve null
  const ok = () => { const v = $("#pIn").value.trim(); closeModal(); resolve(v); };
  box.querySelector("[data-y]").onclick = ok;
  box.querySelector("[data-n]").onclick = () => { closeModal(); resolve(null); };
  $("#pIn").onkeydown = (e) => { if (e.key === "Enter") ok(); };
  setTimeout(() => $("#pIn").select(), 0);
});
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, "err"); } };
const copy = (t) => { navigator.clipboard.writeText(t).then(() => toast("Copiado", "ok")).catch(() => {}); };

// ---------------------------------------------------------------- dados
const nodeOf = (id) => S.nodes.find((n) => n.id === id);
const srvList = (id) => S.servers[id] || [];
const curNode = () => nodeOf(S.view.node);
async function loadNodes() {
  S.nodes = await call("nodes");
  await Promise.all(S.nodes.map((n) => loadServers(n.id)));
  renderSide();
}
async function loadServers(id) {
  try { S.servers[id] = await call("servers", id); const n = nodeOf(id); if (n) n.online = true; } catch { S.servers[id] = S.servers[id] || []; }
}
async function templatesOf(id) { if (!S.templates[id]) S.templates[id] = await call("templates", id); return S.templates[id]; }
const addrOf = (s, n) => (s.ports && s.ports[0] && n ? `${n.host}:${s.ports[0].host}` : "");

// ---------------------------------------------------------------- eventos ao vivo
piphin.on("agent-event", ({ node, type, data }) => {
  if (type === "line" && S.view.kind === "server" && S.view.node === node && S.view.server === data.id) appendLine(data);
  if (type === "state") {
    const s = srvList(node).find((x) => x.id === data.id);
    if (s) { s.state = data.state; renderSide(); }
    if (S.view.kind === "server" && S.view.server === data.id && S.srv) { S.srv.state = data.state; renderHeader(); }
    if (S.view.kind === "node" && S.view.node === node) renderMain();
  }
  if (type === "changed") changedSoon(node, data);
});
let changedTimer = null;
function changedSoon(node, data) {
  clearTimeout(changedTimer);
  changedTimer = setTimeout(guard(async () => {
    await loadServers(node); renderSide();
    if (S.view.kind === "server" && S.view.server === data.id) {
      if (data.removed) return show("node", node);
      S.srv = srvList(node).find((x) => x.id === data.id) || S.srv; renderHeader();
    } else if (S.view.kind === "node" && S.view.node === node) renderMain();
  }), 250);
}
piphin.on("node-status", ({ id, online }) => { const n = nodeOf(id); if (!n) return; n.online = online; if (online) loadServers(id).then(renderSide); renderSide(); if (S.view.node === id && S.view.kind === "node") renderMain(); });
piphin.on("transfer", (t) => {
  const el = $("#transfer");
  el.hidden = !!t.finished;
  el.innerHTML = `<div class="row"><i class="i i-${t.finished ? "check" : "upload"}"></i><span class="grow" data-noi18n style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</span><span>${t.total ? Math.round((t.done / t.total) * 100) : 0}%</span></div>
    <div class="bar"><i style="width:${t.total ? (t.done / t.total) * 100 : 0}%"></i></div><span class="faint">${bytes(t.done)} de ${bytes(t.total)}</span>`;
  if (t.finished && S.view.kind === "server" && S.tab === "files") loadFiles(S.filesPath);
});

// ---------------------------------------------------------------- navegação
let poll = null;
function show(kind, node = null, server = null, tab = null) {
  S.view = { kind, node, server };
  if (tab) S.tab = tab; else if (kind === "server") S.tab = "console";
  clearInterval(poll); poll = null;
  S.nodeInfo = S.nodeStats = null; S.srv = null; S.console = []; S.stats = null; S.files = null; S.backups = null; S.filesPath = "/";
  renderSide(); renderMain();
  if (kind === "node") { loadNode(); poll = setInterval(() => refreshNodeStats(), 3000); }
  if (kind === "server") { loadServer(); poll = setInterval(() => refreshServerStats(), 3000); }
}
const loadNode = guard(async () => {
  const id = S.view.node;
  const [info] = await Promise.all([call("node-info", id), loadServers(id)]);
  if (S.view.node !== id) return;
  S.nodeInfo = info; renderMain(); refreshNodeStats();
});
async function refreshNodeStats() {
  if (S.view.kind !== "node") return;
  try { S.nodeStats = await call("node-stats", S.view.node); const n = curNode(); if (n && !n.online) { n.online = true; renderSide(); } paintNodeStats(); } catch { /* fora do ar */ }
}
const loadServer = guard(async () => {
  const { node, server } = S.view;
  const [srv, con] = await Promise.all([call("server-get", { node, server }), call("server-console", { node, server })]);
  if (S.view.server !== server) return;
  S.srv = srv; S.console = con;
  await templatesOf(node).catch(() => {});
  renderMain();
  refreshServerStats();
});
async function refreshServerStats() {
  if (S.view.kind !== "server" || !S.srv) return;
  try { S.stats = await call("server-stats", { node: S.view.node, server: S.view.server }); paintServerStats(); } catch { /* sem números */ }
}

// ---------------------------------------------------------------- lateral
function renderSide() {
  const v = S.view;
  $("#side").innerHTML = `<div class="side-head"><i class="i i-server"></i>Piphin Server</div>
    <div class="side-list">
      ${S.nodes.map((n) => `<button class="side-node ${v.kind === "node" && v.node === n.id ? "on" : ""}" data-node="${n.id}"><span class="dot ${n.online ? "on" : ""}"></span><span class="nm" data-noi18n>${esc(n.name)}</span><i class="i i-hard-drive"></i></button>
        ${srvList(n.id).map((s) => `<button class="side-srv ${v.kind === "server" && v.server === s.id ? "on" : ""}" data-node="${n.id}" data-srv="${s.id}" title="${esc(STATE[s.state] || s.state)}"><span class="dot ${s.state}"></span><span class="nm" data-noi18n>${esc(s.name)}</span></button>`).join("")}`).join("")}
      ${!S.nodes.length ? `<p class="faint" style="padding:10px">Nenhuma máquina ainda.</p>` : ""}
    </div>
    <div class="side-foot"><button class="btn" data-act="add-node"><i class="i i-plus"></i>Adicionar máquina</button></div>`;
}
$("#side").addEventListener("click", (e) => {
  const s = e.target.closest("[data-srv]"), n = e.target.closest("[data-node]");
  if (s) return show("server", s.dataset.node, s.dataset.srv);
  if (n) return show("node", n.dataset.node);
});

// ---------------------------------------------------------------- telas
function renderMain() {
  const v = S.view;
  const html = v.kind === "node" ? nodeView() : v.kind === "server" ? serverView() : home();
  $("#main").innerHTML = `<div class="wrap">${html}</div>`;
  if (v.kind === "server") { paintConsole(); paintServerStats(); if (S.tab === "files" && !S.files) loadFiles(S.filesPath); if (S.tab === "backups" && !S.backups) loadBackups(); if (S.tab === "schedules") fillNextRuns(); }
  if (v.kind === "node") paintNodeStats();
}
function home() {
  if (S.nodes.length) {
    const all = S.nodes.flatMap((n) => srvList(n.id).map((s) => ({ ...s, n })));
    return `<div class="head"><div class="ic"><i class="i i-server"></i></div><div class="grow"><h1 class="t">Seus servidores</h1><div class="sub">${S.nodes.length === 1 ? "1 máquina" : `${S.nodes.length} máquinas`} · ${all.length === 1 ? "1 servidor" : `${all.length} servidores`}</div></div>
      <button class="btn" data-act="add-node"><i class="i i-plus"></i>Adicionar máquina</button></div>
      <div class="srv-grid">${all.map((s) => srvCard(s, s.n)).join("")}${S.nodes.map((n) => `<div class="srv-card add" data-act="new-server" data-node-id="${n.id}"><i class="i i-plus"></i><b>Novo servidor</b><span class="meta" data-noi18n>${esc(n.name)}</span></div>`).join("")}</div>`;
  }
  return `<div class="welcome"><div class="hero"><div class="ic"><i class="i i-server"></i></div><h1>Seus próprios servidores</h1>
      <p>Transforme um PC com Ubuntu Server da sua rede numa máquina de hospedagem: servidores de Minecraft, Terraria e Valheim, bots do Discord, sites, APIs e bancos de dados. Cada servidor roda isolado (Docker), com console, arquivos, backups e agendamentos aqui no Hub.</p></div>
    ${addNodeSteps()}</div>`;
}
function addNodeSteps() {
  return `<div class="card"><div class="steps">
    <div class="step"><div><b>Instale o Piphin Agent no Ubuntu Server</b><p class="faint" style="margin:4px 0 10px">No terminal da máquina (ou por SSH), rode este comando. Ele instala o Docker se faltar, o agente e mostra um código.</p>
      <div class="cmdbox"><code id="installCmd" data-noi18n>...</code><button class="btn sm" data-act="copy-install"><i class="i i-copy"></i>Copiar</button></div></div></div>
    <div class="step"><div><b>Encontre a máquina</b><p class="faint" style="margin:4px 0 10px">Ela aparece aqui se estiver na mesma rede. Ou digite o endereço mostrado pelo instalador.</p>
      <div class="row" style="margin-bottom:10px"><button class="btn" data-act="discover"><i class="i i-radar"></i>Procurar na rede</button><span class="faint" id="discStatus"></span></div>
      <div class="found" id="found"></div></div></div>
    <div class="step"><div><b>Digite o código</b><div class="form" style="margin-top:8px"><div class="two">
        <label>Endereço da máquina<input type="text" id="pairHost" placeholder="192.168.0.50" data-noi18n></label>
        <label>Código de pareamento<input type="text" id="pairCode" placeholder="ABCD-2345" maxlength="9" style="text-transform:uppercase;font-family:var(--p-mono)"></label></div>
        <div><button class="btn violet big" data-act="pair"><i class="i i-link"></i>Parear</button></div>
        <span class="faint">Para um código novo, rode na máquina: sudo piphin-agent pair</span></div></div></div>
  </div></div>`;
}
const srvCard = (s, n) => `<div class="srv-card" data-open-srv="${s.id}" data-node-id="${n.id}"><div class="top"><div class="ic"><i class="i i-${esc(s.icon || "box")}"></i></div>
    <div class="grow"><b data-noi18n>${esc(s.name)}</b><div class="meta">${esc(s.templateName)}</div></div></div>
  <div class="row"><span class="pill ${s.state}">${esc(STATE[s.state] || s.state)}</span><span class="grow"></span><span class="faint mono" data-noi18n>${esc(addrOf(s, n))}</span></div></div>`;

// ---------------------------------------------------------------- máquina
function nodeView() {
  const n = curNode(); if (!n) return "";
  const i = S.nodeInfo, list = srvList(n.id);
  return `<div class="head"><div class="ic"><i class="i i-hard-drive"></i></div>
      <div class="grow"><h1 class="t" data-noi18n>${esc(n.name)}</h1><div class="sub"><span class="pill ${n.online ? "running" : "offline"}">${n.online ? "Online" : "Fora do ar"}</span>
        <span class="mono" data-noi18n>${esc(n.host)}:${n.port}</span>${i ? `<span>Piphin Agent ${esc(i.version)}</span>` : ""}</div></div>
      <button class="btn" data-act="rename-node"><i class="i i-pencil"></i>Renomear</button>
      <button class="btn ghost" data-act="remove-node" title="Esquecer esta máquina"><i class="i i-trash-2"></i></button></div>
    ${i && !i.docker.ok ? `<div class="card danger row"><i class="i i-triangle-alert" style="color:var(--bad)"></i><div class="grow"><b>O Docker não está funcionando nesta máquina</b><div class="faint" data-noi18n>${esc(i.docker.error || "")}</div></div></div>` : ""}
    <div class="stats" id="nodeStats">${statCard("cpu", "Processador", "--", 0)}${statCard("memory-stick", "Memória", "--", 0)}${statCard("hard-drive", "Disco", "--", 0)}${statCard("activity", "Rede", "--", -1)}</div>
    <div><div class="row" style="margin-bottom:12px"><h3 class="h grow" style="margin:0"><i class="i i-layout-grid"></i>Servidores</h3><button class="btn violet" data-act="new-server" ${n.online ? "" : "disabled"}><i class="i i-plus"></i>Novo servidor</button></div>
      <div class="srv-grid">${list.map((s) => srvCard(s, n)).join("")}<div class="srv-card add" data-act="new-server"><i class="i i-plus"></i><b>Novo servidor</b><span class="meta">Jogos, sites, bots e bancos de dados</span></div></div></div>
    ${i ? `<div class="card"><h3 class="h"><i class="i i-info"></i>Máquina</h3><dl class="kv">
      <dt>Sistema</dt><dd data-noi18n>${esc(i.info.os)}</dd><dt>Processador</dt><dd><span data-noi18n>${esc(i.info.cpu)}</span> · ${i.info.cores === 1 ? "1 núcleo" : `${i.info.cores} núcleos`}</dd>
      <dt>Memória</dt><dd>${bytes(i.info.memory)}</dd><dt>Ligada há</dt><dd>${uptime(i.info.uptime)}</dd>
      <dt>Endereços</dt><dd class="mono" data-noi18n>${esc(i.info.addresses.map((a) => a.ip).join(", "))}</dd><dt>Docker</dt><dd>${i.docker.ok ? esc(i.docker.version) : "não está rodando"}</dd>
      <dt>Hubs pareados</dt><dd>${i.clients.length}</dd></dl></div>` : ""}`;
}
const statCard = (ic, label, val, pct) => `<div class="stat"><div class="top"><i class="i i-${ic}"></i>${esc(label)}</div><b>${val}</b>${pct >= 0 ? `<div class="bar"><i style="width:${pct}%"></i></div>` : `<span class="faint">&nbsp;</span>`}</div>`;
function paintNodeStats() {
  const el = $("#nodeStats"), st = S.nodeStats; if (!el || !st) return;
  const color = (p) => (p > 90 ? "var(--bad)" : p > 70 ? "var(--warn)" : "var(--sv)");
  const mem = st.memory, d = st.disk;
  const memP = mem.total ? (mem.used / mem.total) * 100 : 0, diskP = d && d.total ? (d.used / d.total) * 100 : 0;
  el.innerHTML = `<div class="stat"><div class="top"><i class="i i-cpu"></i>Processador</div><b>${num(st.cpu || 0, 1)}%</b><div class="bar"><i style="width:${st.cpu || 0}%;--c:${color(st.cpu)}"></i></div></div>
    <div class="stat"><div class="top"><i class="i i-memory-stick"></i>Memória</div><b>${bytes(mem.used)} <span class="faint">de ${bytes(mem.total)}</span></b><div class="bar"><i style="width:${memP}%;--c:${color(memP)}"></i></div></div>
    <div class="stat"><div class="top"><i class="i i-hard-drive"></i>Disco</div><b>${d ? `${bytes(d.free)} <span class="faint">livres</span>` : "--"}</b><div class="bar"><i style="width:${diskP}%;--c:${color(diskP)}"></i></div></div>
    <div class="stat"><div class="top"><i class="i i-activity"></i>Rede</div><b style="font-size:15px">↓ ${st.net ? rate(st.net.rx) : "--"} · ↑ ${st.net ? rate(st.net.tx) : "--"}</b><span class="faint">${num(st.load[0], 2)} de carga</span></div>`;
}

// ---------------------------------------------------------------- servidor
const TABS = [["console", "terminal", "Console"], ["files", "folder", "Arquivos"], ["backups", "archive", "Backups"], ["schedules", "calendar-clock", "Agendamentos"], ["settings", "settings", "Configurações"]];
function serverView() {
  const s = S.srv;
  if (!s) return `<div class="card row"><span class="spin"></span><span class="muted">Carregando o servidor...</span></div>`;
  return `<div id="srvHead">${headerHtml()}</div>
    <div class="tabs">${TABS.map(([k, ic, t]) => `<button class="${S.tab === k ? "on" : ""}" data-tab="${k}"><i class="i i-${ic}"></i>${t}</button>`).join("")}</div>
    <div id="tabBody">${({ console: consoleTab, files: filesTab, backups: backupsTab, schedules: schedulesTab, settings: settingsTab })[S.tab]()}</div>`;
}
function headerHtml() {
  const s = S.srv, n = curNode(), st = s.state, addr = addrOf(s, n);
  const on = st === "running" || st === "starting", busy = st === "stopping" || st === "installing";
  return `<div class="head"><div class="ic"><i class="i i-${esc(s.icon || "box")}"></i></div>
    <div class="grow"><h1 class="t" data-noi18n>${esc(s.name)}</h1><div class="sub"><span class="pill ${st}">${esc(STATE[st] || st)}</span><span>${esc(s.templateName)}</span>
      ${addr ? `<span class="mono copy" data-copy="${esc(addr)}" title="Copiar o endereço" data-noi18n>${esc(addr)}</span>` : ""}<span class="faint" data-noi18n>${esc(n ? n.name : "")}</span></div></div>
    <div class="power">
      <button class="btn go" data-power="start" ${on || busy || st === "install_failed" ? "disabled" : ""}><i class="i i-play"></i>Ligar</button>
      <button class="btn" data-power="restart" ${!on || busy ? "disabled" : ""}><i class="i i-rotate-ccw"></i>Reiniciar</button>
      <button class="btn halt" data-power="stop" ${!on ? "disabled" : ""}><i class="i i-square"></i>Desligar</button>
      <button class="btn ghost" data-power="kill" ${!on && st !== "stopping" ? "disabled" : ""} title="Forçar a parada (sem salvar)"><i class="i i-zap"></i></button>
    </div></div>`;
}
function renderHeader() { const h = $("#srvHead"); if (h && S.srv) h.innerHTML = headerHtml(); const ci = $("#cmdIn"); if (ci) ci.disabled = !(S.srv.state === "running" || S.srv.state === "starting"); }

// ---------------- console
function consoleTab() {
  const on = S.srv.state === "running" || S.srv.state === "starting";
  return `<div class="mini-stats" id="srvStats"></div>
    <div class="console" style="margin-top:12px"><div class="console-log" id="log"></div>
      <div class="console-in"><i class="i i-terminal"></i><input type="text" id="cmdIn" placeholder="Digite um comando e aperte Enter" ${on ? "" : "disabled"} autocomplete="off" spellcheck="false" data-noi18n></div></div>`;
}
// só as mensagens do próprio agente (sys) passam pela tradução; a saída dos programas fica como veio
const lineHtml = (l) => `<div class="${l.k === "sys" ? "sys" : l.k === "install" ? "install" : l.k === "cmd" ? "cmd" : /error|exception|fatal|\bfailed\b/i.test(l.s) ? "err" : ""}"${l.k === "sys" ? "" : " data-noi18n"}>${esc(l.s)}</div>`;
function paintConsole() {
  const el = $("#log"); if (!el) return;
  el.innerHTML = S.console.map(lineHtml).join("") || `<div class="sys">Nada no console ainda.</div>`;
  el.scrollTop = el.scrollHeight;
  const ci = $("#cmdIn"); if (ci && !ci.disabled) ci.focus();
}
function appendLine(l) {
  S.console.push(l); if (S.console.length > 2000) S.console.shift();
  const el = $("#log"); if (!el) return;
  const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.insertAdjacentHTML("beforeend", lineHtml(l));
  while (el.childElementCount > 2000) el.firstElementChild.remove();
  if (stick) el.scrollTop = el.scrollHeight;
}
function paintServerStats() {
  const el = $("#srvStats"); if (!el || !S.srv) return;
  const st = S.stats && S.stats.stats, disk = S.stats && S.stats.disk, L = S.srv.limits || {};
  const memMax = L.memory ? L.memory * 1048576 : st && st.memoryLimit, memP = st && memMax ? Math.min(100, (st.memory / memMax) * 100) : 0;
  const diskP = disk && L.disk ? Math.min(100, (disk.used / (L.disk * 1048576)) * 100) : 0;
  const cpuMax = L.cpu ? L.cpu * 100 : 100 * ((S.nodeInfo && S.nodeInfo.info.cores) || 1);
  el.innerHTML = `<div class="stat"><div class="top"><i class="i i-cpu"></i>Processador</div><b>${st ? `${num(st.cpu, 1)}%` : "--"}</b><div class="bar"><i style="width:${st ? Math.min(100, (st.cpu / cpuMax) * 100) : 0}%"></i></div></div>
    <div class="stat"><div class="top"><i class="i i-memory-stick"></i>Memória</div><b>${st ? bytes(st.memory) : "--"} <span class="faint">${L.memory ? `de ${bytes(L.memory * 1048576)}` : ""}</span></b><div class="bar"><i style="width:${memP}%"></i></div></div>
    <div class="stat"><div class="top"><i class="i i-hard-drive"></i>Disco</div><b>${disk ? bytes(disk.used) : "--"} <span class="faint">${L.disk ? `de ${bytes(L.disk * 1048576)}` : ""}</span></b><div class="bar"><i style="width:${diskP}%"></i></div></div>
    <div class="stat"><div class="top"><i class="i i-clock"></i>Ligado há</div><b>${S.srv.state === "running" && S.srv.startedAt ? uptime((Date.now() - S.srv.startedAt) / 1000) : "--"}</b><span class="faint">${st ? `↓ ${bytes(st.net.rx)} · ↑ ${bytes(st.net.tx)}` : "&nbsp;"}</span></div>`;
}

// ---------------- arquivos
function filesTab() {
  const f = S.files, parts = S.filesPath.split("/").filter(Boolean);
  return `<div class="files" style="display:grid;gap:12px">
    <div class="row"><div class="crumbs grow"><button data-dir="/"><i class="i i-house"></i></button>${parts.map((p, i) => `<i class="i i-chevron-right faint"></i><button data-dir="/${esc(parts.slice(0, i + 1).join("/"))}" data-noi18n>${esc(p)}</button>`).join("")}</div>
      <button class="btn sm" data-act="new-folder"><i class="i i-folder-plus"></i>Nova pasta</button>
      <button class="btn sm" data-act="new-file"><i class="i i-file-plus"></i>Novo arquivo</button>
      <button class="btn sm" data-act="upload"><i class="i i-upload"></i>Enviar</button>
      <button class="btn sm ghost" data-act="refresh-files" title="Atualizar"><i class="i i-refresh-cw"></i></button></div>
    <div class="flist" id="flist">${!f ? `<div class="empty"><span class="spin"></span></div>` : !f.items.length ? `<div class="empty">Pasta vazia. Arraste arquivos do Windows para cá.</div>` : f.items.map((x) => `
      <div class="frow" data-${x.dir ? "dir" : "file"}="${esc(path(f.path, x.name))}"><i class="i i-${x.dir ? "folder" : /\.(txt|json|ya?ml|properties|cfg|conf|ini|toml|js|ts|py|php|html|css|md|sh|env|log|xml)$/i.test(x.name) ? "file-text" : "file"}"></i>
        <span class="nm" data-noi18n>${esc(x.name)}</span><span class="faint">${x.dir ? "" : bytes(x.size)}</span><span class="faint">${ago(x.mtime)}</span>
        <span class="acts">${x.dir ? "" : `<button class="btn sm icon ghost" data-dl="${esc(path(f.path, x.name))}" title="Baixar"><i class="i i-download"></i></button>`}
          <button class="btn sm icon ghost" data-ren="${esc(path(f.path, x.name))}" title="Renomear"><i class="i i-pencil"></i></button>
          <button class="btn sm icon ghost" data-del="${esc(path(f.path, x.name))}" title="Apagar"><i class="i i-trash-2"></i></button></span></div>`).join("")}</div>
    <span class="faint">Arraste arquivos do Windows para a lista para enviar (até 512 MB cada; maiores pelo botão Enviar).</span></div>`;
}
const path = (dir, name) => (dir === "/" ? "/" + name : dir + "/" + name);
const loadFiles = guard(async (p) => {
  S.filesPath = p || "/"; S.files = null; if (S.tab === "files") $("#tabBody").innerHTML = filesTab();
  S.files = await call("files", { node: S.view.node, server: S.view.server, path: S.filesPath });
  if (S.tab === "files") $("#tabBody").innerHTML = filesTab();
});
const openEditor = guard(async (p) => {
  const f = await call("file-read", { node: S.view.node, server: S.view.server, path: p });
  openModal(`<div class="row" style="margin-bottom:10px"><h3 class="grow" style="margin:0" data-noi18n>${esc(p)}</h3><span class="faint">Ctrl+S salva</span></div>
    <textarea class="editor" id="edit" spellcheck="false" data-noi18n data-sticky>${esc(f.content)}</textarea>
    <div class="modal-actions"><button class="btn" data-x>Fechar</button><button class="btn primary" data-save><i class="i i-save"></i>Salvar</button></div>`, "wide");
  const ed = $("#edit"), save = guard(async () => { await call("file-write", { node: S.view.node, server: S.view.server, path: p, content: ed.value }); toast("Salvo", "ok"); });
  ed.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    if (e.key === "Tab") { e.preventDefault(); const a = ed.selectionStart; ed.setRangeText("  ", a, ed.selectionEnd, "end"); }
  });
  box.querySelector("[data-save]").onclick = save;
  box.querySelector("[data-x]").onclick = closeModal;
});

// ---------------- backups
function backupsTab() {
  const b = S.backups;
  return `<div class="card"><div class="row" style="margin-bottom:12px"><h3 class="h grow" style="margin:0"><i class="i i-archive"></i>Backups</h3>
      <button class="btn violet" data-act="backup-now" ${S.busy.backup ? "disabled" : ""}>${S.busy.backup ? `<span class="spin"></span>Fazendo o backup...` : `<i class="i i-plus"></i>Fazer backup agora`}</button></div>
    <p class="faint" style="margin:0 0 10px">Uma cópia de todos os arquivos do servidor, guardada na própria máquina. Os backups automáticos (agendados) guardam os 7 mais novos.</p>
    ${!b ? `<div class="empty"><span class="spin"></span></div>` : !b.length ? `<div class="empty">Nenhum backup ainda.</div>` : `<table class="table"><thead><tr><th>Quando</th><th>Tamanho</th><th>Nota</th><th></th></tr></thead><tbody>
      ${b.map((x) => `<tr><td>${ago(x.at)}</td><td>${bytes(x.size)}</td><td>${x.auto ? `<span class="badge">automático</span> ` : ""}<span data-noi18n>${esc(x.note)}</span></td>
        <td style="text-align:right;white-space:nowrap"><button class="btn sm" data-restore="${x.id}"><i class="i i-rotate-ccw"></i>Restaurar</button>
          <button class="btn sm icon ghost" data-bdl="${x.id}" title="Baixar"><i class="i i-download"></i></button>
          <button class="btn sm icon ghost" data-bdel="${x.id}" title="Apagar"><i class="i i-trash-2"></i></button></td></tr>`).join("")}</tbody></table>`}</div>`;
}
const loadBackups = guard(async () => { S.backups = await call("backups", { node: S.view.node, server: S.view.server }); if (S.tab === "backups") $("#tabBody").innerHTML = backupsTab(); });

// ---------------- agendamentos
const ACTIONS = { restart: "Reiniciar", start: "Ligar", stop: "Desligar", backup: "Fazer backup", command: "Mandar comando" };
const DAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
function describe(cron) {
  let m;
  if ((m = /^(\d+) (\d+) \* \* \*$/.exec(cron))) return `Todo dia às ${m[2].padStart(2, "0")}:${m[1].padStart(2, "0")}`;
  if ((m = /^(\d+) (\d+) \* \* (\d)$/.exec(cron))) return `Toda ${DAYS[Number(m[3])]} às ${m[2].padStart(2, "0")}:${m[1].padStart(2, "0")}`;
  if ((m = /^0 \*\/(\d+) \* \* \*$/.exec(cron))) return `A cada ${m[1]} horas`;
  if ((m = /^\*\/(\d+) \* \* \* \*$/.exec(cron))) return `A cada ${m[1]} minutos`;
  return cron;
}
function schedulesTab() {
  const list = S.srv.schedules || [];
  return `<div class="card"><div class="row" style="margin-bottom:12px"><h3 class="h grow" style="margin:0"><i class="i i-calendar-clock"></i>Agendamentos</h3>
      <button class="btn violet" data-act="add-schedule"><i class="i i-plus"></i>Novo agendamento</button></div>
    <p class="faint" style="margin:0 0 10px">Tarefas que a máquina faz sozinha, mesmo com o Hub fechado: reiniciar toda madrugada, backup diário, avisos no chat...</p>
    ${!list.length ? `<div class="empty">Nenhum agendamento.</div>` : `<table class="table"><thead><tr><th>Quando</th><th>O que faz</th><th>Próxima vez</th><th></th></tr></thead><tbody>
      ${list.map((j) => `<tr><td>${esc(describe(j.cron))}<div class="faint mono" data-noi18n>${esc(j.cron)}</div></td><td>${esc(ACTIONS[j.action] || j.action)}${j.action === "command" ? `<div class="faint mono" data-noi18n>${esc(j.payload)}</div>` : ""}</td>
        <td data-next="${esc(j.cron)}" class="faint">${j.enabled ? "..." : "pausado"}</td>
        <td style="text-align:right;white-space:nowrap"><label class="row" style="display:inline-flex;gap:6px"><input type="checkbox" data-jtoggle="${j.id}" ${j.enabled ? "checked" : ""}>Ativo</label>
          <button class="btn sm icon ghost" data-jdel="${j.id}" title="Apagar"><i class="i i-trash-2"></i></button></td></tr>`).join("")}</tbody></table>`}</div>`;
}
const fillNextRuns = guard(async () => {
  for (const td of $$("[data-next]")) { if (td.textContent === "pausado") continue; try { const r = await call("cron-next", { node: S.view.node, expr: td.dataset.next }); td.textContent = r.next ? ago(r.next) : "--"; } catch { td.textContent = "--"; } }
});
function scheduleDialog() {
  openModal(`<h3>Novo agendamento</h3><div class="form">
      <label>Quando<select id="jWhen"><option value="daily">Todo dia</option><option value="weekly">Toda semana</option><option value="hours">A cada algumas horas</option><option value="cron">Personalizado (cron)</option></select></label>
      <div class="two" id="jWhenFields"></div>
      <label>O que fazer<select id="jAct">${Object.entries(ACTIONS).map(([k, t]) => `<option value="${k}">${t}</option>`).join("")}</select></label>
      <label id="jPayWrap" hidden>Comando<input type="text" id="jPay" placeholder="say O servidor vai reiniciar em 5 minutos" data-noi18n></label>
    </div><div class="modal-actions"><button class="btn" data-n>Cancelar</button><button class="btn primary" data-y>Adicionar</button></div>`);
  const fields = () => {
    const w = $("#jWhen").value;
    $("#jWhenFields").innerHTML = w === "daily" ? `<label>Horário<input type="time" id="jTime" value="04:00"></label>`
      : w === "weekly" ? `<label>Dia<select id="jDay">${DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join("")}</select></label><label>Horário<input type="time" id="jTime" value="04:00"></label>`
      : w === "hours" ? `<label>A cada (horas)<input type="number" id="jHours" min="1" max="23" value="6"></label>`
      : `<label style="grid-column:1/-1">Cron (minuto hora dia mês dia-da-semana)<input type="text" id="jCron" value="0 4 * * *" class="mono" data-noi18n></label>`;
  };
  fields();
  $("#jWhen").onchange = fields;
  $("#jAct").onchange = () => { $("#jPayWrap").hidden = $("#jAct").value !== "command"; };
  box.querySelector("[data-n]").onclick = closeModal;
  box.querySelector("[data-y]").onclick = guard(async () => {
    const w = $("#jWhen").value, [hh, mm] = ($("#jTime") ? $("#jTime").value : "04:00").split(":").map(Number);
    const cron = w === "daily" ? `${mm} ${hh} * * *` : w === "weekly" ? `${mm} ${hh} * * ${$("#jDay").value}` : w === "hours" ? `0 */${Math.max(1, Math.min(23, Number($("#jHours").value) || 6))} * * *` : $("#jCron").value.trim();
    await call("cron-next", { node: S.view.node, expr: cron }); // confere o formato
    const action = $("#jAct").value, payload = $("#jPay").value;
    if (action === "command" && !payload.trim()) throw new Error("Digite o comando");
    S.srv = await call("server-update", { node: S.view.node, server: S.view.server, patch: { schedules: [...(S.srv.schedules || []), { cron, action, payload, enabled: true }] } });
    closeModal(); renderMain();
  });
}

// ---------------- configurações
function varInput(v, val, prefix = "v") {
  const id = `${prefix}_${v.key}`;
  if (v.type === "bool") return `<label class="chk"><input type="checkbox" id="${id}" data-var="${v.key}" ${val === "true" ? "checked" : ""}>${esc(v.name)}</label>`;
  const input = v.type === "select" ? `<select id="${id}" data-var="${v.key}">${v.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(val) ? "selected" : ""}>${esc(o.name)}</option>`).join("")}</select>`
    : `<input type="${v.type === "password" ? "password" : v.type === "number" ? "number" : "text"}" id="${id}" data-var="${v.key}" value="${esc(val)}" ${v.min != null ? `min="${v.min}"` : ""} ${v.max != null ? `max="${v.max}"` : ""} ${v.type === "password" ? 'autocomplete="new-password"' : ""} data-noi18n>`;
  return `<label>${esc(v.name)}${v.required ? " *" : ""}${input}${v.description ? `<span class="hint">${esc(v.description)}</span>` : ""}</label>`;
}
const readVars = (root) => Object.fromEntries($$("[data-var]", root).map((el) => [el.dataset.var, el.type === "checkbox" ? (el.checked ? "true" : "false") : el.value]));
function settingsTab() {
  const s = S.srv, t = (S.templates[S.view.node] || []).find((x) => x.id === s.template);
  return `<div class="card" id="setForm"><div class="form">
      <div class="two"><label>Nome<input type="text" id="sName" value="${esc(s.name)}" maxlength="60" data-noi18n></label><label>Descrição<input type="text" id="sDesc" value="${esc(s.description)}" maxlength="200" data-noi18n></label></div>
      ${t && t.vars.length ? `<div class="sect"><b>Opções do ${esc(t.name)}</b><div class="form">${t.vars.map((v) => varInput(v, s.vars[v.key] ?? v.default)).join("")}</div></div>` : ""}
      ${t && t.images ? `<div class="sect"><label>Versão do ambiente<select id="sImage">${t.images.map((i) => `<option value="${esc(i.image)}" ${i.image === s.image ? "selected" : ""}>${esc(i.name)}</option>`).join("")}</select></label></div>` : ""}
      ${s.template === "custom" ? `<div class="sect"><label>Imagem do Docker<input type="text" id="sImageCustom" value="${esc(s.image)}" class="mono" data-noi18n></label></div>` : ""}
      ${t && t.editableStartup ? `<div class="sect"><label>Comando de início (vazio = o da imagem)<input type="text" id="sStartup" value="${esc(s.startup)}" class="mono" data-noi18n></label></div>` : ""}
      ${s.ports.length ? `<div class="sect"><b>Portas</b><div class="three">${s.ports.map((p, i) => `<label>${esc(p.name)} (${protoName(p.protocol)})<input type="number" min="1" max="65535" data-port="${i}" value="${p.host}" ${p.offset != null || p.auto ? "disabled" : ""}></label>`).join("")}</div>${s.egg ? `<label style="margin-top:10px">Portas extras<input type="text" id="sExtra" value="${esc((s.extraPorts || []).join(", "))}" class="mono" data-noi18n><span class="hint">Portas a mais que o programa usa, separadas por vírgula. As portas das opções (como QUERY_PORT) abrem sozinhas.</span></label>` : ""}</div>` : ""}
      <div class="sect"><b>Limites</b><div class="three">
        <label>Memória (MB)<input type="number" id="lMem" min="0" step="256" value="${s.limits.memory}"><span class="hint">0 = sem limite</span></label>
        <label>Processador (núcleos)<input type="number" id="lCpu" min="0" step="0.5" value="${s.limits.cpu}"><span class="hint">0 = sem limite</span></label>
        <label>Disco (MB)<input type="number" id="lDisk" min="0" step="1024" value="${s.limits.disk}"><span class="hint">0 = sem limite</span></label></div></div>
      <div class="sect"><label class="chk"><input type="checkbox" id="sAuto" ${s.autostart ? "checked" : ""}>Ligar sozinho quando a máquina ligar</label>
        <label class="chk"><input type="checkbox" id="sRestart" ${s.autoRestart ? "checked" : ""}>Reiniciar sozinho se cair</label></div>
      <div><button class="btn violet" data-act="save-settings"><i class="i i-save"></i>Salvar</button> <span class="faint">Portas, limites e versão valem a partir do próximo início.</span></div>
    </div></div>
    <div class="card danger"><h3 class="h"><i class="i i-triangle-alert" style="color:var(--bad)"></i>Zona de perigo</h3><div class="row">
      <button class="btn" data-act="reinstall"><i class="i i-refresh-cw"></i>Reinstalar</button><span class="faint grow">Roda a instalação de novo (baixa a versão escolhida). Os arquivos que você criou continuam.</span></div>
      <div class="row" style="margin-top:10px"><button class="btn danger" data-act="delete-server"><i class="i i-trash-2"></i>Apagar servidor</button><span class="faint grow">Apaga o servidor, os arquivos e os backups. Não dá para desfazer.</span></div></div>`;
}

// ---------------------------------------------------------------- adicionar máquina e criar servidor
function addNodeDialog() {
  openModal(`<h3>Adicionar máquina</h3>${addNodeSteps()}<div class="modal-actions"><button class="btn" data-x>Fechar</button></div>`, "mid");
  box.querySelector("[data-x]").onclick = closeModal;
  fillInstall(); discover();
}
const fillInstall = guard(async () => { const el = $("#installCmd"); if (el) el.textContent = await call("install-command"); });
async function discover() {
  const st = $("#discStatus"), out = $("#found"); if (!st) return;
  st.innerHTML = `<span class="spin"></span>`;
  try {
    const list = await call("discover");
    st.textContent = list.length ? "" : "Nenhuma máquina respondeu. Confira se o agente está rodando e se a máquina está na mesma rede.";
    out.innerHTML = list.map((m) => `<button data-pick="${esc(m.host)}:${m.port}"><i class="i i-hard-drive"></i><span class="grow"><b data-noi18n>${esc(m.name)}</b> <span class="faint mono" data-noi18n>${esc(m.host)}:${m.port}</span></span>
      ${m.known ? `<span class="badge">já adicionada</span>` : m.pairing ? `<span class="badge" style="color:#4ade80">esperando o código</span>` : `<span class="badge">rode: sudo piphin-agent pair</span>`}</button>`).join("");
  } catch (e) { st.textContent = e.message; }
}
async function newServerWizard(nodeId) {
  const n = nodeOf(nodeId);
  openModal(`<div class="row"><h3 class="grow" style="margin:0">Novo servidor</h3><span class="faint" data-noi18n>${esc(n.name)}</span></div><div id="wiz"><div class="empty"><span class="spin"></span></div></div>`, "wide");
  let tpls;
  try { tpls = await templatesOf(nodeId); } catch (e) { $("#wiz").innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  let cat = "jogos";
  let eggQuery = "", eggGroup = "";
  const reloadTpls = async () => { delete S.templates[nodeId]; tpls = await templatesOf(nodeId); };
  const catTabs = () => `<div class="tpl-cats">${CATS.map(([k, t, ic]) => `<button class="${k === cat ? "on" : ""}" data-cat="${k}"><i class="i i-${ic}"></i> ${t}</button>`).join("")}</div>`;
  const eggsPane = guard(async () => {
    $("#wiz").innerHTML = `${catTabs()}<div class="empty"><span class="spin"></span></div><div class="modal-actions"><button class="btn" data-x>Cancelar</button></div>`;
    box.querySelector("[data-x]").onclick = closeModal;
    $$("[data-cat]").forEach((b) => (b.onclick = () => { cat = b.dataset.cat; pick(); }));
    const info = await call("node-info", nodeId);
    if (cat !== "eggs") return;
    if (olderThan(info.version, EGG_MIN_AGENT)) {
      const cmd = await call("install-command");
      $("#wiz").innerHTML = `${catTabs()}<div class="card" style="margin-bottom:14px"><p style="margin-top:0"><b>Atualize o agente para usar eggs</b></p>
        <p class="muted">Esta máquina está com o agente <span data-noi18n>${esc(info.version)}</span>. Rode este comando no Ubuntu. Os servidores continuam ligados durante a atualização.</p>
        <div class="cmdbox"><code data-noi18n>${esc(cmd)}</code><button class="btn sm" data-copy="${esc(cmd)}"><i class="i i-copy"></i>Copiar</button></div></div>
        <div class="modal-actions"><button class="btn" data-x>Cancelar</button></div>`;
      box.querySelector("[data-x]").onclick = closeModal;
      $$("[data-cat]").forEach((b) => (b.onclick = () => { cat = b.dataset.cat; pick(); }));
      return;
    }
    if (!S.eggCatalog) S.eggCatalog = await call("egg-catalog");
    if (cat !== "eggs") return;
    $("#wiz").innerHTML = `${catTabs()}
      <div class="egg-tools"><div class="egg-search"><i class="i i-search"></i><input type="text" id="eggSearch" placeholder="Procurar egg" value="${esc(eggQuery)}" data-noi18n></div>
        <div class="tpl-cats" style="margin:0">${EGG_GROUPS.map(([k, t]) => `<button class="${k === eggGroup ? "on" : ""}" data-egg-group="${k}">${t}</button>`).join("")}</div>
        <button class="btn sm" data-egg-file><i class="i i-upload"></i>Importar arquivo</button></div>
      <div class="tpl-grid" id="eggList"></div>
      <p class="faint" style="margin:10px 0 0">Eggs vêm de eggs.pterodactyl.io, com textos em inglês. Cada servidor roda isolado no Docker. Só importe arquivos de quem você confia.</p>
      <div class="modal-actions"><button class="btn" data-x>Cancelar</button></div>`;
    box.querySelector("[data-x]").onclick = closeModal;
    $$("[data-cat]").forEach((b) => (b.onclick = () => { cat = b.dataset.cat; pick(); }));
    const paint = () => {
      const q = eggQuery.trim().toLowerCase(), hit = (x) => !q || `${x.name} ${x.description}`.toLowerCase().includes(q);
      const mine = tpls.filter((t) => t.egg && hit(t)), ids = new Set(tpls.filter((t) => t.egg).map((t) => t.id));
      const rest = S.eggCatalog.filter((e) => !ids.has("egg-" + e.slug) && (!eggGroup || e.group === eggGroup) && hit(e));
      $("#eggList").innerHTML = mine.map((t) => `<div class="egg-item"><button class="tpl" data-egg-open="${esc(t.id)}"><div class="ic"><i class="i i-egg"></i></div><div><b data-noi18n>${esc(t.name)}</b> <span class="badge">Na máquina</span><br><span data-noi18n>${esc(t.description)}</span></div></button><button class="btn sm ghost egg-del" data-egg-del="${esc(t.id)}" title="Tirar da máquina"><i class="i i-trash-2"></i></button></div>`).join("")
        + rest.map((e) => `<div class="egg-item"><button class="tpl" data-egg-get="${esc(e.slug)}"><div class="ic"><i class="i i-egg"></i></div><div><b data-noi18n>${esc(e.name)}</b><br><span data-noi18n>${esc(e.description)}</span></div></button></div>`).join("")
        || `<div class="empty">Nenhum egg encontrado.</div>`;
    };
    paint();
    $("#eggSearch").oninput = (ev) => { eggQuery = ev.target.value; paint(); };
    $$("[data-egg-group]").forEach((b) => (b.onclick = () => { eggGroup = b.dataset.eggGroup; $$("[data-egg-group]").forEach((x) => x.classList.toggle("on", x === b)); paint(); }));
    box.querySelector("[data-egg-file]").onclick = guard(async () => {
      const t = await call("egg-import-file", { node: nodeId });
      if (!t) return;
      await reloadTpls(); toast("Egg importado", "ok");
      configure(tpls.find((x) => x.id === t.id));
    });
    $("#eggList").onclick = guard(async (ev) => {
      const del = ev.target.closest("[data-egg-del]");
      if (del) { await call("egg-delete", { node: nodeId, egg: del.dataset.eggDel }); await reloadTpls(); toast("Egg removido", "ok"); return paint(); }
      const open = ev.target.closest("[data-egg-open]");
      if (open) return configure(tpls.find((x) => x.id === open.dataset.eggOpen));
      const get = ev.target.closest("[data-egg-get]"); if (!get) return;
      const e = S.eggCatalog.find((x) => x.slug === get.dataset.eggGet);
      get.disabled = true; get.querySelector(".ic").innerHTML = `<span class="spin"></span>`;
      try {
        const t = await call("egg-import", { node: nodeId, slug: e.slug, url: e.url });
        await reloadTpls();
        configure(tpls.find((x) => x.id === t.id));
      } catch (err) { paint(); throw err; }
    });
  });
  const pick = () => {
    if (cat === "eggs") return eggsPane();
    $("#wiz").innerHTML = `<div class="tpl-cats">${CATS.map(([k, t, ic]) => `<button class="${k === cat ? "on" : ""}" data-cat="${k}"><i class="i i-${ic}"></i> ${t}</button>`).join("")}</div>
      <div class="tpl-grid">${tpls.filter((t) => t.category === cat).map((t) => `<button class="tpl" data-tpl="${t.id}"><div class="ic"><i class="i i-${esc(t.icon)}"></i></div><div><b>${esc(t.name)}</b><br><span>${esc(t.description)}</span></div></button>`).join("")}</div>
      <div class="modal-actions"><button class="btn" data-x>Cancelar</button></div>`;
    box.querySelector("[data-x]").onclick = closeModal;
    $$("[data-cat]").forEach((b) => (b.onclick = () => { cat = b.dataset.cat; pick(); }));
    $$("[data-tpl]").forEach((b) => (b.onclick = () => configure(tpls.find((t) => t.id === b.dataset.tpl))));
  };
  const configure = (t) => {
    const total = S.nodeInfo && S.view.node === nodeId ? S.nodeInfo.info.memory : null;
    $("#wiz").innerHTML = `<div class="form" data-sticky>
        <div class="row"><button class="btn sm ghost" data-back><i class="i i-chevron-left"></i>Voltar</button><b>${esc(t.name)}</b></div>
        <div class="two"><label>Nome do servidor<input type="text" id="wName" value="${esc(t.name)}" maxlength="60" data-noi18n></label>
          ${t.images ? `<label>Versão do ambiente<select id="wImage">${t.images.map((i) => `<option value="${esc(i.image)}">${esc(i.name)}</option>`).join("")}</select></label>` : "<span></span>"}</div>
        ${t.vars.length ? `<div class="sect"><b>Opções</b><div class="form" id="wVars">${t.vars.map((v) => varInput(v, v.default, "w")).join("")}</div></div>` : ""}
        ${t.editableStartup ? `<label>Comando de início (vazio = o da imagem)<input type="text" id="wStartup" class="mono" value="${t.egg ? esc(t.startup || "") : ""}" data-noi18n></label>` : ""}
        ${t.ports.length ? `<div class="sect"><b>Portas</b><div class="three">${t.ports.map((p, i) => `<label>${esc(p.name)} (${protoName(p.protocol)})<input type="number" min="1" max="65535" data-wport="${i}" value="${p.default || ""}" ${i > 0 && !p.default ? "disabled placeholder='automática'" : ""}></label>`).join("")}</div><span class="hint">Se a porta já estiver em uso, a próxima livre é escolhida.</span>${t.egg ? `<label style="margin-top:10px">Portas extras<input type="text" id="wExtra" class="mono" placeholder="2457, 2458" data-noi18n><span class="hint">Portas a mais que o programa usa, separadas por vírgula. As portas das opções (como QUERY_PORT) abrem sozinhas.</span></label>` : ""}</div>` : ""}
        <div class="sect"><b>Limites</b><div class="three">
          <label>Memória (MB)<input type="number" id="wMem" min="0" step="256" value="${t.limits.memory || 1024}">${total ? `<span class="hint">A máquina tem ${bytes(total)}</span>` : ""}</label>
          <label>Processador (núcleos)<input type="number" id="wCpu" min="0" step="0.5" value="${t.limits.cpu || 0}"><span class="hint">0 = sem limite</span></label>
          <label>Disco (MB)<input type="number" id="wDisk" min="0" step="1024" value="${t.limits.disk || 0}"><span class="hint">0 = sem limite</span></label></div></div>
        <label class="chk"><input type="checkbox" id="wAuto" checked>Ligar assim que terminar de instalar</label>
        ${t.notes ? `<p class="faint">${esc(t.notes)}</p>` : ""}
      </div><div class="modal-actions"><button class="btn" data-x>Cancelar</button><button class="btn violet" data-create><i class="i i-plus"></i>Criar servidor</button></div>`;
    box.querySelector("[data-back]").onclick = pick;
    box.querySelector("[data-x]").onclick = closeModal;
    box.querySelector("[data-create]").onclick = guard(async () => {
      const btn = box.querySelector("[data-create]"); btn.disabled = true;
      try {
        const spec = { template: t.id, name: $("#wName").value, vars: readVars($("#wiz")), image: $("#wImage") ? $("#wImage").value : undefined, startup: $("#wStartup") ? $("#wStartup").value : undefined, extraPorts: $("#wExtra") ? $("#wExtra").value : undefined,
          ports: $$("[data-wport]").map((el) => Number(el.value) || 0), limits: { memory: Number($("#wMem").value) || 0, cpu: Number($("#wCpu").value) || 0, disk: Number($("#wDisk").value) || 0 }, autostart: $("#wAuto").checked };
        const s = await call("server-create", { node: nodeId, spec });
        closeModal();
        await loadServers(nodeId);
        show("server", nodeId, s.id, "console");
        toast("Servidor criado: instalando agora", "ok");
      } finally { btn.disabled = false; }
    });
  };
  pick();
}

// ---------------------------------------------------------------- cliques
document.addEventListener("click", guard(async (e) => {
  const t = e.target;
  const cp = t.closest("[data-copy]"); if (cp) return copy(cp.dataset.copy);
  const pk = t.closest("[data-pick]"); if (pk) { $("#pairHost").value = pk.dataset.pick; $("#pairCode").focus(); return; }
  // trocar de aba recarrega a lista dela (backups e arquivos podem ter mudado por agendamento ou por outro Hub)
  const tab = t.closest("[data-tab]"); if (tab) { S.tab = tab.dataset.tab; if (S.tab === "backups") S.backups = null; if (S.tab === "files") S.files = null; return renderMain(); }
  const pw = t.closest("[data-power]");
  if (pw) {
    const action = pw.dataset.power;
    if (action === "kill" && !(await confirmBox("Forçar a parada?", "O servidor é desligado na hora, sem salvar. Use só se ele travou.", "Forçar", true))) return;
    pw.disabled = true;
    S.srv = await call("server-power", { node: S.view.node, server: S.view.server, action }).catch((err) => { toast(err.message, "err"); return S.srv; });
    renderHeader(); return;
  }
  const os = t.closest("[data-open-srv]"); if (os) return show("server", os.dataset.nodeId, os.dataset.openSrv);
  const dir = t.closest("[data-dir]"); if (dir && !t.closest(".acts")) return loadFiles(dir.dataset.dir);
  const fl = t.closest("[data-file]"); if (fl && !t.closest(".acts")) return openEditor(fl.dataset.file);
  const dl = t.closest("[data-dl]"); if (dl) { const f = await call("file-download", { node: S.view.node, server: S.view.server, path: dl.dataset.dl }); if (f) toast("Baixado", "ok"); return; }
  const ren = t.closest("[data-ren]");
  if (ren) { const p = ren.dataset.ren, name = await promptBox("Renomear", "Novo nome", p.split("/").pop()); if (!name) return; await call("file-rename", { node: S.view.node, server: S.view.server, from: p, to: path(p.slice(0, p.lastIndexOf("/")) || "/", name) }); return loadFiles(S.filesPath); }
  const del = t.closest("[data-del]");
  if (del) { if (!(await confirmBox("Apagar?", `"${del.dataset.del}" será apagado para sempre.`, "Apagar", true))) return; await call("file-delete", { node: S.view.node, server: S.view.server, paths: [del.dataset.del] }); return loadFiles(S.filesPath); }
  const rs = t.closest("[data-restore]");
  if (rs) { if (!(await confirmBox("Restaurar este backup?", "O servidor é desligado e os arquivos atuais são trocados pelos do backup.", "Restaurar", true))) return; toast("Restaurando...", "info"); await call("backup-restore", { node: S.view.node, server: S.view.server, backup: rs.dataset.restore }); toast("Backup restaurado", "ok"); return; }
  const bdl = t.closest("[data-bdl]"); if (bdl) { await call("backup-download", { node: S.view.node, server: S.view.server, backup: bdl.dataset.bdl }); return; }
  const bdel = t.closest("[data-bdel]"); if (bdel) { if (!(await confirmBox("Apagar o backup?", "Não dá para desfazer.", "Apagar", true))) return; await call("backup-delete", { node: S.view.node, server: S.view.server, backup: bdel.dataset.bdel }); return loadBackups(); }
  const jdel = t.closest("[data-jdel]");
  if (jdel) { S.srv = await call("server-update", { node: S.view.node, server: S.view.server, patch: { schedules: S.srv.schedules.filter((j) => j.id !== jdel.dataset.jdel) } }); return renderMain(); }

  const a = t.closest("[data-act]"); if (!a || a.disabled) return;
  const act = a.dataset.act;
  if (act === "add-node") return addNodeDialog();
  if (act === "copy-install") return copy($("#installCmd").textContent);
  if (act === "discover") return discover();
  if (act === "pair") {
    const host = $("#pairHost").value.trim(), code = $("#pairCode").value.trim();
    if (!host || !code) throw new Error("Preencha o endereço e o código");
    a.disabled = true;
    try { const n = await call("pair", { host, code }); closeModal(); toast(`Máquina adicionada: ${n.name}`, "ok"); await loadNodes(); show("node", n.id); } finally { a.disabled = false; }
    return;
  }
  if (act === "new-server") return newServerWizard(a.dataset.nodeId || S.view.node);
  if (act === "rename-node") { const n = curNode(), name = await promptBox("Renomear máquina", "Nome", n.name); if (!name) return; await call("node-rename", { id: n.id, name }); await loadNodes(); return renderMain(); }
  if (act === "remove-node") {
    const n = curNode();
    if (!(await confirmBox(`Esquecer "${n.name}"?`, "O Hub para de mostrar esta máquina e tira o acesso dele. Os servidores continuam rodando nela.", "Esquecer", true))) return;
    await call("node-remove", n.id); await loadNodes(); return show("home");
  }
  if (act === "new-folder") { const name = await promptBox("Nova pasta", "Nome da pasta"); if (!name) return; await call("file-mkdir", { node: S.view.node, server: S.view.server, path: path(S.filesPath, name) }); return loadFiles(S.filesPath); }
  if (act === "new-file") { const name = await promptBox("Novo arquivo", "Nome do arquivo"); if (!name) return; const p = path(S.filesPath, name); await call("file-write", { node: S.view.node, server: S.view.server, path: p, content: "" }); await loadFiles(S.filesPath); return openEditor(p); }
  if (act === "upload") { const n = await call("file-upload", { node: S.view.node, server: S.view.server, dir: S.filesPath }); if (n) { toast(n === 1 ? "1 arquivo enviado" : `${n} arquivos enviados`, "ok"); loadFiles(S.filesPath); } return; }
  if (act === "refresh-files") return loadFiles(S.filesPath);
  if (act === "backup-now") {
    const note = await promptBox("Fazer backup", "Nota (opcional)", ""); if (note === null) return;
    S.busy.backup = true; renderMain();
    try { await call("backup-create", { node: S.view.node, server: S.view.server, note: note || "" }); toast("Backup pronto", "ok"); } finally { S.busy.backup = false; await loadBackups(); }
    return;
  }
  if (act === "add-schedule") return scheduleDialog();
  if (act === "save-settings") {
    const s = S.srv, patch = { name: $("#sName").value, description: $("#sDesc").value, vars: readVars($("#setForm")),
      limits: { memory: Number($("#lMem").value) || 0, cpu: Number($("#lCpu").value) || 0, disk: Number($("#lDisk").value) || 0 },
      autostart: $("#sAuto").checked, autoRestart: $("#sRestart").checked, ports: $$("[data-port]").map((el) => Number(el.value) || 0) };
    if ($("#sImage")) patch.image = $("#sImage").value;
    if ($("#sImageCustom")) patch.image = $("#sImageCustom").value;
    if ($("#sStartup")) patch.startup = $("#sStartup").value;
    if ($("#sExtra")) patch.extraPorts = $("#sExtra").value;
    S.srv = await call("server-update", { node: S.view.node, server: s.id, patch });
    toast("Configurações salvas", "ok"); renderSide(); return renderMain();
  }
  if (act === "reinstall") { if (!(await confirmBox("Reinstalar?", "O servidor é desligado e a instalação roda de novo.", "Reinstalar", true))) return; await call("server-reinstall", { node: S.view.node, server: S.view.server }); S.tab = "console"; return renderMain(); }
  if (act === "delete-server") {
    const name = await promptBox("Apagar servidor", `Para confirmar, digite o nome: ${S.srv.name}`);
    if (name !== S.srv.name) { if (name) toast("O nome não confere", "err"); return; }
    await call("server-delete", { node: S.view.node, server: S.view.server }); toast("Servidor apagado", "ok");
    await loadServers(S.view.node); return show("node", S.view.node);
  }
}));
document.addEventListener("change", guard(async (e) => {
  const j = e.target.closest("[data-jtoggle]");
  if (j) { S.srv = await call("server-update", { node: S.view.node, server: S.view.server, patch: { schedules: S.srv.schedules.map((x) => (x.id === j.dataset.jtoggle ? { ...x, enabled: j.checked } : x)) } }); renderMain(); }
}));
// console: Enter manda, setas navegam no histórico
document.addEventListener("keydown", guard(async (e) => {
  if (e.target.id !== "cmdIn") return;
  const el = e.target;
  if (e.key === "Enter" && el.value.trim()) {
    const line = el.value; el.value = ""; S.cmdHistory.push(line); S.cmdIdx = S.cmdHistory.length;
    await call("server-command", { node: S.view.node, server: S.view.server, line });
  } else if (e.key === "ArrowUp" && S.cmdHistory.length) { S.cmdIdx = Math.max(0, S.cmdIdx - 1); el.value = S.cmdHistory[S.cmdIdx]; e.preventDefault(); }
  else if (e.key === "ArrowDown" && S.cmdHistory.length) { S.cmdIdx = Math.min(S.cmdHistory.length, S.cmdIdx + 1); el.value = S.cmdHistory[S.cmdIdx] || ""; e.preventDefault(); }
}));
// arrastar arquivos do Windows para a lista de arquivos
document.addEventListener("dragover", (e) => { const l = e.target.closest && e.target.closest("#flist"); if (l) { e.preventDefault(); l.classList.add("drop"); } });
document.addEventListener("dragleave", (e) => { const l = e.target.closest && e.target.closest("#flist"); if (l && !l.contains(e.relatedTarget)) l.classList.remove("drop"); });
document.addEventListener("drop", guard(async (e) => {
  const l = e.target.closest && e.target.closest("#flist"); if (!l) return;
  e.preventDefault(); l.classList.remove("drop");
  const list = [...e.dataTransfer.files];
  for (const [i, f] of list.entries()) {
    $("#transfer").hidden = false;
    $("#transfer").innerHTML = `<div class="row"><span class="spin"></span><span class="grow" data-noi18n>${esc(f.name)}</span><span>${i + 1}/${list.length}</span></div>`;
    await call("file-upload-bytes", { node: S.view.node, server: S.view.server, dir: S.filesPath, name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  $("#transfer").hidden = true;
  if (list.length) { toast(list.length === 1 ? "1 arquivo enviado" : `${list.length} arquivos enviados`, "ok"); loadFiles(S.filesPath); }
}));

// ---------------------------------------------------------------- início
(async () => {
  try { await loadNodes(); } catch (e) { toast(e.message, "err"); }
  show(S.nodes.length === 1 ? "node" : "home", S.nodes.length === 1 ? S.nodes[0].id : null);
  if (!S.nodes.length) { fillInstall(); discover(); }
})();
