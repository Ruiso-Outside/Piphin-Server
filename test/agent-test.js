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
const env = { ...process.env, ...require("./fake-system").setup(TMP), PIPHIN_TRACE: process.env.DEBUG ? "1" : "", PIPHIN_CONFIG: path.join(TMP, "config.json"), PIPHIN_DOCKER: `http://127.0.0.1:${DPORT}` };
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

    console.log("eggs do Pterodactyl");
    const egg = { meta: { version: "PTDL_v2" }, name: "Paper Teste", author: "t@t", description: "d", features: ["eula"], docker_images: { "Java 21": "ghcr.io/ptero-eggs/yolks:java_21" },
      startup: "java -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} --port {{server.build.default.port}}",
      config: { files: JSON.stringify({ "server.properties": { parser: "properties", find: { "server-ip": "0.0.0.0", "server-port": "{{server.build.default.port}}", motd: "{{server.build.env.MOTD}}" } }, "../fora.txt": { parser: "properties", find: { a: "1" } } }), startup: JSON.stringify({ done: ")! For help, type " }), logs: "{}", stop: "stop" },
      scripts: { installation: { script: "#!/bin/ash\r\necho instalando\r\n", container: "ghcr.io/ptero-eggs/installers:alpine", entrypoint: "ash" } },
      variables: [{ name: "Jar", env_variable: "SERVER_JARFILE", default_value: "server.jar", user_viewable: true, user_editable: true, rules: "required|string" },
        { name: "Motd", env_variable: "MOTD", default_value: "oi", user_viewable: true, user_editable: true, rules: "nullable|string" },
        { name: "Build", env_variable: "BUILD", default_value: "fixo", user_viewable: false, user_editable: false, rules: "string" },
        { name: "Query", env_variable: "QUERY_PORT", default_value: "27100", user_viewable: true, user_editable: true, rules: "required|numeric|between:1,65535" },
        { name: "Banco", env_variable: "DATABASE_PORT", default_value: "3306", user_viewable: true, user_editable: true, rules: "numeric" },
        { name: "Ligado", env_variable: "ATIVO", default_value: "1", user_viewable: true, user_editable: true, rules: "required|boolean" }] };
    ok((await api("POST", "/api/eggs", { egg: { name: "x" } })).status === 400, "arquivo que não é egg é recusado");
    r = await api("POST", "/api/eggs", { egg, slug: "games-paper-teste" });
    ok(r.status === 200 && r.body.id === "egg-games-paper-teste" && r.body.category === "eggs", "importa o egg");
    ok(!JSON.stringify(r.body).includes("instalando") && !r.body.vars.some((v) => v.key === "BUILD"), "o painel não recebe o script nem as variáveis fixas");
    ok(r.body.vars.find((v) => v.key === "ATIVO").options[0].value === "1", "regra boolean vira Sim/Não com os valores do egg");
    ok((await api("POST", "/api/servers", { template: "egg-games-paper-teste", vars: { PIPHIN_EULA: "false" } })).status >= 400, "egg com EULA pede o aceite");
    r = await api("POST", "/api/servers", { template: "egg-games-paper-teste", name: "Do Egg", vars: { PIPHIN_EULA: "true", BUILD: "mudado" }, extraPorts: "28000, 28001", ports: [30100] });
    ok(r.status === 200 && r.body.egg && r.body.ports[0].host === 30100 && r.body.ports[0].protocol === "both", "cria o servidor na porta pedida, TCP e UDP");
    const eid = r.body.id;
    ok(r.body.ports.map((p) => p.host).join() === "30100,27100,28000,28001", "abre as portas das variáveis e as extras, mas não a do banco");
    ok(r.body.vars.BUILD === "fixo", "variável fixa não muda");
    ok(await until(async () => (await api("GET", `/api/servers/${eid}`)).body.state === "running", 20000), "instala e fica 'running' com a frase do egg");
    let con = (await api("GET", `/api/servers/${eid}/console`)).body.map((l) => l.s).join("\n");
    ok(/egg: ash \/mnt\/install\/install\.sh · #!\/bin\/ash\r?$/m.test(con) && !/#!\/bin\/ash\r/.test(con), "roda o script no /mnt/install, sem os CRLF");
    ok(con.includes("STARTUP=java -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}} --port {{SERVER_PORT}} cmd=nao"), "a imagem recebe a linha de início em STARTUP, sem Cmd");
    ok(/portas=.*30100\/tcp.*30100\/udp/.test(con), "publica TCP e UDP");
    const eggData = path.join(TMP, "data", "servers", eid, "data");
    const props = fs.readFileSync(path.join(eggData, "server.properties"), "utf8");
    ok(props.includes("server-port=30100") && props.includes("motd=oi") && props.includes("server-ip=0.0.0.0"), "ajusta o server.properties do egg");
    ok(fs.readFileSync(path.join(eggData, "eula.txt"), "utf8").includes("eula=true"), "grava o EULA aceito");
    ok(!fs.existsSync(path.join(TMP, "data", "servers", eid, "fora.txt")), "arquivo do egg não sai da pasta do servidor");
    r = await api("PATCH", `/api/servers/${eid}`, { vars: { QUERY_PORT: "27200" }, extraPorts: "" });
    ok(r.body.ports.map((p) => p.host).join() === "30100,27200", "mudar a variável muda a porta aberta");
    ok((await api("DELETE", "/api/eggs/egg-games-paper-teste")).status === 409, "egg em uso não pode ser apagado");
    r = await api("POST", `/api/servers/${eid}/power`, { action: "stop" });
    ok(await until(async () => (await api("GET", `/api/servers/${eid}`)).body.state === "offline"), "desliga com o comando do egg");
    ok((await api("DELETE", `/api/servers/${eid}`)).status === 200 && (await api("DELETE", "/api/eggs/egg-games-paper-teste")).status === 200, "apaga o servidor e depois o egg");
    ok(!(await api("GET", "/api/templates")).body.some((t) => t.egg), "o egg sai da lista");
    await api("POST", "/api/eggs", { egg, slug: "games-fica" });

    console.log("monitoramento");
    await sleep(5500);
    r = await api("GET", "/api/system/monitor");
    ok(r.status === 200 && r.body.cpu.cores.length === 4 && r.body.cpu.cores[3].mhz === 3700, "uso e frequência por núcleo");
    ok(r.body.cpu.cores.every((c) => c.pct >= 0 && c.pct <= 100) && r.body.cpu.cores[3].pct > r.body.cpu.cores[0].pct, "cada núcleo com o seu uso");
    ok(r.body.cpuTemp === 61 && r.body.temps.length === 3 && r.body.temps[0].crit === 100, "temperaturas: a do processador é o sensor do pacote");
    ok(r.body.fans[0].rpm === 1180, "ventoinhas");
    ok(r.body.memory.total === 32768000 * 1024 && r.body.memory.cached > 0, "memória detalhada");
    ok(r.body.net.length === 1 && r.body.net[0].name === "eno1", "rede por placa, sem as virtuais");
    ok(r.body.io.length === 1 && r.body.io[0].name === "sda" && r.body.mounts.length === 1 && r.body.mounts[0].device === "/dev/sda1", "discos reais, sem loop e tmpfs");
    ok(r.body.alerts.some((a) => a.code === "temp" && /nvme/.test(a.sensor)) && r.body.alerts.some((a) => a.code === "reboot") && r.body.alerts.some((a) => a.code === "services" && a.count === 1), "alertas: sensor quente, reinício pedido, serviço com defeito");
    ok((await api("GET", "/api/system/history")).body.length >= 2, "histórico guardado no agente");
    ok((await api("GET", "/api/system/monitor", null, { headers: { Authorization: "Bearer errado" } })).status === 401, "sem token certo: nada de dados da máquina");
    r = await api("GET", "/api/system/processes");
    ok(r.body.some((p) => p.pid === 1234 && p.name === "java server" && p.rss === 250000 * 4096 && p.cmd === "java -jar server.jar"), "processos com nome, memória e comando");
    ok((await api("POST", "/api/system/processes/1/kill", { signal: "SIGKILL" })).status === 400, "não para o processo 1");
    ok((await api("POST", "/api/system/processes/2/kill", { signal: "rm -rf" })).status === 400, "sinal inválido recusado");
    r = await api("GET", "/api/system/smart");
    ok(r.body.available && r.body.disks[0].healthy === true && r.body.disks[0].temp === 41 && r.body.disks[0].wear === 3, "saúde dos discos");

    console.log("atualizações e tarefas");
    const jobDone = async () => until(async () => { const j = (await api("GET", "/api/system/job")).body; return j && j.state !== "running"; });
    r = await api("GET", "/api/system/updates");
    ok(r.body.packages.length === 2 && r.body.packages[1].security && r.body.packages[0].from === "8.5.0-2ubuntu10.5", "lista os pacotes e marca os de segurança");
    ok((await api("POST", "/api/system/updates/check")).body.state === "running" && await jobDone(), "procurar atualizações roda em segundo plano");
    r = await api("POST", "/api/system/updates/install", { full: false });
    ok(r.status === 200 && (await jobDone()), "instalar atualizações");
    r = await api("GET", "/api/system/job");
    ok(r.body.state === "done" && r.body.lines.some((l) => /upgrade/.test(l)), "a tarefa guarda o texto");
    const calls = () => JSON.parse(fs.readFileSync(env.PIPHIN_FAKE_STATE, "utf8")).calls;
    ok(calls().some((c) => /^apt-get upgrade -y .*force-confold/.test(c)), "apt sem perguntas e mantendo as configurações");

    console.log("serviços, rede e firewall");
    r = await api("GET", "/api/system/services");
    ok(r.body.length === 5 && r.body.find((s) => s.name === "nginx.service").enabled === "disabled" && r.body.find((s) => s.name === "piphin-agent.service").protected, "serviços com estado e sem os inexistentes");
    ok((await api("POST", "/api/system/services/nginx.service/start")).status === 200, "liga um serviço");
    ok((await api("POST", "/api/system/services/piphin-agent.service/stop")).status === 400, "não deixa parar o próprio agente");
    ok((await api("POST", "/api/system/services/x%3Brm.service/stop")).status === 400, "nome de serviço esquisito é recusado");
    r = await api("GET", "/api/system/logs?unit=ssh.service&lines=50&priority=3&grep=erro");
    ok(r.body[0].includes("-u ssh.service") && r.body[0].includes("-p 3") && r.body[0].includes("--grep erro"), "logs com filtros");
    r = await api("GET", "/api/system/network");
    ok(r.body.interfaces.some((i) => i.name === "eno1" && i.speed === 1000 && i.mac) && r.body.listening.some((x) => x.port === 22 && x.program === "sshd"), "placas de rede e portas abertas");
    ok(r.body.firewall.active && r.body.firewall.rules.length === 3 && r.body.firewall.rules[0].to === "8443/tcp", "lê o firewall");
    r = await api("POST", "/api/system/firewall", { action: "add", port: 8080, proto: "tcp", rule: "allow" });
    ok(r.body.rules.some((x) => x.to === "8080/tcp"), "abre uma porta");
    ok((await api("POST", "/api/system/firewall", { action: "add", port: PORT, proto: "tcp", rule: "deny" })).status === 400, "não deixa bloquear a porta do agente");
    ok((await api("POST", "/api/system/firewall", { action: "add", port: "22;rm", proto: "tcp", rule: "allow" })).status === 400, "porta inválida recusada");
    await api("POST", "/api/system/firewall", { action: "disable" });
    r = await api("POST", "/api/system/firewall", { action: "enable" });
    ok(r.body.active && r.body.rules.some((x) => x.to === PORT + "/tcp") && r.body.rules.some((x) => x.to === "22/tcp"), "ligar o firewall libera antes o agente e o SSH");
    const agentRule = r.body.rules.find((x) => x.to === PORT + "/tcp");
    ok((await api("POST", "/api/system/firewall", { action: "delete", n: agentRule.n })).status === 400, "não tira a regra do agente");
    ok((await api("POST", "/api/system/firewall", { action: "delete", n: r.body.rules.find((x) => x.to === "8080/tcp").n })).status === 200, "tira outra regra");

    console.log("sistema e Docker");
    r = await api("GET", "/api/system/overview");
    ok(r.body.timezone === "Etc/UTC" && r.body.rebootRequired && r.body.rebootPackages[0] === "linux-image-generic", "fuso e reinício pedido");
    ok((await api("POST", "/api/system/timezone", { timezone: "America/Sao_Paulo" })).status === 200 && (await api("GET", "/api/system/overview")).body.timezone === "America/Sao_Paulo", "muda o fuso");
    ok((await api("POST", "/api/system/timezone", { timezone: "a; reboot" })).status === 400, "fuso esquisito recusado");
    ok((await api("POST", "/api/system/hostname", { hostname: "bad name" })).status === 400, "nome inválido recusado");
    r = await api("POST", "/api/system/agent-update");
    ok(r.status === 200 && JSON.parse(fs.readFileSync(env.PIPHIN_FAKE_STATE, "utf8")).agentUpdate.includes("PIPHIN_UPDATE=1"), "atualiza o agente fora do serviço");
    r = await api("POST", "/api/system/pair-code");
    ok(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r.body.code), "gera código para parear outro Hub");
    r = await api("GET", "/api/system/docker");
    ok(r.status === 200 && r.body.images[0].tags[0] === "eclipse-temurin:21-jre" && r.body.containers.find((c) => c.name === "piphin-x").piphin && !r.body.containers.find((c) => c.name === "outro").piphin, "imagens e contêineres do Docker");
    r = await api("POST", "/api/system/docker/prune", { what: "containers" });
    ok(/label!/.test(r.body.filters) && /piphin\.server/.test(r.body.filters), "a limpeza poupa os contêineres dos servidores");

    console.log("terminal");
    const tls = require("tls");
    const attach = (id, tok = token) => new Promise((resolve, reject) => {
      const s = tls.connect({ host: "127.0.0.1", port: PORT, rejectUnauthorized: false }, () => s.write(`GET /api/terminals/${id}/attach HTTP/1.1\r\nHost: a\r\nConnection: Upgrade\r\nUpgrade: piphin-terminal\r\nAuthorization: Bearer ${tok}\r\n\r\n`));
      s.text = ""; s.on("data", (d) => { s.text += d.toString("utf8"); }); s.on("error", () => {});
      setTimeout(() => resolve(s), 400);
    });
    r = await api("POST", "/api/terminals", { cols: 100, rows: 40 });
    const tid = r.body.id;
    ok(r.status === 200 && tid && r.body.cols === 100, "abre um terminal");
    const bad = await attach(tid, "errado");
    ok(bad.text.startsWith("HTTP/1.1 401"), "terminal sem token certo é recusado");
    bad.destroy();
    let sock = await attach(tid);
    ok(sock.text.startsWith("HTTP/1.1 101") && /root@ubuntu-teste/.test(sock.text), "conecta e recebe o prompt");
    sock.write("acentos\r");
    ok(await until(() => sock.text.includes("ação ✓"), 3000), "manda comando e recebe a resposta com acentos");
    await api("POST", `/api/terminals/${tid}/resize`, { cols: 80, rows: 20 });
    sock.write("tamanho\r");
    ok(await until(() => sock.text.includes("80x20"), 3000), "muda o tamanho");
    sock.destroy(); await sleep(300);
    ok((await api("GET", "/api/terminals")).body.find((t) => t.id === tid).attached === false, "desconectar não mata a sessão");
    sock = await attach(tid);
    ok(sock.text.includes("80x20"), "ao voltar, mostra o que já tinha na tela");
    sock.write("exit\r");
    ok(await until(async () => !(await api("GET", "/api/terminals")).body.some((t) => t.id === tid), 3000), "exit fecha a sessão");
    ok((await api("POST", "/api/terminals/ffff/resize", { cols: 80, rows: 20 })).body.ok === false, "sessão que não existe");

    console.log("meus jogos");
    // dois pacotes de mentira com a cara de um build Linux da Unreal
    const TAR = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    const mkPkg = (ver, file) => {
      const d = fs.mkdtempSync(path.join(TMP, "pkg-"));
      fs.mkdirSync(path.join(d, "Engine", "Binaries", "Linux"), { recursive: true });
      fs.writeFileSync(path.join(d, "Engine", "Binaries", "Linux", "UnrealGame"), "bin");
      fs.writeFileSync(path.join(d, "MEUJOGO.sh"), "#!/bin/sh\n");
      fs.writeFileSync(path.join(d, "versao.txt"), ver);
      const out = path.join(TMP, file);
      execFileSync(TAR, ["-czf", out, "-C", d, "."]);
      return out;
    };
    const putPkg = (gid, file, name) => api("PUT", `/api/games/${gid}/package?name=${encodeURIComponent(name)}`, fs.readFileSync(file), { headers: { "Content-Type": "application/octet-stream" } });
    ok((await api("POST", "/api/games", { name: "Meu Jogo", template: "nao-existe" })).status === 400, "jogo com modelo que não existe é recusado");
    r = await api("POST", "/api/games", { name: "Meu Jogo", template: "unreal-game" });
    const gid = r.body.id;
    ok(r.status === 200 && gid && r.body.versions.length === 0, "cria o jogo");
    ok((await api("GET", "/api/templates")).body.find((t) => t.id === "unreal-game").hidden === true, "o modelo do Unreal fica escondido dos outros");
    ok((await api("POST", "/api/servers", { game: gid })).status >= 400, "sem pacote não cria servidor");
    ok((await putPkg(gid, mkPkg("1", "a.tar.gz"), "../../x.exe")).status === 400, "só aceita pacote .tar.gz, .tar ou .zip");
    r = await putPkg(gid, mkPkg("1", "v1.tar.gz"), "MeuJogo-Linux.tar.gz");
    ok(r.status === 200 && r.body.size > 0 && r.body.sha256.length === 64, "recebe o pacote e guarda o hash");
    const v1 = r.body.id;
    r = await api("POST", "/api/servers", { game: gid, ports: [27500], vars: { MAP: "/Game/Maps/Teste" }, autostart: false });
    ok(r.status === 200 && r.body.game === gid && r.body.name === "Meu Jogo" && r.body.ports[0].protocol === "udp", "cria o servidor a partir do jogo");
    const gsid = r.body.id, gdata = path.join(TMP, "data", "servers", gsid, "data");
    ok(await until(async () => (await api("GET", `/api/servers/${gsid}`)).body.state === "offline" && fs.existsSync(path.join(gdata, "game", "versao.txt")), 15000), "extrai o pacote na pasta do jogo");
    ok((await api("GET", `/api/servers/${gsid}`)).body.gameVersion === v1, "guarda a versão instalada");
    // o jogo criou saves; a versão nova não pode apagar
    fs.mkdirSync(path.join(gdata, "game", "MEUJOGO", "Saved"), { recursive: true });
    fs.writeFileSync(path.join(gdata, "game", "MEUJOGO", "Saved", "conta.sav"), "save");
    r = await putPkg(gid, mkPkg("2", "v2.tar.gz"), "MeuJogo-Linux.tar.gz");
    const v2 = r.body.id;
    r = await api("GET", "/api/games");
    ok(r.body[0].versions[0].id === v2 && r.body[0].servers[0].version === v1, "a lista mostra a versão nova e a que o servidor usa");
    await api("POST", `/api/servers/${gsid}/power`, { action: "start" });
    await until(async () => (await api("GET", `/api/servers/${gsid}`)).body.state !== "offline", 8000);
    r = await api("POST", `/api/servers/${gsid}/game-update`, {});
    ok(r.status === 200 && r.body.gameVersion === v2 && fs.readFileSync(path.join(gdata, "game", "versao.txt"), "utf8") === "2", "atualiza o jogo do servidor");
    ok(fs.existsSync(path.join(gdata, "game", "MEUJOGO", "Saved", "conta.sav")), "os saves continuam depois de atualizar");
    ok(await until(async () => (await api("GET", `/api/servers/${gsid}`)).body.state !== "offline", 8000), "estava ligado: liga de novo depois de atualizar");
    r = await api("POST", `/api/servers/${gsid}/game-update`, { version: v1 });
    ok(r.body.gameVersion === v1 && fs.readFileSync(path.join(gdata, "game", "versao.txt"), "utf8") === "1", "volta para uma versão anterior");
    const con2 = (await api("GET", `/api/servers/${gsid}/console`)).body.map((l) => l.s).join("\n");
    ok(/MAP=|iniciando: \/bin\/sh -c cd \/home\/container\/game/.test(con2), "liga com o executável do pacote");
    for (let i = 0; i < 3; i++) await putPkg(gid, mkPkg("x" + i, `x${i}.tar.gz`), "MeuJogo-Linux.tar.gz");
    r = await api("GET", "/api/games");
    ok(r.body[0].versions.length === 3 && fs.readdirSync(path.join(TMP, "data", "games", gid)).filter((f) => f.endsWith(".tar.gz")).length === 3, "guarda só as 3 versões mais novas");
    ok((await api("DELETE", `/api/games/${gid}`)).status === 409, "jogo em uso não pode ser apagado");
    await api("POST", `/api/servers/${gsid}/power`, { action: "kill" });
    ok((await api("DELETE", `/api/servers/${gsid}`)).status === 200 && (await api("DELETE", `/api/games/${gid}`)).status === 200 && !fs.existsSync(path.join(TMP, "data", "games", gid)), "apaga o servidor e depois o jogo, com os pacotes");
    // com um egg (jogo com um jeito próprio de ligar): o pacote vai para a pasta game, junto do que o script do egg criou
    r = await api("POST", "/api/games", { name: "Jogo do Egg", template: "egg-games-fica" });
    const gid2 = r.body.id;
    await putPkg(gid2, mkPkg("egg", "e.tar.gz"), "Jogo.tar.gz");
    r = await api("POST", "/api/servers", { game: gid2, vars: { PIPHIN_EULA: "true" }, autostart: false });
    const esid = r.body.id;
    ok(r.status === 200 && r.body.egg && await until(async () => fs.existsSync(path.join(TMP, "data", "servers", esid, "data", "game", "versao.txt")), 15000), "jogo próprio com egg: instala o egg e extrai o pacote");
    // trocar como o jogo roda: de um egg para o Jogo Unreal e de volta, mantendo os saves
    const esdata = path.join(TMP, "data", "servers", esid, "data");
    fs.mkdirSync(path.join(esdata, "game", "Saved"), { recursive: true }); fs.writeFileSync(path.join(esdata, "game", "Saved", "conta.sav"), "save");
    ok((await api("POST", `/api/servers/${esid}/template`, { template: "minecraft-paper" })).status === 400, "não troca para um modelo comum");
    r = await api("POST", `/api/servers/${esid}/template`, { template: "unreal-game", vars: { MAP: "/Game/X" } });
    ok(r.status === 200 && r.body.template === "unreal-game" && !r.body.egg && r.body.vars.MAP === "/Game/X" && r.body.ports[0].protocol === "udp", "troca o egg pelo Jogo Unreal");
    ok(await until(async () => (await api("GET", `/api/servers/${esid}`)).body.state === "offline", 15000) && fs.existsSync(path.join(esdata, "game", "Saved", "conta.sav")) && fs.existsSync(path.join(esdata, "game", "versao.txt")), "instala de novo e os saves continuam");
    ok((await api("GET", "/api/games")).body.find((g) => g.id === gid2).template === "unreal-game", "o jogo passa a usar o modelo novo");
    r = await api("POST", `/api/servers/${esid}/template`, { template: "egg-games-fica", vars: { PIPHIN_EULA: "true" } });
    ok(r.status === 200 && r.body.egg && r.body.ports.length >= 2, "volta para o egg, com as portas das opções");
    await until(async () => (await api("GET", `/api/servers/${esid}`)).body.state === "offline", 15000);
    await api("DELETE", `/api/servers/${esid}`); await api("DELETE", `/api/games/${gid2}`);

    console.log("identidade da máquina (impressão digital)");
    const { PinnedAgent } = require("../module/pinned");
    const pinned = (port, fp) => new Promise((resolve) => {
      const q = https.request({ host: "127.0.0.1", port, path: "/api/hello", agent: new PinnedAgent(fp), headers: { Authorization: "Bearer SEGREDO" } }, (res) => { res.resume(); res.on("end", () => resolve({ ok: res.statusCode, cert: res.socket && res.socket.getPeerCertificate ? 1 : 0 })); });
      q.on("error", (e) => resolve({ err: e.message })); q.end();
    });
    ok((await pinned(PORT, fingerprint)).ok === 200, "conecta com a impressão digital certa");
    ok((await pinned(PORT, "*")).ok === 200, "primeiro contato do pareamento");
    let spied = null;
    const impostor = https.createServer({ key: fs.readFileSync(path.join(TMP, "key.pem")), cert: fs.readFileSync(path.join(TMP, "cert.pem")) }, (req, res) => { spied = req.headers.authorization || "sem token"; res.end("{}"); });
    await new Promise((res) => impostor.listen(18998, res));
    const fake = "AA:" + fingerprint.slice(3).replace(/./g, (c) => c);
    r = await pinned(18998, fake === fingerprint ? "00:00" : fake);
    ok(/identidade da máquina mudou/.test(r.err || ""), "certificado diferente é recusado");
    ok(spied === null, "o token nunca chega a uma máquina impostora");
    impostor.close();

    console.log("reiniciar a máquina");
    r = await api("GET", `/api/servers`);
    const mine = r.body.find((s) => s.id === id);
    await api("POST", `/api/servers/${id}/power`, { action: "start" });
    await until(async () => (await api("GET", `/api/servers/${id}`)).body.state === "running", 15000);
    ok((await api("POST", "/api/system/power", { action: "explodir" })).status === 400, "ação de energia inválida");
    await jobDone();
    r = await api("POST", "/api/system/power", { action: "reboot" });
    ok(r.status === 200 && r.body.kind === "power", "reiniciar é uma tarefa com texto");
    await jobDone();
    ok(await until(async () => (await api("GET", `/api/servers/${id}`)).body.state === "offline", 15000), "para os servidores antes de reiniciar");
    ok(calls().includes("systemctl reboot"), "manda o sistema reiniciar");
    void mine;

    console.log("apagar e reiniciar o agente");
    ok((await api("DELETE", `/api/servers/${r2.body.id}`)).status === 200, "apaga um servidor");
    agent.kill(); await sleep(500);
    const again = spawn(process.execPath, [path.join(ROOT, "agent/src/main.js"), "run"], { env });
    await sleep(1500);
    r = await api("GET", "/api/servers");
    ok(r.body.length === 5 && !r.body.some((s) => s.id === r2.body.id), "depois de reiniciar, os servidores continuam (5)");
    ok((await api("GET", "/api/templates")).body.some((t) => t.id === "egg-games-fica"), "depois de reiniciar, os eggs continuam");
    again.kill();
  } catch (e) { fail++; console.log("ERRO", e.stack); }
  console.log(`\n${pass} ok, ${fail} falharam`);
  if (fail) console.log(agentLog.split(/\r?\n/).filter((l) => (process.env.DEBUG ? /TRACE|erro/.test(l) : true)).slice(-40).join("\n"));
  agent.kill(); dock.kill();
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
