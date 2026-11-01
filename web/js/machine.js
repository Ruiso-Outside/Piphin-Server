// Piphin Server · a máquina inteira: monitoramento, sistema (agente, atualizações, energia), serviços, rede e firewall, Docker, logs e terminal.
// Usa as funções de app.js. Cada aba busca os próprios dados; o que muda sozinho é pintado por partes, para não atrapalhar quem está digitando.
const SYS_MIN_AGENT = "1.2.0";
const NODE_TABS = [["overview", "layout-dashboard", "Visão geral"], ["monitor", "gauge", "Monitoramento"], ["system", "settings", "Sistema"], ["services", "list", "Serviços"], ["network", "network", "Rede"], ["docker", "box", "Docker"], ["logs", "scroll-text", "Logs"], ["terminal", "terminal", "Terminal"]];
const M = { mon: null, procs: null, hist: [], range: "1h", smart: null, over: null, updates: null, job: null, latest: null, services: null, svcQuery: "", net: null, dock: null, logs: null, logQ: { unit: "", priority: "", kernel: false, grep: "", lines: 300 }, tz: null, tick: 0, clients: null };
const sys = (path, method = "GET", body, timeout) => call("sys", { node: S.view.node, path: "/api/system" + path, method, body, timeout });
const agentVersion = () => (S.nodeInfo ? S.nodeInfo.version : null);
const needsUpdate = () => agentVersion() && olderThan(agentVersion(), SYS_MIN_AGENT);
const pctColor = (p) => (p > 90 ? "var(--bad)" : p > 70 ? "var(--warn)" : "var(--sv)");
const tempColor = (c, crit) => (c >= (crit || 95) - 5 ? "var(--bad)" : c >= (crit || 95) - 20 ? "var(--warn)" : "var(--ok)");
const barHtml = (p, color) => `<div class="bar"><i style="width:${Math.min(100, Math.max(0, p))}%;--c:${color || pctColor(p)}"></i></div>`;
const empty = (t) => `<div class="empty">${t}</div>`;
const loading = `<div class="card row"><span class="spin"></span><span class="muted">Carregando...</span></div>`;

function machineTabs() { return `<div class="tabs">${NODE_TABS.map(([k, ic, t]) => `<button class="${S.nodeTab === k ? "on" : ""}" data-ntab="${k}"><i class="i i-${ic}"></i>${t}</button>`).join("")}</div>`; }
// cada máquina com os seus dados
function machineReset() { if (M.node === S.view.node) return; M.node = S.view.node; Object.assign(M, { mon: null, procs: null, hist: [], smart: null, over: null, updates: null, job: null, services: null, net: null, dock: null, tz: null, macAsked: false, agentUpdating: false }); M.logQ = { unit: "", priority: "", kernel: false, grep: "", lines: 300 }; }
function machineBody() {
  machineReset();
  const n = curNode();
  if (!n.online) return `<div class="card">${empty("A máquina está fora do ar.")}</div>`;
  if (!S.nodeInfo) return loading;
  if (needsUpdate()) return updateFirstCard();
  return `<div id="nodeBody">${({ monitor: monitorTab, system: systemTab, services: servicesTab, network: networkTab, docker: dockerTab, logs: logsTab, terminal: terminalTab })[S.nodeTab]()}</div>`;
}
// agente antigo: as outras abas precisam da versão nova. Esta é a última vez que precisa ir ao Ubuntu
function updateFirstCard() {
  const cmd = "curl -fsSL https://github.com/Ruiso-Outside/Piphin-Server/releases/latest/download/install.sh | sudo bash";
  return `<div class="card"><h3 class="h"><i class="i i-circle-arrow-up"></i>Atualize o agente uma última vez pelo Ubuntu</h3>
    <p class="muted">Esta máquina está com o agente <span data-noi18n>${esc(agentVersion())}</span>. Rode este comando no Ubuntu. Os servidores continuam ligados. Depois disso, as próximas atualizações saem daqui do Hub, com um clique.</p>
    <div class="cmdbox"><code data-noi18n>${esc(cmd)}</code><button class="btn sm" data-copy="${esc(cmd)}"><i class="i i-copy"></i>Copiar</button></div></div>`;
}
// depois de desenhar a tela
function machineMounted() {
  if (S.view.kind !== "node") return;
  if (S.nodeTab === "overview") { paintAlerts(); return; }
  if (!curNode().online || !S.nodeInfo || needsUpdate()) return;
  ({ monitor: mountMonitor, system: mountSystem, services: mountServices, network: mountNetwork, docker: mountDocker, logs: mountLogs, terminal: mountTerminal })[S.nodeTab]();
}
function machineBack() { if (S.nodeTab !== "overview" && !$("#nodeBody")) renderMain(); }
// a cada 3 segundos, com a máquina na tela
const machineTick = guardQuiet(async () => {
  M.tick++;
  machineReset();
  const n = curNode(); if (!n || !n.online || !S.nodeInfo || needsUpdate()) return;
  // o endereço físico fica guardado: com a máquina desligada não dá mais para perguntar
  if (!M.macAsked) { M.macAsked = true; const id = n.id; sys("/overview").then((o) => { if (o.mac) call("node-remember-mac", { id, mac: o.mac }); }).catch(() => {}); }
  if (S.nodeTab === "overview") { M.mon = await sys("/monitor"); paintAlerts(); return; }
  if (S.nodeTab === "monitor") {
    M.mon = await sys("/monitor"); paintMonitor();
    if (M.tick % 2 === 0) loadProcs();
    if (M.tick % 5 === 0) loadHistory();
  }
});
function guardQuiet(fn) { return async (...a) => { try { await fn(...a); } catch { /* a próxima tentativa resolve */ } }; }

const ALERT_TEXT = { disk: (a) => `O disco ${a.mount} está ${a.pct}% cheio`, memory: (a) => `A memória está ${a.pct}% em uso`, temp: (a) => `${a.sensor} está em ${a.c} °C`, services: (a) => (a.count === 1 ? "1 serviço com defeito" : `${a.count} serviços com defeito`), reboot: () => "O sistema pede para reiniciar a máquina", docker: () => "O Docker não está rodando" };
function paintAlerts() {
  const el = $("#alerts"); if (!el || !M.mon || !M.mon.alerts) { if (el) el.innerHTML = ""; return; }
  el.innerHTML = M.mon.alerts.map((a) => `<div class="alert ${a.level}"><i class="i i-triangle-alert"></i><span>${esc((ALERT_TEXT[a.code] || (() => a.code))(a))}</span></div>`).join("");
}

