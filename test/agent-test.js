// Teste do Piphin Agent contra o Docker de mentira: pareamento, criar, instalar, console, comandos, parar,
// arquivos (inclusive tentativas de sair da pasta), backups, agendamento, queda com reinício e apagar.
// uso: node test/agent-test.js   (sobe o Docker falso e o agente numa pasta temporária)
"use strict";
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "piphin-agent-"));
const PORT = 18443, DPORT = 2399;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ok  ", msg); } else { fail++; console.log("  FALHOU", msg); } };

// certificado e configuração de teste
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", "/CN=teste", "-keyout", path.join(TMP, "key.pem"), "-out", path.join(TMP, "cert.pem")], { stdio: "ignore" });
fs.writeFileSync(path.join(TMP, "config.json"), JSON.stringify({ name: "maquina-teste", port: PORT, discoveryPort: 18444, dataDir: path.join(TMP, "data"), key: path.join(TMP, "key.pem"), cert: path.join(TMP, "cert.pem") }));
const env = { ...process.env, PIPHIN_TRACE: process.env.DEBUG ? "1" : "", PIPHIN_CONFIG: path.join(TMP, "config.json"), PIPHIN_DOCKER: `http://127.0.0.1:${DPORT}` };
const fingerprint = new crypto.X509Certificate(fs.readFileSync(path.join(TMP, "cert.pem"))).fingerprint256;

let token = null;
function api(method, p, body, { raw = false, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const req = https.request({ host: "127.0.0.1", port: PORT, method, path: p, rejectUnauthorized: false,
      checkServerIdentity: (h, cert) => (cert.fingerprint256 === fingerprint ? undefined : new Error("impressão digital diferente")),
      headers: { ...(token ? { Authorization: "Bearer " + token } : {}), ...(data ? { "Content-Length": data.length, "Content-Type": "application/json" } : {}), ...headers } }, (res) => {
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => { const b = Buffer.concat(c); resolve({ status: res.statusCode, body: raw ? b : (() => { try { return JSON.parse(b); } catch { return b.toString(); } })() }); });
    });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(250); } return false; };

