// Bot do Discord em Node.js: clona um repositório Git ou cria um bot de exemplo (discord.js) para começar
module.exports = {
  id: "discord-bot-node", order: 10, name: "Bot do Discord (Node.js)", category: "bots", icon: "bot",
  description: "Roda um bot do Discord em Node.js. Traga o código de um repositório Git ou comece pelo exemplo pronto.",
  image: "node:22-bookworm-slim",
  images: [{ name: "Node.js 22", image: "node:22-bookworm-slim" }, { name: "Node.js 24", image: "node:24-bookworm-slim" }, { name: "Node.js 20", image: "node:20-bookworm-slim" }],
  installImage: "alpine:3.20",
  install: `apk add --no-cache git >/dev/null
if [ -n "$GIT_URL" ]; then
  echo "Clonando $GIT_URL..."
  git clone --depth 1 \${GIT_BRANCH:+--branch "$GIT_BRANCH"} "$GIT_URL" /tmp/repo
  cp -a /tmp/repo/. /mnt/server/
elif [ ! -f /mnt/server/package.json ]; then
  cat > /mnt/server/package.json <<'JSON'
{ "name": "meu-bot", "version": "1.0.0", "main": "index.js", "dependencies": { "discord.js": "^14.16.0" } }
JSON
  cat > /mnt/server/index.js <<'JS'
// Bot de exemplo: responde "pong" quando alguém escreve !ping. O token vem da variável DISCORD_TOKEN.
const { Client, GatewayIntentBits } = require("discord.js");
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
client.once("ready", () => console.log("Bot online como " + client.user.tag));
client.on("messageCreate", (m) => { if (m.content === "!ping") m.reply("pong"); });
client.login(process.env.DISCORD_TOKEN);
JS
  echo "Bot de exemplo criado (index.js)"
fi`,
  startup: "if [ -f package.json ]; then npm install --omit=dev --no-audit --no-fund; fi; node {{MAIN_FILE}}",
  stop: "SIGTERM", done: null,
  ports: [],
  limits: { memory: 512, cpu: 1, disk: 2048 },
  vars: [
    { key: "DISCORD_TOKEN", name: "Token do bot", description: "Discord Developer Portal > seu app > Bot > Reset Token", type: "password", default: "" },
    { key: "GIT_URL", name: "Repositório Git (opcional)", description: "Ex.: https://github.com/voce/meu-bot. Vazio = bot de exemplo", default: "" },
    { key: "GIT_BRANCH", name: "Branch (opcional)", default: "" },
    { key: "MAIN_FILE", name: "Arquivo principal", default: "index.js", required: true },
  ],
};
