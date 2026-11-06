// Piphin Server · Meus jogos: os jogos próprios (um build do jogo enviado do PC) e os servidores criados a partir deles.
// Usa as funções de app.js. O assistente de novo servidor chama gamesPane; a aba Configurações do servidor chama paintGameSect.
const GAMES_MIN_AGENT = "1.3.0";
const UNREAL_TEMPLATE = "unreal-game";
const when = (t) => new Date(t).toLocaleString();
const tplName = (tpls, id) => { const t = tpls.find((x) => x.id === id); return t ? t.name : id; };

// pacote novo: envia e, se tiver servidores usando o jogo, oferece atualizar todos
async function sendGameVersion(nodeId, g) {
  const v = await call("game-upload", { node: nodeId, game: g.id });
  if (!v) return null;
  toast("Pacote enviado", "ok");
  const list = g.servers || [];
  if (list.length && await confirmBox(list.length === 1 ? "Atualizar o servidor agora?" : `Atualizar os ${list.length} servidores agora?`, "Os que estiverem ligados desligam, recebem a versão nova e ligam de novo. Os saves continuam.", "Atualizar", false)) {
    for (const s of list) {
      try { await call("server-game-update", { node: nodeId, server: s.id }); toast(`${s.name}: atualizado`, "ok"); } catch (e) { toast(`${s.name}: ${e.message}`, "err"); }
    }
    await loadServers(nodeId); renderSide();
  }
  return v;
}

// o painel "Meus jogos" dentro do assistente
async function gamesPane(o) {
  const { nodeId, catTabs, bindCats, configure } = o;
  const shell = (body) => {
    $("#wiz").innerHTML = `${catTabs()}${body}<div class="modal-actions"><button class="btn" data-x>Cancelar</button></div>`;
    box.querySelector("[data-x]").onclick = closeModal; bindCats();
  };
  shell(`<div class="empty"><span class="spin"></span></div>`);
  const info = await call("node-info", nodeId);
  if (olderThan(info.version, GAMES_MIN_AGENT)) {
    shell(`<div class="card"><p style="margin-top:0"><b>Atualize o agente para usar os Meus jogos</b></p>
      <p class="muted">Esta máquina está com o agente <span data-noi18n>${esc(info.version)}</span>. Atualize com um clique na aba Sistema da máquina. Os servidores continuam ligados.</p>
      <button class="btn violet" data-go-system><i class="i i-circle-arrow-up"></i>Ir para a aba Sistema</button></div>`);
    box.querySelector("[data-go-system]").onclick = () => { closeModal(); show("node", nodeId); S.nodeTab = "system"; renderMain(); };
    return;
  }
  const list = await call("games", nodeId);
  const card = (g) => {
    const v = g.versions[0];
    return `<div class="egg-item game-card"><button class="tpl" data-game="${esc(g.id)}"><div class="ic"><i class="i i-joystick"></i></div><div><b data-noi18n>${esc(g.name)}</b><br>
      <span>${v ? `<span>Versão de <span data-noi18n>${esc(when(v.at))}</span></span> · ${bytes(v.size)}` : "Ainda sem pacote"}</span><br>
      <span class="faint"><span data-noi18n>${esc(tplName(o.tpls(), g.template))}</span> · ${g.servers.length === 1 ? "1 servidor" : `${g.servers.length} servidores`}</span></div></button>
      <div class="row" style="position:absolute;top:6px;right:6px;gap:2px"><button class="btn sm ghost" data-game-send="${esc(g.id)}" title="Enviar nova versão"><i class="i i-upload"></i></button><button class="btn sm ghost" data-game-del="${esc(g.id)}" title="Apagar jogo"><i class="i i-trash-2"></i></button></div></div>`;
  };
  shell(`<p class="faint" style="margin:0 0 12px">Os seus jogos: envie o pacote do servidor (por exemplo o build Linux da Unreal) uma vez e crie quantos servidores quiser. Para atualizar, envie a versão nova: os saves continuam.</p>
    <div class="tpl-grid" id="gameList">${list.map(card).join("")}<div class="egg-item"><button class="tpl" data-game-new><div class="ic"><i class="i i-plus"></i></div><div><b>Adicionar jogo</b><br><span>Nome, como o jogo roda e o pacote</span></div></button></div></div>`);
  $("#gameList").onclick = guard(async (ev) => {
    const send = ev.target.closest("[data-game-send]");
    if (send) { const g = list.find((x) => x.id === send.dataset.gameSend); if (await sendGameVersion(nodeId, g)) gamesPane(o); return; }
    const del = ev.target.closest("[data-game-del]");
    if (del) {
      const g = list.find((x) => x.id === del.dataset.gameDel);
      if (!(await confirmBox(`Apagar ${g.name}?`, "Os pacotes guardados na máquina são apagados. Os servidores precisam ser apagados antes.", "Apagar", true))) return;
      await call("game-delete", { node: nodeId, game: g.id }); toast("Jogo apagado", "ok"); return gamesPane(o);
    }
    if (ev.target.closest("[data-game-new]")) return newGameForm(o);
    const open = ev.target.closest("[data-game]"); if (!open) return;
    const g = list.find((x) => x.id === open.dataset.game);
    if (!g.versions.length) { if (await sendGameVersion(nodeId, g)) gamesPane(o); return; }
    const t = o.tpls().find((x) => x.id === g.template);
    if (!t) throw new Error("O modelo deste jogo não existe mais nesta máquina: apague o jogo e adicione de novo");
    configure(t, g);
  });
}