(async () => {
  const dock = spawn(process.execPath, [path.join(__dirname, "fake-docker.js"), String(DPORT)], { stdio: "ignore", env: { ...process.env, FAKE_LOG: process.env.DEBUG ? require("path").join(__dirname, "fake.log") : "" } });
  await sleep(600);
  const code = /([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(execFileSync(process.execPath, [path.join(ROOT, "agent/src/main.js"), "pair"], { env }).toString())[1];
  const agent = spawn(process.execPath, [path.join(ROOT, "agent/src/main.js"), "run"], { env });
  let agentLog = ""; agent.stdout.on("data", (d) => (agentLog += d)); agent.stderr.on("data", (d) => (agentLog += d));
  await sleep(1200);
  try {
    console.log("pareamento");
    let r = await api("GET", "/api/hello");
    ok(r.body.agent === "piphin" && r.body.pairing === true, "hello responde e mostra pareamento ativo");
    ok((await api("GET", "/api/servers")).status === 401, "sem token: acesso negado");
    ok((await api("POST", "/api/pair", { code: "AAAA-BBBB", client: "x" })).status === 403, "código errado recusado");
    r = await api("POST", "/api/pair", { code: code.toLowerCase(), client: "Hub de teste" });
    ok(r.status === 200 && r.body.token && r.body.fingerprint === fingerprint, "código certo (minúsculo) pareia e devolve o token");
    token = r.body.token;
    ok((await api("POST", "/api/pair", { code, client: "outro" })).status === 403, "o código só vale uma vez");

    console.log("máquina e modelos");
    r = await api("GET", "/api/node");
    ok(r.body.docker && r.body.docker.ok && r.body.info.cores > 0, "info da máquina e Docker ok");
    r = await api("GET", "/api/templates");
    ok(r.body.length >= 12 && !JSON.stringify(r.body).includes("apk add"), `${r.body.length} modelos, sem os scripts`);
    ok((await api("GET", "/api/node/stats")).body.memory.total > 0, "números da máquina");

    console.log("criar servidor");
    ok((await api("POST", "/api/servers", { template: "minecraft-paper", name: "MC", vars: { EULA: "false" } })).status >= 400, "Minecraft sem aceitar o EULA é recusado");
    r = await api("POST", "/api/servers", { template: "minecraft-paper", name: "Meu Minecraft", vars: { EULA: true, MAX_PLAYERS: 10 }, limits: { memory: 2048 } });
    ok(r.status === 200 && r.body.ports[0].host === 25565, "criado na porta 25565");
    const id = r.body.id;
    const r2 = await api("POST", "/api/servers", { template: "minecraft-paper", name: "Outro", vars: { EULA: true }, autostart: false });
    ok(r2.body.ports[0].host === 25566, "o segundo pega a porta seguinte (25566)");
    ok(await until(async () => (await api("GET", `/api/servers/${id}`)).body.state === "running", 20000), "instalou, iniciou e ficou 'running' quando apareceu 'Done ('");
    r = await api("GET", `/api/servers/${id}`);
    ok(r.body.image === "eclipse-temurin:21-jre", "a imagem do Java foi escolhida pela instalação (.piphin-image)");
    r = await api("GET", `/api/servers/${id}/console`);
    ok(r.body.some((l) => /Done \(/.test(l.s)) && r.body.some((l) => l.k === "install"), "console tem a instalação e o início");

    console.log("console e energia");
    ok((await api("POST", `/api/servers/${id}/command`, { line: "say oi" })).status === 200, "comando enviado");
    await sleep(400);
    ok((await api("GET", `/api/servers/${id}/console`)).body.some((l) => /comando recebido: say oi/.test(l.s)), "o servidor recebeu o comando pelo stdin");
    r = await api("GET", `/api/servers/${id}/stats`);
    ok(r.body.stats && r.body.stats.memory > 0, "uso de CPU e memória");
    r = await api("POST", `/api/servers/${id}/power`, { action: "stop" });
    ok(r.body.state === "offline", "parou com o comando 'stop'");
    { const con = (await api("GET", `/api/servers/${id}/console`)).body; ok(con.some((l) => /Stopping the server/.test(l.s)), "a parada usou o comando do jogo"); if (process.env.DEBUG) console.log(con.slice(-8).map((l) => l.k + " " + l.s).join(" | ")); }
    ok((await api("POST", `/api/servers/${id}/command`, { line: "x" })).status >= 400, "comando com o servidor desligado é recusado");

    console.log("arquivos");
    r = await api("GET", `/api/servers/${id}/files?path=/`);
    ok(r.body.items.some((f) => f.name === "server.jar"), "lista os arquivos");
    ok((await api("PUT", `/api/servers/${id}/files/content?path=/config/teste.txt`, { content: "olá" })).status === 200, "salva um arquivo de texto (cria a pasta)");
    ok((await api("GET", `/api/servers/${id}/files/content?path=/config/teste.txt`)).body.content === "olá", "lê o arquivo");
    for (const evil of ["../../config.json", "/../../../etc/passwd", "..\\..\\x"]) ok([403, 404].includes((await api("GET", `/api/servers/${id}/files/content?path=${encodeURIComponent(evil)}`)).status) || (await api("GET", `/api/servers/${id}/files/content?path=${encodeURIComponent(evil)}`)).body.path?.startsWith("/"), `não sai da pasta: ${evil}`);
    r = await api("PUT", `/api/servers/${id}/files/upload?path=/up/bin.dat`, crypto.randomBytes(300000), { headers: { "Content-Type": "application/octet-stream" } });
    ok(r.status === 200 && r.body.size === 300000, "envio de arquivo binário");
    r = await api("GET", `/api/servers/${id}/files/download?path=/up/bin.dat`, null, { raw: true });
    ok(r.status === 200 && r.body.length === 300000, "download do arquivo");
    ok((await api("POST", `/api/servers/${id}/files/rename`, { from: "/config/teste.txt", to: "/config/novo.txt" })).status === 200, "renomeia");
    ok((await api("POST", `/api/servers/${id}/files/delete`, { paths: ["/up"] })).status === 200, "apaga pasta");
    ok((await api("POST", `/api/servers/${id}/files/delete`, { paths: ["/"] })).status === 400, "não apaga a pasta principal");

    console.log("backups");
    r = await api("POST", `/api/servers/${id}/backups`, { note: "antes" });
    ok(r.status === 200 && r.body.size > 0, "backup criado");
    const bid = r.body.id;
    await api("POST", `/api/servers/${id}/files/delete`, { paths: ["/server.jar"] });
    r = await api("POST", `/api/servers/${id}/backups/${bid}/restore`);
    ok(r.status === 200 && (await api("GET", `/api/servers/${id}/files?path=/`)).body.items.some((f) => f.name === "server.jar"), "restaurou o arquivo apagado");
    r = await api("GET", `/api/servers/${id}/backups/${bid}/download`, null, { raw: true });
    ok(r.status === 200 && r.body[0] === 0x1f && r.body[1] === 0x8b, "download do backup (.tar.gz)");

    console.log("configurações, agendamentos e quedas");
    r = await api("PATCH", `/api/servers/${id}`, { name: "Minecraft da galera", limits: { memory: 3072 }, vars: { MAX_PLAYERS: 30 }, schedules: [{ cron: "0 4 * * *", action: "restart" }], ports: [25570] });
    ok(r.body.name === "Minecraft da galera" && r.body.limits.memory === 3072 && r.body.vars.MAX_PLAYERS === "30" && r.body.ports[0].host === 25570, "muda nome, memória, variável e porta");
    ok((await api("PATCH", `/api/servers/${id}`, { ports: [25566] })).status >= 400, "porta de outro servidor é recusada");
    ok((await api("GET", "/api/cron/next?expr=" + encodeURIComponent("0 4 * * *"))).body.next > Date.now(), "próxima execução do agendamento");
    await api("POST", `/api/servers/${id}/power`, { action: "start" });
    await until(async () => (await api("GET", `/api/servers/${id}`)).body.state === "running");
    await api("POST", `/api/servers/${id}/command`, { line: "crash" });
    ok(await until(async () => (await api("GET", `/api/servers/${id}/console`)).body.some((l) => /Reiniciando em 5 segundos/.test(l.s)), 5000), "queda percebida: vai reiniciar sozinho");
    ok(await until(async () => (await api("GET", `/api/servers/${id}`)).body.state === "running", 12000), "voltou a rodar depois da queda");
    if (process.env.DEBUG) console.log((await api("GET", `/api/servers/${id}/console`)).body.slice(-12).map((l) => l.k + " " + l.s).join(" | "), (await api("GET", `/api/servers/${id}`)).body.state);
    r = await api("POST", `/api/servers/${id}/power`, { action: "kill" });
    ok(r.body.state === "offline", "forçar parada");

    console.log("outros modelos");
    for (const t of ["discord-bot-node", "static-site", "redis", "valheim"]) {
      const vars = t === "redis" ? { REDIS_PASSWORD: "senha-forte-1" } : t === "valheim" ? { PASSWORD: "abcde12" } : {};
      r = await api("POST", "/api/servers", { template: t, vars, autostart: false });
      ok(r.status === 200, `cria ${t}${r.body.ports && r.body.ports.length ? " (portas " + r.body.ports.map((p) => p.host + "/" + p.protocol).join(", ") + ")" : ""}`);
    }
    ok((await api("POST", "/api/servers", { template: "valheim", vars: { PASSWORD: "123" } })).status >= 400, "Valheim com senha curta é recusado");

    console.log("apagar e reiniciar o agente");
    ok((await api("DELETE", `/api/servers/${r2.body.id}`)).status === 200, "apaga um servidor");
    agent.kill(); await sleep(500);
    const again = spawn(process.execPath, [path.join(ROOT, "agent/src/main.js"), "run"], { env });
    await sleep(1500);
    r = await api("GET", "/api/servers");
    ok(r.body.length === 5 && !r.body.some((s) => s.id === r2.body.id), "depois de reiniciar, os servidores continuam (5)");
    again.kill();
  } catch (e) { fail++; console.log("ERRO", e.stack); }
  console.log(`\n${pass} ok, ${fail} falharam`);
  if (fail) console.log(agentLog.split(/\r?\n/).filter((l) => (process.env.DEBUG ? /TRACE|erro/.test(l) : true)).slice(-40).join("\n"));
  agent.kill(); dock.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
