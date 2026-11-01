// App Node.js (site, API, bot de outra plataforma): escuta na porta da variável PORT
module.exports = {
  id: "node-app", order: 20, name: "App Node.js (site ou API)", category: "sites", icon: "code",
  description: "Qualquer programa em Node.js: sites (Express, Next.js), APIs e bots. O programa recebe a porta na variável PORT.",
  image: "node:22-bookworm-slim",
  images: [{ name: "Node.js 22", image: "node:22-bookworm-slim" }, { name: "Node.js 24", image: "node:24-bookworm-slim" }, { name: "Node.js 20", image: "node:20-bookworm-slim" }],
  installImage: "alpine:3.20",
  install: `apk add --no-cache git >/dev/null
if [ -n "$GIT_URL" ]; then
  echo "Clonando $GIT_URL..."
  git clone --depth 1 \${GIT_BRANCH:+--branch "$GIT_BRANCH"} "$GIT_URL" /tmp/repo
  cp -a /tmp/repo/. /mnt/server/
elif [ ! -f /mnt/server/package.json ]; then
  echo '{ "name": "meu-app", "version": "1.0.0", "main": "index.js", "scripts": { "start": "node index.js" } }' > /mnt/server/package.json
  cat > /mnt/server/index.js <<'JS'
// Site de exemplo: troque por seu programa. A porta vem da variável PORT.
const http = require("http");
http.createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end("<h1>Funcionando no Piphin Server</h1>"); })
  .listen(process.env.PORT, () => console.log("Ouvindo na porta " + process.env.PORT));
JS
fi`,
  startup: "if [ -f package.json ]; then npm install --no-audit --no-fund; fi; {{START_COMMAND}}",
  stop: "SIGTERM",
  ports: [{ name: "Web", container: "same", protocol: "tcp", default: 3000 }],
  limits: { memory: 1024, cpu: 1, disk: 4096 },
  vars: [
    { key: "GIT_URL", name: "Repositório Git (opcional)", description: "Vazio = site de exemplo", default: "" },
    { key: "GIT_BRANCH", name: "Branch (opcional)", default: "" },
    { key: "START_COMMAND", name: "Comando para iniciar", default: "npm start", required: true },
  ],
};