// cadastrar um jogo: nome, como roda (o Unreal automático ou um egg desta máquina) e o primeiro pacote
function newGameForm(o) {
  const { nodeId } = o;
  const eggs = () => o.tpls().filter((t) => t.egg);
  const options = () => `<option value="${UNREAL_TEMPLATE}">Jogo Unreal: acha o servidor sozinho no pacote</option>${eggs().map((t) => `<option value="${esc(t.id)}" data-noi18n>${esc(t.name)} (egg)</option>`).join("")}<option value="@egg">Importar um egg (.json)...</option>`;
  $("#wiz").innerHTML = `<div class="form">
      <div class="row"><button class="btn sm ghost" data-back><i class="i i-chevron-left"></i>Voltar</button><b>Adicionar jogo</b></div>
      <label>Nome do jogo<input type="text" id="gName" maxlength="60" data-noi18n></label>
      <label>Como o jogo roda<select id="gTpl">${options()}</select>
        <span class="hint">Jogo Unreal: roda o <span data-noi18n>&lt;Projeto&gt;Server.sh</span> do pacote, ou o jogo normal sem tela hospedando um mapa. Use um egg quando o jogo tem um jeito próprio de ligar (por exemplo, vários processos ao mesmo tempo).</span></label>
      <p class="faint" style="margin:0">Depois você escolhe o pacote no PC: <span data-noi18n>.tar.gz</span>, <span data-noi18n>.tar</span> ou <span data-noi18n>.zip</span>. Ele fica guardado na máquina, com as 3 versões mais novas.</p>
    </div><div class="modal-actions"><button class="btn" data-x>Cancelar</button><button class="btn violet" data-game-save><i class="i i-upload"></i>Escolher o pacote e enviar</button></div>`;
  box.querySelector("[data-back]").onclick = () => gamesPane(o);
  box.querySelector("[data-x]").onclick = closeModal;
  const sel = $("#gTpl");
  sel.onchange = guard(async () => {
    if (sel.value !== "@egg") return;
    sel.value = UNREAL_TEMPLATE;
    const t = await call("egg-import-file", { node: nodeId });
    if (!t) return;
    await o.reloadTpls(); toast("Egg importado", "ok");
    sel.innerHTML = options(); sel.value = t.id;
    if (!$("#gName").value) $("#gName").value = t.name;
  });
  box.querySelector("[data-game-save]").onclick = guard(async () => {
    const btn = box.querySelector("[data-game-save]");
    const name = $("#gName").value.trim();
    if (!name) { $("#gName").focus(); throw new Error("Dê um nome ao jogo"); }
    btn.disabled = true;
    try {
      const g = await call("game-create", { node: nodeId, name, template: sel.value });
      const v = await call("game-upload", { node: nodeId, game: g.id });
      if (!v) toast("Jogo criado sem pacote: envie quando quiser", "info"); else toast("Jogo adicionado", "ok");
      gamesPane(o);
    } finally { btn.disabled = false; }
  });
}

