// Ambiente de teste local: Docker falso + Piphin Agent (porta 18443, descoberta na 8444) numa pasta temporária.
// Grava o código de pareamento em <pasta>/code.txt.  uso: node test/dev-env.js <pasta>
"use strict";
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DIR = path.resolve(process.argv[2] || path.join(require("os").tmpdir(), "piphin-dev-env"));
const ROOT = path.join(__dirname, "..");
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "30", "-subj", "/CN=piphin-dev", "-keyout", path.join(DIR, "key.pem"), "-out", path.join(DIR, "cert.pem")], { stdio: "ignore" });
fs.writeFileSync(path.join(DIR, "config.json"), JSON.stringify({ name: "ubuntu-teste", port: 18443, discoveryPort: 8444, dataDir: path.join(DIR, "data"), key: path.join(DIR, "key.pem"), cert: path.join(DIR, "cert.pem") }));
const env = { ...process.env, PIPHIN_CONFIG: path.join(DIR, "config.json"), PIPHIN_DOCKER: "http://127.0.0.1:2375", ...require("./fake-system").setup(DIR) };
const dock = spawn(process.execPath, [path.join(__dirname, "fake-docker.js"), "2375"], { stdio: "inherit" });
setTimeout(() => {
  const out = execFileSync(process.execPath, [path.join(ROOT, "agent/src/main.js"), "pair"], { env }).toString();
  fs.writeFileSync(path.join(DIR, "code.txt"), /([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)[1]);
  const agent = spawn(process.execPath, [path.join(ROOT, "agent/src/main.js"), "run"], { env, stdio: "inherit" });
  const bye = () => { agent.kill(); dock.kill(); process.exit(0); };
  process.on("SIGTERM", bye); process.on("SIGINT", bye);
}, 600);