// ---------------------------------------------------------------- monitoramento
function monitorTab() {
  const chart = (id, t) => `<div class="chart"><div class="row"><span>${t}</span><b id="v_${id}" data-noi18n>--</b></div><canvas id="c_${id}"></canvas></div>`;
  return `<div id="alerts"></div>
    <div class="stats" id="monTop"></div>
    <div class="card"><div class="row" style="margin-bottom:12px"><h3 class="h grow" style="margin:0"><i class="i i-cpu"></i>Uso por núcleo</h3><span class="faint" id="monCpuName" data-noi18n></span></div><div class="cores" id="monCores"></div></div>
    <div class="card"><div class="row" style="margin-bottom:12px"><h3 class="h grow" style="margin:0"><i class="i i-activity"></i>Histórico</h3>
      <div class="tpl-cats" style="margin:0"><button class="${M.range === "1h" ? "on" : ""}" data-m="range" data-v="1h">1 hora</button><button class="${M.range === "24h" ? "on" : ""}" data-m="range" data-v="24h">24 horas</button></div></div>
      <div class="m-grid">${chart("cpu", "Processador")}${chart("mem", "Memória")}${chart("temp", "Temperatura")}${chart("net", "Rede")}${chart("io", "Disco")}</div></div>
    <div class="m-grid">
      <div class="card"><h3 class="h"><i class="i i-thermometer"></i>Temperaturas e ventoinhas</h3><div id="monSensors"></div></div>
      <div class="card"><h3 class="h"><i class="i i-hard-drive"></i>Discos</h3><div id="monDisks"></div></div>
      <div class="card"><h3 class="h"><i class="i i-memory-stick"></i>Memória</h3><div id="monMem"></div></div>
      <div class="card"><h3 class="h"><i class="i i-network"></i>Placas de rede</h3><div id="monNet"></div></div>
    </div>
    <div class="card"><h3 class="h"><i class="i i-list"></i>Processos</h3><div class="m-scroll" id="procs">${empty(`<span class="spin"></span>`)}</div></div>`;
}
const mountMonitor = guard(async () => {
  paintMonitor(); drawCharts(); if (M.procs) paintProcs();
  M.mon = await sys("/monitor"); paintMonitor();
  loadHistory(); loadProcs();
  M.smart = await sys("/smart").catch(() => ({ available: false, disks: [] })); paintMonitor();
});
const loadHistory = guardQuiet(async () => { M.hist = await sys(`/history?range=${M.range}`); drawCharts(); });
const loadProcs = guardQuiet(async () => { if (S.nodeTab !== "monitor") return; M.procs = await sys("/processes?limit=40"); paintProcs(); });
function paintMonitor() {
  const m = M.mon; if (!m || !$("#monTop")) return;
  paintAlerts();
  const memP = m.memory.total ? (m.memory.used / m.memory.total) * 100 : 0;
  $("#monTop").innerHTML = `<div class="stat"><div class="top"><i class="i i-cpu"></i>Processador</div><b>${num(m.cpu.total, 1)}%</b>${barHtml(m.cpu.total)}<span class="faint">${num(m.load[0], 2)} de carga · espera de disco ${num(m.cpu.iowait, 1)}%</span></div>
    <div class="stat"><div class="top"><i class="i i-thermometer"></i>Temperatura</div><b style="${m.cpuTemp != null ? `color:${tempColor(m.cpuTemp)}` : ""}">${m.cpuTemp != null ? `${num(m.cpuTemp, 0)} °C` : "--"}</b><span class="faint">${m.cpuTemp != null ? "do processador" : "sem sensor"}</span></div>
    <div class="stat"><div class="top"><i class="i i-memory-stick"></i>Memória</div><b>${bytes(m.memory.used)} <span class="faint">de ${bytes(m.memory.total)}</span></b>${barHtml(memP)}</div>
    <div class="stat"><div class="top"><i class="i i-clock"></i>Ligada há</div><b>${uptime(m.uptime)}</b><span class="faint">${m.procs === 1 ? "1 processo" : `${m.procs} processos`}</span></div>`;
  if (S.nodeInfo) $("#monCpuName").textContent = S.nodeInfo.info.cpu;
  $("#monCores").innerHTML = m.cpu.cores.map((c, i) => `<div class="core"><div class="row"><span class="faint">${i}</span><b>${num(c.pct, 0)}%</b></div>${barHtml(c.pct)}<span class="faint" data-noi18n>${c.mhz ? `${num(c.mhz / 1000, 2)} GHz` : "&nbsp;"}</span></div>`).join("");
  const gpu = (m.gpu || []).map((g) => `<div class="sensor"><span data-noi18n>${esc(g.name)}</span><b>${g.temp} °C · ${g.util}%</b>${barHtml(g.util)}</div>`).join("");
  $("#monSensors").innerHTML = (m.temps.map((t) => `<div class="sensor"><span data-noi18n>${esc(t.chip)} · ${esc(t.label)}</span><b style="color:${tempColor(t.c, t.crit)}">${num(t.c, 0)} °C</b>${barHtml((t.c / (t.crit || 100)) * 100, tempColor(t.c, t.crit))}</div>`).join("")
    + gpu + m.fans.map((f) => `<div class="sensor"><span data-noi18n><i class="i i-fan"></i> ${esc(f.chip)} · ${esc(f.label)}</span><b data-noi18n>${f.rpm} RPM</b></div>`).join(""))
    || `<p class="muted" style="margin:0">Esta máquina não mostra sensores (é comum em máquinas virtuais).</p>`;
  const smart = (M.smart && M.smart.disks) || [];
  $("#monDisks").innerHTML = m.mounts.map((d) => { const p = d.total ? (d.used / d.total) * 100 : 0; return `<div class="sensor"><span class="mono" data-noi18n>${esc(d.mount)} <span class="faint">${esc(d.device)}</span></span><b>${bytes(d.free)} <span class="faint">livres</span></b>${barHtml(p)}</div>`; }).join("")
    + m.io.map((d) => `<div class="sensor"><span class="mono" data-noi18n>${esc(d.name)}</span><span class="faint"><span data-noi18n>↓ ${bytes(d.read)}/s · ↑ ${bytes(d.write)}/s</span> · ${d.busy}% ocupado</span></div>`).join("")
    + smart.map((d) => `<div class="sensor"><span data-noi18n>${esc(d.model || d.device)}</span><b style="color:${d.healthy === false ? "var(--bad)" : "var(--ok)"}">${d.healthy === false ? "Com defeito" : d.healthy ? "Saudável" : "--"}</b><span class="faint" style="grid-column:1/-1"><span data-noi18n>${d.temp != null ? `${d.temp} °C · ` : ""}</span>${d.hours != null ? `<span>${num(d.hours, 0)} horas ligado</span> ` : ""}${d.wear != null ? `<span>· ${d.wear}% de desgaste</span>` : ""}</span></div>`).join("");
  const me = m.memory, row = (t, v) => `<dt>${t}</dt><dd>${bytes(v)}</dd>`;
  $("#monMem").innerHTML = `<dl class="kv">${row("Em uso", me.used)}${row("Disponível", me.available)}${row("Cache", me.cached + me.buffers)}${me.swapTotal ? `<dt>Swap</dt><dd>${bytes(me.swapUsed)} <span class="faint">de ${bytes(me.swapTotal)}</span></dd>` : ""}</dl>`;
  $("#monNet").innerHTML = m.net.map((n) => `<div class="sensor"><span class="mono" data-noi18n>${esc(n.name)}</span><b data-noi18n>↓ ${rate(n.rx)} · ↑ ${rate(n.tx)}</b><span class="faint" style="grid-column:1/-1"><span data-noi18n>↓ ${bytes(n.rxTotal)} · ↑ ${bytes(n.txTotal)}</span>${n.errors ? ` · ${n.errors} erros` : ""}</span></div>`).join("") || `<p class="muted" style="margin:0">Sem placas de rede.</p>`;
}
function paintProcs() {
  const el = $("#procs"); if (!el || !M.procs) return;
  const top = el.scrollTop;
  el.innerHTML = `<table class="m-table"><thead><tr><th>Programa</th><th>Usuário</th><th class="num">Processador</th><th class="num">Memória</th><th>Comando</th><th></th></tr></thead><tbody>
    ${M.procs.map((p) => `<tr><td data-noi18n><b>${esc(p.name)}</b> <span class="faint">${p.pid}</span></td><td data-noi18n>${esc(p.user)}</td><td class="num">${num(p.cpu, 1)}%</td><td class="num">${bytes(p.rss)}</td><td class="cut faint mono" title="${esc(p.cmd)}" data-noi18n>${esc(p.cmd)}</td>
      <td class="num"><button class="btn sm ghost" data-m="kill" data-pid="${p.pid}" data-name="${esc(p.name)}" title="Parar processo"><i class="i i-square"></i></button></td></tr>`).join("")}</tbody></table>`;
  el.scrollTop = top;
}
// gráficos simples em canvas: uma ou duas linhas, escala automática (ou fixa em 0-100)
function drawLine(id, series, { max = null, format, colors }) {
  const c = $(`#c_${id}`); if (!c) return;
  const w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr;
  const g = c.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  const all = series.flat().filter((v) => v != null);
  const top = max || Math.max(1, ...all) * 1.15;
  g.strokeStyle = "rgba(255,255,255,.06)"; g.lineWidth = 1;
  for (const f of [0.25, 0.5, 0.75]) { g.beginPath(); g.moveTo(0, h * f); g.lineTo(w, h * f); g.stroke(); }
  series.forEach((s, i) => {
    if (s.length < 2) return;
    g.strokeStyle = colors[i]; g.lineWidth = 1.6; g.beginPath();
    let on = false;
    s.forEach((v, x) => { if (v == null) { on = false; return; } const px = (x / (s.length - 1)) * w, py = h - (v / top) * (h - 6) - 2; if (on) g.lineTo(px, py); else g.moveTo(px, py); on = true; });
    g.stroke();
  });
  const lab = $(`#v_${id}`); if (lab) lab.textContent = format(series.map((s) => s[s.length - 1]));
}
function drawCharts() {
  const h = M.hist || [], pick = (k) => h.map((p) => p[k]);
  const pct = ([v]) => (v == null ? "--" : `${num(v, 1)}%`);
  drawLine("cpu", [pick("cpu")], { max: 100, format: pct, colors: ["#818cf8"] });
  drawLine("mem", [pick("mem")], { max: 100, format: pct, colors: ["#a78bfa"] });
  drawLine("temp", [pick("temp")], { format: ([v]) => (v == null ? "--" : `${num(v, 0)} °C`), colors: ["#fb923c"] });
  drawLine("net", [pick("rx"), pick("tx")], { format: ([a, b]) => (a == null ? "--" : `↓ ${rate(a)} · ↑ ${rate(b)}`), colors: ["#4ade80", "#60a5fa"] });
  drawLine("io", [pick("read"), pick("write")], { format: ([a, b]) => (a == null ? "--" : `↓ ${bytes(a)}/s · ↑ ${bytes(b)}/s`), colors: ["#4ade80", "#f472b6"] });
}

