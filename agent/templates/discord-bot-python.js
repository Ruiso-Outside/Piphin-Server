// Bot do Discord em Python: clona um repositório Git ou cria um bot de exemplo (discord.py)
module.exports = {
  id: "discord-bot-python", order: 11, name: "Bot do Discord (Python)", category: "bots", icon: "bot",
  description: "Roda um bot do Discord em Python. Traga o código de um repositório Git ou comece pelo exemplo pronto.",
  image: "python:3.12-slim",
  images: [{ name: "Python 3.12", image: "python:3.12-slim" }, { name: "Python 3.13", image: "python:3.13-slim" }, { name: "Python 3.11", image: "python:3.11-slim" }],
  installImage: "alpine:3.20",
  install: `apk add --no-cache git >/dev/null
if [ -n "$GIT_URL" ]; then
  echo "Clonando $GIT_URL..."
  git clone --depth 1 \${GIT_BRANCH:+--branch "$GIT_BRANCH"} "$GIT_URL" /tmp/repo
  cp -a /tmp/repo/. /mnt/server/
elif [ ! -f /mnt/server/main.py ]; then
  echo "discord.py>=2.4" > /mnt/server/requirements.txt
  cat > /mnt/server/main.py <<'PY'
# Bot de exemplo: responde "pong" a !ping. O token vem da variável DISCORD_TOKEN.
import os, discord
intents = discord.Intents.default()
intents.message_content = True
client = discord.Client(intents=intents)

@client.event
async def on_ready():
    print(f"Bot online como {client.user}", flush=True)

@client.event
async def on_message(m):
    if m.content == "!ping":
        await m.reply("pong")

client.run(os.environ["DISCORD_TOKEN"])
PY
  echo "Bot de exemplo criado (main.py)"
fi`,
  startup: "if [ -f requirements.txt ]; then pip install --no-cache-dir --user --disable-pip-version-check -q -r requirements.txt; fi; python -u {{MAIN_FILE}}",
  stop: "SIGTERM",
  ports: [],
  limits: { memory: 512, cpu: 1, disk: 2048 },
  vars: [
    { key: "DISCORD_TOKEN", name: "Token do bot", description: "Discord Developer Portal > seu app > Bot > Reset Token", type: "password", default: "" },
    { key: "GIT_URL", name: "Repositório Git (opcional)", description: "Vazio = bot de exemplo", default: "" },
    { key: "GIT_BRANCH", name: "Branch (opcional)", default: "" },
    { key: "MAIN_FILE", name: "Arquivo principal", default: "main.py", required: true },
  ],
};