// aba Configurações de um servidor de jogo próprio: a versão em uso, atualizar e voltar
const paintGameSect = guard(async () => {
  const el = $("#gameSect"), s = S.srv; if (!el || !s || !s.game) return;
  const nodeId = S.view.node, serverId = s.id;
  const g = (await call("games", nodeId)).find((x) => x.id === s.game);
  if (!$("#gameSect") || S.srv.id !== serverId) return;
  if (!g) { el.innerHTML = `<p class="muted" style="margin:0">O jogo deste servidor não existe mais nos Meus jogos.</p>`; return; }
  const cur = g.versions.find((v) => v.id === s.gameVersion), newest = g.versions[0];
  el.innerHTML = `<div class="row" style="flex-wrap:wrap;margin-bottom:10px"><h3 class="h grow" style="margin:0"><i class="i i-joystick"></i><span data-noi18n>${esc(g.name)}</span></h3>
      <button class="btn" data-game-send-here><i class="i i-upload"></i>Enviar nova versão</button>
      ${newest && newest.id !== s.gameVersion ? `<button class="btn violet" data-game-apply="${esc(newest.id)}"><i class="i i-circle-arrow-up"></i>Atualizar para a mais nova</button>` : ""}</div>
    <table class="m-table"><tbody>${g.versions.map((v) => `<tr><td><span data-noi18n>${esc(when(v.at))}</span>${v.id === s.gameVersion ? ` <span class="badge">Em uso</span>` : ""}${v === newest ? ` <span class="badge">Mais nova</span>` : ""}</td><td class="num">${bytes(v.size)}</td>
      <td class="num">${v.id === s.gameVersion ? "" : `<button class="btn sm ghost" data-game-apply="${esc(v.id)}">${v === newest ? "Usar esta" : "Voltar para esta"}</button>`}</td></tr>`).join("")}</tbody></table>
    ${cur ? "" : `<p class="faint" style="margin:8px 0 0">A versão instalada não está mais guardada na máquina.</p>`}
    <div class="row" style="margin-top:12px;flex-wrap:wrap;gap:8px"><span class="faint">Como o jogo roda:</span><b data-noi18n>${esc(tplName(S.templates[nodeId] || [], s.template))}</b><span class="grow"></span><button class="btn sm" data-game-tpl><i class="i i-refresh-cw"></i>Trocar</button></div>`;
  el.onclick = guard(async (ev) => {
    if (ev.target.closest("[data-game-tpl]")) return changeGameTemplate(nodeId, serverId);
    if (ev.target.closest("[data-game-send-here]")) { await sendGameVersion(nodeId, g); S.srv = await call("server-get", { node: nodeId, server: serverId }); return paintGameSect(); }
    const ap = ev.target.closest("[data-game-apply]"); if (!ap) return;
    const on = S.srv.state !== "offline";
    if (!(await confirmBox("Trocar a versão do jogo?", on ? "O servidor desliga, recebe esta versão e liga de novo. Os saves continuam." : "O servidor recebe esta versão. Os saves continuam.", "Trocar", false))) return;
    ap.disabled = true; ap.innerHTML = `<span class="spin"></span>`;
    S.srv = await call("server-game-update", { node: nodeId, server: serverId, version: ap.dataset.gameApply });
    toast("Versão trocada", "ok");
    paintGameSect();
  });
});

// trocar como o jogo de um servidor roda: escolhe o modelo, preenche as opções dele e o servidor instala de novo por cima
async function changeGameTemplate(nodeId, serverId) {
  delete S.templates[nodeId];
  const tpls = await templatesOf(nodeId), s = S.srv;
  const opts = tpls.filter((t) => (t.egg || t.id === UNREAL_TEMPLATE) && t.id !== s.template);
  if (!opts.length) { toast("Importe um egg pelos Meus jogos (Adicionar jogo) para ter outra opção", "info"); return; }
  const form = (t) => `<div class="form" id="tplVars">${t.vars.map((v) => varInput(v, s.vars[v.key] ?? v.default, "t")).join("")}</div>`;
  openModal(`<h3>Como o jogo roda</h3><div class="form"><label>Modelo<select id="tplPick">${opts.map((t) => `<option value="${esc(t.id)}" data-noi18n>${esc(t.name)}${t.egg ? " (egg)" : ""}</option>`).join("")}</select></label>
    <p class="faint" style="margin:0">O servidor desliga e instala de novo com o modelo escolhido. Os arquivos do jogo e os saves continuam.</p><div id="tplForm"></div></div>
    <div class="modal-actions"><button class="btn" data-x>Cancelar</button><button class="btn violet" data-tpl-ok><i class="i i-refresh-cw"></i>Trocar</button></div>`, "mid");
  const pick = () => { $("#tplForm").innerHTML = form(opts.find((t) => t.id === $("#tplPick").value)); };
  $("#tplPick").onchange = pick; pick();
  box.querySelector("[data-x]").onclick = closeModal;
  box.querySelector("[data-tpl-ok]").onclick = guard(async () => {
    const btn = box.querySelector("[data-tpl-ok]"); btn.disabled = true; btn.innerHTML = `<span class="spin"></span>`;
    try {
      S.srv = await call("server-template", { node: nodeId, server: serverId, template: $("#tplPick").value, vars: readVars($("#tplForm")) });
      closeModal(); toast("Modelo trocado: instalando de novo", "ok");
      await loadServers(nodeId); S.tab = "console"; renderSide(); renderMain();
    } finally { btn.disabled = false; btn.innerHTML = `<i class="i i-refresh-cw"></i>Trocar`; }
  });
}