// ---------------------------------------------------------------- sistema
function systemTab() {
  const o = M.over;
  return `<div class="m-grid">
    <div class="card"><h3 class="h"><i class="i i-circle-arrow-up"></i>Piphin Agent</h3><div id="sysAgent">${empty(`<span class="spin"></span>`)}</div></div>
    <div class="card"><h3 class="h"><i class="i i-power"></i>Energia</h3>
      <p class="faint" style="margin-top:0">Os servidores param do jeito certo antes. Os que estavam ligados voltam sozinhos quando a máquina voltar.</p>
      <div class="row" style="flex-wrap:wrap"><button class="btn" data-m="power" data-v="reboot"><i class="i i-rotate-ccw"></i>Reiniciar a máquina</button><button class="btn danger" data-m="power" data-v="poweroff"><i class="i i-power"></i>Desligar a máquina</button></div>
      <p class="faint" style="margin-bottom:0" id="wolHint"></p></div>
  </div>
  <div class="card"><div class="row" style="margin-bottom:10px;flex-wrap:wrap"><h3 class="h grow" style="margin:0"><i class="i i-package"></i>Atualizações do Ubuntu</h3>
      <button class="btn" data-m="apt-check"><i class="i i-refresh-cw"></i>Procurar atualizações</button><button class="btn violet" data-m="apt-install"><i class="i i-download"></i>Instalar</button><button class="btn ghost" data-m="apt-full" title="dist-upgrade: também troca e remove pacotes quando preciso">Instalar tudo</button></div>
    <div id="sysUpdates">${empty(`<span class="spin"></span>`)}</div><div id="jobBox"></div></div>
  <div class="m-grid">
    <div class="card"><h3 class="h"><i class="i i-globe"></i>Nome e horário</h3><div id="sysId">${o ? "" : empty(`<span class="spin"></span>`)}</div></div>
    <div class="card"><h3 class="h"><i class="i i-key"></i>Hubs com acesso</h3><div id="sysHubs"></div></div>
  </div>`;
}
const mountSystem = guard(async () => {
  paintJob(); paintUpdates(); paintAgent(); paintHubs();
  const nodeId = S.view.node;
  M.over = await sys("/overview");
  if (S.view.node !== nodeId) return;
  if (M.over.mac) call("node-remember-mac", { id: nodeId, mac: M.over.mac }).catch(() => {});
  paintId();
  call("agent-latest").then((v) => { M.latest = v; paintAgent(); }).catch(() => { M.latest = null; paintAgent(); });
  const u = await sys("/updates"); M.updates = u.packages; M.job = u.job; paintUpdates(); paintJob();
  M.tz = await sys("/timezones").catch(() => []); paintId();
});
function paintAgent() {
  const el = $("#sysAgent"); if (!el) return;
  const cur = agentVersion(), lat = M.latest, can = lat && olderThan(cur, lat);
  el.innerHTML = `<dl class="kv"><dt>Instalado</dt><dd data-noi18n>${esc(cur)}</dd><dt>Mais novo</dt><dd data-noi18n>${esc(lat || "--")}</dd></dl>
    <div class="row" style="margin-top:12px">${M.agentUpdating ? `<span class="spin"></span><span class="muted">Atualizando o agente. Os servidores continuam ligados.</span>` : `<button class="btn ${can ? "violet" : ""}" data-m="agent-update"><i class="i i-circle-arrow-up"></i>${can ? "Atualizar o agente" : "Reinstalar o agente"}</button>${can ? "" : `<span class="faint">Já está na versão mais nova.</span>`}`}</div>`;
}
function paintUpdates() {
  const el = $("#sysUpdates"); if (!el || !M.updates) return;
  const sec = M.updates.filter((p) => p.security).length;
  el.innerHTML = !M.updates.length ? `<p class="muted" style="margin:0">Tudo em dia. Clique em Procurar atualizações para conferir de novo.</p>`
    : `<p style="margin:0 0 8px"><span>${M.updates.length === 1 ? "1 pacote para atualizar" : `${M.updates.length} pacotes para atualizar`}</span>${sec ? ` <span data-noi18n>·</span> <b style="color:var(--warn)">${sec} de segurança</b>` : ""}</p>
      <div class="m-scroll" style="max-height:220px"><table class="m-table"><thead><tr><th>Pacote</th><th>Atual</th><th>Nova</th></tr></thead><tbody>${M.updates.map((p) => `<tr><td data-noi18n>${p.security ? `<i class="i i-shield" style="color:var(--warn)"></i> ` : ""}${esc(p.name)}</td><td class="faint mono" data-noi18n>${esc(p.from)}</td><td class="mono" data-noi18n>${esc(p.version)}</td></tr>`).join("")}</tbody></table></div>`;
}
const JOB_TITLE = { "apt-check": "Procurando atualizações", "apt-upgrade": "Instalando atualizações", power: "Parando os servidores" };
function paintJob() {
  const el = $("#jobBox"); if (!el) return;
  const j = M.job; if (!j) { el.innerHTML = ""; return; }
  el.innerHTML = `<div class="row" style="margin-top:12px">${j.state === "running" ? `<span class="spin"></span>` : `<i class="i i-${j.state === "done" ? "check" : "x"}" style="color:var(--${j.state === "done" ? "ok" : "bad"})"></i>`}<b>${esc(JOB_TITLE[j.kind] || j.kind)}</b></div><div class="jobbox" id="jobLog" data-noi18n>${esc(j.lines.join("\n"))}</div>`;
  const log = $("#jobLog"); if (log) log.scrollTop = log.scrollHeight;
}
// eventos da tarefa em andamento
function machineJobEvent(d) {
  if (!M.job || M.job.id !== d.id) M.job = { id: d.id, kind: d.kind, state: "running", lines: [] };
  if (d.line != null) {
    M.job.lines.push(d.line); if (M.job.lines.length > 800) M.job.lines.shift();
    const log = $("#jobLog");
    if (log) { const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30; log.textContent += (log.textContent ? "\n" : "") + d.line; if (stick) log.scrollTop = log.scrollHeight; return; }
  }
  if (d.state) M.job.state = d.state;
  paintJob();
  if (d.state && d.state !== "running") {
    toast(d.state === "done" ? "Tarefa concluída" : "A tarefa falhou: veja o texto", d.state === "done" ? "ok" : "err");
    if (d.kind.startsWith("apt") && S.nodeTab === "system") sys("/updates").then((u) => { M.updates = u.packages; paintUpdates(); }).catch(() => {});
  }
}
function paintId() {
  const el = $("#sysId"), o = M.over; if (!el || !o) return;
  el.innerHTML = `<div class="form"><label>Nome na rede<div class="row"><input type="text" id="sysHost" class="grow mono" value="${esc(o.hostname)}" data-noi18n><button class="btn" data-m="set-host">Salvar</button></div></label>
    <label>Fuso horário<div class="row"><select id="sysTz" class="grow" data-noi18n>${(M.tz && M.tz.length ? M.tz : [o.timezone]).map((z) => `<option ${z === o.timezone ? "selected" : ""}>${esc(z)}</option>`).join("")}</select><button class="btn" data-m="set-tz">Salvar</button></div><span class="hint">Os agendamentos dos servidores seguem este horário.</span></label>
    <span class="faint">${o.ntp ? "O relógio está sincronizado pela internet." : "O relógio não está sincronizado pela internet."}</span></div>`;
  const hint = $("#wolHint");
  if (hint) hint.textContent = o.mac ? "Para ligar de novo pelo Hub, ative o Wake-on-LAN na BIOS da máquina." : "";
}
function paintHubs() {
  const el = $("#sysHubs"), i = S.nodeInfo; if (!el || !i) return;
  el.innerHTML = `<table class="m-table"><tbody>${i.clients.map((c) => `<tr><td data-noi18n>${esc(c.name)}</td><td class="faint">${c.lastUsed ? new Date(c.lastUsed).toLocaleString() : ""}</td></tr>`).join("")}</tbody></table>
    <div class="row" style="margin-top:12px"><button class="btn" data-m="pair-code"><i class="i i-key"></i>Código para outro Hub</button><b class="mono" id="newCode" data-noi18n></b></div>`;
}

