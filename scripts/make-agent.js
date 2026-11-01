// Gera dist/piphin-agent.tar.gz (o agente para o Ubuntu) e copia o instalador para dist/install.sh.
// O instalador baixa esses dois arquivos da última versão no GitHub.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const stage = path.join(root, "dist", "agent-stage");
const out = path.join(root, "dist", "piphin-agent.tar.gz");
const pkg = require(path.join(root, "package.json"));

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(path.join(root, "agent", "src"), path.join(stage, "src"), { recursive: true });
fs.cpSync(path.join(root, "agent", "templates"), path.join(stage, "templates"), { recursive: true });
// o agente e o módulo saem sempre com a mesma versão
const apkg = JSON.parse(fs.readFileSync(path.join(root, "agent", "package.json"), "utf8"));
apkg.version = pkg.version;
fs.writeFileSync(path.join(stage, "package.json"), JSON.stringify(apkg, null, 2));
// o instalador do Linux precisa de LF
const sh = fs.readFileSync(path.join(root, "agent", "install.sh"), "utf8").replace(/\r\n/g, "\n");
fs.writeFileSync(path.join(root, "dist", "install.sh"), sh);

fs.rmSync(out, { force: true });
const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
execFileSync(tar, ["-czf", out, "-C", stage, "."], { stdio: "inherit" });
fs.rmSync(stage, { recursive: true, force: true });
console.log("agente:", out, `(${(fs.statSync(out).size / 1024).toFixed(0)} KB) · instalador: dist/install.sh`);
