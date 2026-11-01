// Piphin Agent · agendamentos (formato cron: minuto hora dia mês dia-da-semana) de cada servidor
"use strict";

// "*/15", "1-5", "0,30", "*" -> conjunto de números válidos
function field(spec, min, max) {
  const out = new Set();
  for (const part of String(spec).split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`Agendamento inválido: ${spec}`);
    let a = min, b = max;
    if (m[2] != null) { a = Number(m[2]); b = m[3] != null ? Number(m[3]) : (m[4] ? max : a); }
    const step = Number(m[4] || 1);
    if (a < min || b > max || a > b || step < 1) throw new Error(`Agendamento inválido: ${spec}`);
    for (let x = a; x <= b; x += step) out.add(x);
  }
  return out;
}
function parse(expr) {
  const p = String(expr).trim().split(/\s+/);
  if (p.length !== 5) throw new Error("Use 5 campos: minuto hora dia mês dia-da-semana");
  return { m: field(p[0], 0, 59), h: field(p[1], 0, 23), dom: field(p[2], 1, 31), mon: field(p[3], 1, 12), dow: field(p[4].replace(/7/g, "0"), 0, 6), domAny: p[2] === "*", dowAny: p[4] === "*" };
}
function matches(c, d) {
  if (!c.m.has(d.getMinutes()) || !c.h.has(d.getHours()) || !c.mon.has(d.getMonth() + 1)) return false;
  const dom = c.dom.has(d.getDate()), dow = c.dow.has(d.getDay());
  return c.domAny || c.dowAny ? dom && dow : dom || dow; // igual ao cron: dia OU dia-da-semana quando os dois são escolhidos
}
// próxima vez que roda (para mostrar no painel)
function next(expr, from = new Date()) {
  const c = parse(expr), d = new Date(from); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60; i++) { if (matches(c, d)) return d.getTime(); d.setMinutes(d.getMinutes() + 1); }
  return null;
}

function start(servers, backups, log) {
  let lastMinute = -1;
  const tick = async () => {
    const d = new Date(), key = Math.floor(d.getTime() / 60000);
    if (key === lastMinute) return; lastMinute = key;
    for (const s of servers.map.values()) {
      for (const job of s.schedules || []) {
        if (!job.enabled) continue;
        let c; try { c = parse(job.cron); } catch { continue; }
        if (!matches(c, d)) continue;
        job.last = Date.now(); servers.save(s);
        servers.system(s.id, `Agendamento: ${({ restart: "reiniciar", start: "ligar", stop: "desligar", backup: "backup", command: "comando" })[job.action] || job.action}`);
        try {
          if (job.action === "backup") await backups.create(s.id, { auto: true, note: "agendado" });
          else if (job.action === "command") servers.command(s.id, job.payload);
          else await servers.power(s.id, job.action);
        } catch (e) { servers.system(s.id, `O agendamento falhou: ${e.message}`); log("agendamento", s.id, e.message); }
      }
    }
  };
  setInterval(() => tick().catch(() => {}), 15000).unref();
}

module.exports = { parse, next, start };