// ---------------------------------------------------------------- serviços
function servicesTab() {
  return `<div class="card"><div class="m-tools"><label class="grow">Procurar<input type="text" id="svcQ" value="${esc(M.svcQuery)}" data-noi18n></label><button class="btn" data-m="svc-refresh"><i class="i i-refresh-cw"></i>Atualizar</button></div><div class="m-scroll" style="max-height:66vh" id="svcList">${empty(`<span class="spin"></span>`)}</div></div>`;
}
const mountServices = guard(async () => {
  const q = $("#svcQ"); q.oninput = () => { M.svcQuery = q.value; paintServices(); };
  paintServices();
  M.services = await sys("/services"); paintServices();
});
function paintServices() {
  const el = $("#svcList"); if (!el || !M.services) return;
  const k = M.svcQuery.trim().toLowerCase();
  const rank = (s) => (s.active === "failed" ? 0 : s.active === "active" ? 1 : 2);
  const rows = M.services.filter((s) => !k || `${s.name} ${s.description}`.toLowerCase().includes(k)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const pill = (s) => `<span class="pill ${s.active === "active" ? "running" : s.active === "failed" ? "install_failed" : "offline"}">${s.active === "active" ? "Rodando" : s.active === "failed" ? "Com defeito" : "Parado"}</span>`;
  el.innerHTML = `<table class="m-table"><thead><tr><th>Serviço</th><th>Estado</th><th>Ao ligar</th><th></th></tr></thead><tbody>${rows.map((s) => `<tr><td><b class="mono" data-noi18n>${esc(s.name.replace(/\.service$/, ""))}</b><div class="faint cut" data-noi18n>${esc(s.description)}</div></td><td>${pill(s)}</td>
    <td>${s.enabled === "enabled" ? "Liga sozinho" : s.enabled === "disabled" ? "Não liga" : `<span class="faint" data-noi18n>${esc(s.enabled)}</span>`}</td>
    <td class="num"><button class="btn sm ghost" data-m="svc-logs" data-v="${esc(s.name)}" title="Logs"><i class="i i-scroll-text"></i></button>
      ${s.active === "active" ? `<button class="btn sm ghost" data-m="svc" data-a="restart" data-v="${esc(s.name)}" title="Reiniciar"><i class="i i-rotate-ccw"></i></button>${s.protected ? "" : `<button class="btn sm ghost" data-m="svc" data-a="stop" data-v="${esc(s.name)}" title="Parar"><i class="i i-square"></i></button>`}` : `<button class="btn sm ghost" data-m="svc" data-a="start" data-v="${esc(s.name)}" title="Iniciar"><i class="i i-play"></i></button>`}
      ${s.protected || !["enabled", "disabled"].includes(s.enabled) ? "" : `<button class="btn sm ghost" data-m="svc" data-a="${s.enabled === "enabled" ? "disable" : "enable"}" data-v="${esc(s.name)}">${s.enabled === "enabled" ? "Não ligar" : "Ligar sozinho"}</button>`}</td></tr>`).join("") || `<tr><td>Nenhum serviço encontrado.</td></tr>`}</tbody></table>`;
}

// ---------------------------------------------------------------- rede e firewall
function networkTab() {
  return `<div class="card"><div class="row" style="margin-bottom:10px;flex-wrap:wrap"><h3 class="h grow" style="margin:0"><i class="i i-shield"></i>Firewall</h3><span id="fwBtn"></span></div><div id="fwBody">${empty(`<span class="spin"></span>`)}</div></div>
    <div class="m-grid"><div class="card"><h3 class="h"><i class="i i-network"></i>Placas de rede</h3><div id="netIf"></div></div>
    <div class="card"><h3 class="h"><i class="i i-globe"></i>Portas abertas nesta máquina</h3><div class="m-scroll" id="netPorts"></div></div></div>`;
}
const mountNetwork = guard(async () => { paintNetwork(); M.net = await sys("/network"); paintNetwork(); });
function paintNetwork() {
  const n = M.net; if (!n || !$("#fwBody")) return;
  const f = n.firewall;
  $("#fwBtn").innerHTML = !f.installed ? "" : f.active ? `<button class="btn" data-m="fw" data-a="disable"><i class="i i-shield-off"></i>Desligar o firewall</button>` : `<button class="btn violet" data-m="fw" data-a="enable"><i class="i i-shield-check"></i>Ligar o firewall</button>`;
  $("#fwBody").innerHTML = !f.installed ? `<p class="muted" style="margin:0">O ufw não está instalado nesta máquina.</p>` : `
    <p class="faint" style="margin-top:0">${f.active ? "Ligado." : "Desligado: nada está sendo filtrado."} As portas dos servidores abertas pelo Docker passam direto pelo ufw e não dependem destas regras. Ao ligar, as portas do agente e do SSH são liberadas antes.</p>
    ${f.rules.length ? `<table class="m-table"><thead><tr><th>Porta</th><th>Regra</th><th>De onde</th><th></th></tr></thead><tbody>${f.rules.map((r) => `<tr><td class="mono" data-noi18n>${esc(r.to)}</td><td>${r.action === "ALLOW" ? "Permitir" : r.action === "DENY" ? "Bloquear" : `<span data-noi18n>${esc(r.action)}</span>`}</td><td class="faint" data-noi18n>${esc(r.from)}</td><td class="num"><button class="btn sm ghost" data-m="fw-del" data-v="${r.n}" title="Apagar regra"><i class="i i-trash-2"></i></button></td></tr>`).join("")}</tbody></table>` : ""}
    <div class="m-tools" style="margin:12px 0 0"><label>Porta<input type="number" id="fwPort" min="1" max="65535" style="width:110px"></label>
      <label>Protocolo<select id="fwProto"><option value="tcp">TCP</option><option value="udp">UDP</option><option value="both">TCP+UDP</option></select></label>
      <label>Regra<select id="fwRule"><option value="allow">Permitir</option><option value="deny">Bloquear</option></select></label><button class="btn" data-m="fw-add"><i class="i i-plus"></i>Adicionar</button></div>`;
  $("#netIf").innerHTML = n.interfaces.map((i) => `<div class="sensor"><span class="mono" data-noi18n>${esc(i.name)}</span><b>${i.state === "up" ? "Conectada" : "Sem cabo"}${i.speed ? ` <span class="faint" data-noi18n>· ${i.speed} Mbps</span>` : ""}</b><span class="faint mono" style="grid-column:1/-1" data-noi18n>${esc(i.ips.join(", "))} ${esc(i.mac)}</span></div>`).join("");
  $("#netPorts").innerHTML = `<table class="m-table"><thead><tr><th>Porta</th><th>Protocolo</th><th>Programa</th></tr></thead><tbody>${n.listening.map((l) => `<tr><td class="mono" data-noi18n>${l.port}</td><td data-noi18n>${esc(l.proto.toUpperCase())}</td><td data-noi18n>${esc(l.program)}</td></tr>`).join("")}</tbody></table>`;
}

// ---------------------------------------------------------------- Docker
function dockerTab() { return `<div id="dockBody">${empty(`<span class="spin"></span>`)}</div>`; }
const mountDocker = guard(async () => { paintDocker(); M.dock = await sys("/docker", "GET", null, 130000); paintDocker(); });
function paintDocker() {
  const d = M.dock, el = $("#dockBody"); if (!d || !el) return;
  el.innerHTML = `<div class="stats"><div class="stat"><div class="top"><i class="i i-box"></i>Versão</div><b data-noi18n>${esc(d.version)}</b><span class="faint">${d.running} rodando · ${d.stopped} parados</span></div>
      <div class="stat"><div class="top"><i class="i i-package"></i>Imagens</div><b>${bytes(d.disk.images)}</b><span class="faint">${d.images.length === 1 ? "1 imagem" : `${d.images.length} imagens`}</span></div>
      <div class="stat"><div class="top"><i class="i i-hard-drive"></i>Contêineres</div><b>${bytes(d.disk.containers)}</b><span class="faint">${d.containers.length} no total</span></div>
      <div class="stat"><div class="top"><i class="i i-hard-drive"></i>Volumes</div><b>${bytes(d.disk.volumes)}</b><span class="faint">&nbsp;</span></div></div>
    <div class="card"><div class="row" style="margin-bottom:10px;flex-wrap:wrap"><h3 class="h grow" style="margin:0"><i class="i i-trash-2"></i>Liberar espaço</h3><button class="btn" data-m="prune" data-v="images">Apagar imagens sem uso</button><button class="btn" data-m="prune" data-v="containers">Apagar contêineres parados</button></div>
      <p class="faint" style="margin:0">Os arquivos dos servidores nunca são apagados. Os contêineres parados dos servidores do Piphin ficam, e uma imagem apagada é baixada de novo quando for preciso.</p></div>
    <div class="m-grid"><div class="card"><h3 class="h"><i class="i i-package"></i>Imagens</h3><div class="m-scroll"><table class="m-table"><thead><tr><th>Imagem</th><th class="num">Tamanho</th><th class="num">Em uso</th></tr></thead><tbody>${d.images.map((i) => `<tr><td class="mono cut" data-noi18n>${esc(i.tags[0] || i.id.slice(7, 19))}</td><td class="num">${bytes(i.size)}</td><td class="num">${i.containers > 0 ? "Sim" : "Não"}</td></tr>`).join("")}</tbody></table></div></div>
    <div class="card"><h3 class="h"><i class="i i-box"></i>Contêineres</h3><div class="m-scroll"><table class="m-table"><thead><tr><th>Nome</th><th>Estado</th></tr></thead><tbody>${d.containers.map((c) => `<tr><td class="mono cut" data-noi18n>${esc(c.name)}</td><td data-noi18n>${esc(c.status)}</td></tr>`).join("")}</tbody></table></div></div></div>`;
}

// ---------------------------------------------------------------- logs
function logsTab() {
  const q = M.logQ, pr = [["", "Todas as mensagens"], ["3", "Só erros"], ["4", "Erros e avisos"]];
  return `<div class="card"><div class="m-tools"><label>Serviço<input type="text" id="logUnit" placeholder="ssh.service" value="${esc(q.unit)}" class="mono" data-noi18n></label>
      <label>Mostrar<select id="logPrio">${pr.map(([v, t]) => `<option value="${v}" ${q.priority === v ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      <label class="grow">Procurar<input type="text" id="logGrep" value="${esc(q.grep)}" data-noi18n></label><label class="chk" style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="logKern" ${q.kernel ? "checked" : ""}>Só o kernel</label>
      <button class="btn violet" data-m="log-load"><i class="i i-refresh-cw"></i>Ver</button></div><div class="logbox" id="logOut" data-noi18n></div></div>`;
}
const mountLogs = () => loadLogs();
const loadLogs = guard(async () => {
  const q = M.logQ, p = new URLSearchParams({ lines: q.lines });
  if (q.unit) p.set("unit", /\.service$/.test(q.unit) ? q.unit : `${q.unit}.service`);
  if (q.priority) p.set("priority", q.priority);
  if (q.grep) p.set("grep", q.grep);
  if (q.kernel) p.set("kernel", "1");
  const el = $("#logOut"); if (!el) return;
  el.textContent = "...";
  const lines = await sys(`/logs?${p}`);
  el.textContent = lines.join("\n");
  el.scrollTop = el.scrollHeight;
});

// ---------------------------------------------------------------- terminal
const TERMS = {}; // máquina -> { list: [{ sid, term, fit, host, title, lost }], active }
const termsOf = (id) => (TERMS[id] = TERMS[id] || { list: [], active: null, checked: false });
const TERM_THEME = { background: "#0b0b12", foreground: "#e6e6f0", cursor: "#a78bfa", selectionBackground: "rgba(129,140,248,.35)", black: "#1b1b26", red: "#f87171", green: "#4ade80", yellow: "#fbbf24", blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#e6e6f0", brightBlack: "#6b7280", brightRed: "#fca5a5", brightGreen: "#86efac", brightYellow: "#fde047", brightBlue: "#93c5fd", brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite: "#ffffff" };
function terminalTab() { return `<div class="term-tabs" id="termTabs"></div><div id="termBox" data-noi18n></div><p class="faint" style="margin:8px 0 0">Terminal de administrador (root) da máquina, pela conexão segura do agente, sem senha. Copiar: Ctrl+Shift+C ou selecionar e clicar com o botão direito. Colar: Ctrl+Shift+V ou botão direito.</p>`; }
function termCreate(nodeId, sid) {
  const host = document.createElement("div"); host.className = "term-host";
  const term = new Terminal({ cursorBlink: true, fontFamily: "Cascadia Mono, Consolas, monospace", fontSize: 13, theme: TERM_THEME, scrollback: 5000, allowProposedApi: false });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit);
  const t = { sid, term, fit, host, node: nodeId, opened: false, lost: false };
  term.onData((data) => { if (t.lost) return; call("term-input", { node: nodeId, sid, data }).catch(() => {}); });
  let timer = null;
  term.onResize(({ cols, rows }) => { clearTimeout(timer); timer = setTimeout(() => call("term-resize", { node: nodeId, sid, cols, rows }).catch(() => {}), 150); });
  const paste = async () => { try { const text = await navigator.clipboard.readText(); if (text) term.paste(text); } catch { toast("Não deu para ler a área de transferência", "err"); } };
  const copySel = () => { const s = term.getSelection(); if (s) navigator.clipboard.writeText(s).catch(() => {}); return !!s; };
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey) return true;
    if (e.code === "KeyC") { copySel(); return false; }
    if (e.code === "KeyV") { paste(); return false; }
    return true;
  });
  host.addEventListener("contextmenu", (e) => { e.preventDefault(); if (copySel()) term.clearSelection(); else paste(); });
  return t;
}
const termActive = (id) => { const g = termsOf(id); return g.list.find((t) => t.sid === g.active) || null; };
function paintTermTabs() {
  const el = $("#termTabs"); if (!el) return;
  const g = termsOf(S.view.node);
  el.innerHTML = g.list.map((t, i) => `<button class="tt ${t.sid === g.active ? "on" : ""}" data-m="term-pick" data-v="${t.sid}"><i class="i i-terminal"></i><span data-noi18n>${i + 1}</span>${t.lost ? ` <span class="faint">desconectado</span>` : ""}<span data-m="term-close" data-v="${t.sid}" title="Fechar sessão"><i class="i i-x"></i></span></button>`).join("")
    + `<button class="btn sm" data-m="term-new"><i class="i i-plus"></i>Nova sessão</button>`;
}
function showActiveTerm() {
  const box = $("#termBox"); if (!box) return;
  const t = termActive(S.view.node);
  box.replaceChildren(...(t ? [t.host] : []));
  paintTermTabs();
  if (!t) return;
  if (!t.opened) { t.term.open(t.host); t.opened = true; }
  try { t.fit.fit(); } catch {}
  t.term.focus();
}
const mountTerminal = guard(async () => {
  const id = S.view.node, g = termsOf(id);
  const box = $("#termBox");
  if (M.termObs) M.termObs.disconnect();
  M.termObs = new ResizeObserver(() => { const t = termActive(S.view.node); if (t && t.opened && S.nodeTab === "terminal") { try { t.fit.fit(); } catch {} } });
  M.termObs.observe(box);
  showActiveTerm();
  // sessões que continuam vivas no agente (o Hub foi fechado, por exemplo)
  if (!g.checked) {
    g.checked = true;
    for (const s of await call("term-list", id)) {
      if (g.list.some((t) => t.sid === s.id)) continue;
      const t = termCreate(id, s.id); g.list.push(t); g.active = g.active || s.id;
      await call("term-attach", { node: id, sid: s.id });
    }
  }
  if (!g.list.length) await termNew(id); else showActiveTerm();
});
async function termNew(id) {
  const g = termsOf(id), t0 = termActive(id);
  const opened = await call("term-open", { node: id, cols: t0 ? t0.term.cols : 120, rows: t0 ? t0.term.rows : 30 });
  g.list.push(termCreate(id, opened.id)); g.active = opened.id;
  // o que chegou antes de a tela existir fica guardado em pendingTerm
  const t = termActive(id), pend = pendingTerm[opened.id]; if (pend) { t.term.write(pend); delete pendingTerm[opened.id]; }
  showActiveTerm();
}
const pendingTerm = {};
piphin.on("term-data", ({ node, sid, data }) => {
  const t = termsOf(node).list.find((x) => x.sid === sid);
  if (t) t.term.write(data); else pendingTerm[sid] = (pendingTerm[sid] || "") + data;
});
piphin.on("term-exit", ({ node, sid }) => {
  const g = termsOf(node), t = g.list.find((x) => x.sid === sid); if (!t) return;
  t.lost = true; t.term.write("\r\n\x1b[90m--- sessão encerrada ---\x1b[0m\r\n");
  if (S.view.node === node && S.nodeTab === "terminal") paintTermTabs();
});

// ---------------------------------------------------------------- cliques
document.addEventListener("click", guard(async (e) => {
  const nt = e.target.closest("[data-ntab]");
  if (nt) { S.nodeTab = nt.dataset.ntab; M.tick = 0; renderMain(); return; }
  const a = e.target.closest("[data-m]"); if (!a) return;
  const act = a.dataset.m, v = a.dataset.v, id = S.view.node;
  if (act === "wake") {
    await call("node-wake", id); toast("Pedido enviado. A máquina precisa estar com o Wake-on-LAN ativo na BIOS", "ok"); return; }
  if (act === "range") { M.range = v; $$("[data-m=range]").forEach((b) => b.classList.toggle("on", b === a)); M.hist = await sys(`/history?range=${v}`); drawCharts(); return; }
  if (act === "kill") {
    if (!(await confirmBox(`Parar ${a.dataset.name}?`, "O programa recebe o pedido para fechar. Se for um servidor, o Piphin pode ligá-lo de novo.", "Parar", true))) return;
    await sys(`/processes/${a.dataset.pid}/kill`, "POST", { signal: "SIGTERM" }); toast("Pedido enviado", "ok"); return loadProcs();
  }
  if (act === "agent-update") {
    if (!(await confirmBox("Atualizar o agente?", "O Hub perde o contato por alguns segundos. Os servidores continuam ligados.", "Atualizar", false))) return;
    const before = agentVersion();
    await sys("/agent-update", "POST"); M.agentUpdating = true; paintAgent();
    const t0 = Date.now();
    while (Date.now() - t0 < 180000) {
      await new Promise((r) => setTimeout(r, 4000));
      if (S.view.node !== id) break;
      const info = await call("node-info", id).catch(() => null);
      if (info && (info.version !== before || Date.now() - t0 > 60000)) { S.nodeInfo = info; break; }
    }
    M.agentUpdating = false;
    if (S.view.node !== id) return;
    if (S.nodeInfo && S.nodeInfo.version !== before) toast("Agente atualizado", "ok");
    else toast("A atualização não mudou a versão", "err");
    return renderMain();
  }
  if (act === "power") {
    const reboot = v === "reboot", n = srvList(id).filter((s) => s.state === "running" || s.state === "starting").length;
    const ok = await confirmBox(reboot ? "Reiniciar a máquina?" : "Desligar a máquina?", `${n === 1 ? "1 servidor ligado vai parar." : `${n} servidores ligados vão parar.`} ${reboot ? "Ela volta sozinha em alguns minutos." : "Para ligar de novo, é preciso o botão da máquina ou o Wake-on-LAN."}`, reboot ? "Reiniciar" : "Desligar", true);
    if (!ok) return;
    M.job = await sys("/power", "POST", { action: v }, 120000); paintJob(); toast(reboot ? "Reiniciando a máquina" : "Desligando a máquina", "info"); return;
  }
  if (act === "apt-check") { M.job = await sys("/updates/check", "POST"); return paintJob(); }
  if (act === "apt-install" || act === "apt-full") {
    const full = act === "apt-full";
    if (!(await confirmBox(full ? "Instalar tudo?" : "Instalar as atualizações?", full ? "Instala tudo, e pode trocar ou remover pacotes quando precisar. Se o Docker for atualizado, os servidores reiniciam." : "Se o Docker for atualizado, os servidores reiniciam.", "Instalar", false))) return;
    M.job = await sys("/updates/install", "POST", { full }); return paintJob();
  }
  if (act === "set-host") { await sys("/hostname", "POST", { hostname: $("#sysHost").value.trim() }); toast("Salvo", "ok"); return; }
  if (act === "set-tz") { await sys("/timezone", "POST", { timezone: $("#sysTz").value }); toast("Salvo", "ok"); return; }
  if (act === "pair-code") { const r = await sys("/pair-code", "POST"); $("#newCode").textContent = r.code; return; }
  if (act === "svc-refresh") { M.services = await sys("/services"); return paintServices(); }
  if (act === "svc-logs") { M.logQ.unit = v; S.nodeTab = "logs"; return renderMain(); }
  if (act === "svc") {
    const risky = a.dataset.a === "stop" && /^(ssh|sshd|docker|networking|systemd-networkd|NetworkManager)\.service$/.test(v);
    if (risky && !(await confirmBox(`Parar ${v}?`, "Parar este serviço pode derrubar os servidores ou o acesso à máquina.", "Parar", true))) return;
    a.disabled = true;
    await sys(`/services/${encodeURIComponent(v)}/${a.dataset.a}`, "POST", null, 100000);
    await new Promise((r) => setTimeout(r, 500));
    M.services = await sys("/services"); return paintServices();
  }
  if (act === "fw") {
    if (a.dataset.a === "disable" && !(await confirmBox("Desligar o firewall?", "Todas as portas desta máquina ficam sem filtro.", "Desligar", true))) return;
    M.net.firewall = await sys("/firewall", "POST", { action: a.dataset.a }); return paintNetwork();
  }
  if (act === "fw-add") { M.net.firewall = await sys("/firewall", "POST", { action: "add", port: Number($("#fwPort").value), proto: $("#fwProto").value, rule: $("#fwRule").value }); return paintNetwork(); }
  if (act === "fw-del") { if (!(await confirmBox("Apagar esta regra?", "", "Apagar", true))) return; M.net.firewall = await sys("/firewall", "POST", { action: "delete", n: Number(v) }); return paintNetwork(); }
  if (act === "prune") {
    if (!(await confirmBox(v === "images" ? "Apagar imagens sem uso?" : "Apagar contêineres parados?", "Os arquivos dos servidores não são apagados.", "Apagar", true))) return;
    const r = await sys("/docker/prune", "POST", { what: v }, 620000);
    toast(`${bytes(r.SpaceReclaimed || 0)} liberados`, "ok");
    M.dock = await sys("/docker", "GET", null, 130000); return paintDocker();
  }
  if (act === "log-load") { M.logQ = { ...M.logQ, unit: $("#logUnit").value.trim(), priority: $("#logPrio").value, grep: $("#logGrep").value, kernel: $("#logKern").checked }; return loadLogs(); }
  if (act === "term-close") {
    e.stopPropagation();
    const g = termsOf(id), t = g.list.find((x) => x.sid === v); if (!t) return;
    await call("term-close", { node: id, sid: v }).catch(() => {});
    t.term.dispose(); t.host.remove(); g.list = g.list.filter((x) => x !== t);
    if (g.active === v) g.active = g.list.length ? g.list[g.list.length - 1].sid : null;
    return showActiveTerm();
  }
  if (act === "term-pick") { termsOf(id).active = v; return showActiveTerm(); }
  if (act === "term-new") return termNew(id);
}));
