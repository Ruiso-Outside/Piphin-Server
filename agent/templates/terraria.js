// Terraria (servidor dedicado oficial)
module.exports = {
  id: "terraria", order: 3, name: "Terraria", category: "jogos", icon: "trees",
  description: "Servidor dedicado oficial do Terraria. Cria o mundo sozinho na primeira vez.",
  image: "debian:bookworm-slim", installImage: "alpine:3.20",
  install: `apk add --no-cache curl jq unzip >/dev/null
V="$TERRARIA_VERSION"
if [ -z "$V" ] || [ "$V" = "latest" ]; then V=$(curl -fsSL https://terraria.org/api/get/dedicated-servers-names | jq -r '.[0]' | sed 's/[^0-9]//g'); fi
echo "Terraria $V"
curl -fsSL -o /tmp/t.zip "https://terraria.org/api/download/pc-dedicated-server/terraria-server-$V.zip"
rm -rf /tmp/t && mkdir -p /tmp/t && unzip -q /tmp/t.zip -d /tmp/t
cp -r /tmp/t/*/Linux/. /mnt/server/
chmod +x /mnt/server/TerrariaServer.bin.x86_64 /mnt/server/TerrariaServer 2>/dev/null || true
mkdir -p /mnt/server/worlds`,
  startup: "./TerrariaServer.bin.x86_64 -port {{SERVER_PORT}} -maxplayers {{MAX_PLAYERS}} -world \"/home/container/worlds/{{WORLD_NAME}}.wld\" -autocreate {{WORLD_SIZE}} -worldname \"{{WORLD_NAME}}\" -difficulty {{DIFFICULTY}} ${PASSWORD:+-password \"$PASSWORD\"} -secure",
  stop: "exit", done: "Server started",
  ports: [{ name: "Jogo", container: "same", protocol: "tcp", default: 7777 }],
  limits: { memory: 2048, cpu: 0, disk: 4096 },
  vars: [
    { key: "TERRARIA_VERSION", name: "Versão", description: "latest = a mais nova. Ex.: 1458", default: "latest" },
    { key: "WORLD_NAME", name: "Nome do mundo", default: "Mundo", required: true },
    { key: "WORLD_SIZE", name: "Tamanho do mundo", type: "select", default: "2", options: [{ value: "1", name: "Pequeno" }, { value: "2", name: "Médio" }, { value: "3", name: "Grande" }] },
    { key: "DIFFICULTY", name: "Dificuldade", type: "select", default: "0", options: [{ value: "0", name: "Clássico" }, { value: "1", name: "Expert" }, { value: "2", name: "Master" }, { value: "3", name: "Jornada" }] },
    { key: "MAX_PLAYERS", name: "Máximo de jogadores", type: "number", default: "8", min: 1, max: 255 },
    { key: "PASSWORD", name: "Senha para entrar (opcional)", type: "password", default: "" },
  ],
};
