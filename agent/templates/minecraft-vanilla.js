// Minecraft Java oficial (da Mojang)
const java = require("./_java");
module.exports = {
  id: "minecraft-vanilla", order: 2, name: "Minecraft Java (oficial)", category: "jogos", icon: "pickaxe",
  description: "O servidor oficial da Mojang, sem modificações.",
  image: "eclipse-temurin:25-jre", autoImage: true,
  images: [{ name: "Java 25", image: "eclipse-temurin:25-jre" }, { name: "Java 21", image: "eclipse-temurin:21-jre" }, { name: "Java 17", image: "eclipse-temurin:17-jre" }, { name: "Java 8", image: "eclipse-temurin:8-jre" }],
  installImage: "alpine:3.20",
  install: `apk add --no-cache curl jq >/dev/null
${java}
M=$(curl -fsSL https://piston-meta.mojang.com/mc/game/version_manifest_v2.json)
V="$MC_VERSION"
if [ -z "$V" ] || [ "$V" = "latest" ]; then V=$(echo "$M" | jq -r '.latest.release'); fi
url=$(echo "$M" | jq -r --arg v "$V" '.versions[] | select(.id == $v) | .url' | head -n1)
[ -n "$url" ] || { echo "Versão $V não encontrada"; exit 1; }
jar=$(curl -fsSL "$url" | jq -r '.downloads.server.url // empty')
[ -n "$jar" ] || { echo "A versão $V não tem servidor"; exit 1; }
echo "Minecraft $V"
curl -fsSL -o server.jar "$jar"
mc_java "$V"
echo "eula=$EULA" > eula.txt
if [ ! -f server.properties ]; then
  printf 'motd=%s\\nmax-players=%s\\nonline-mode=%s\\ndifficulty=%s\\n' "$MOTD" "$MAX_PLAYERS" "$ONLINE_MODE" "$DIFFICULTY" > server.properties
fi`,
  startup: "java -Xms128M -Xmx{{SERVER_MEMORY_JVM}}M -jar server.jar --port {{SERVER_PORT}} nogui",
  stop: "stop", done: "Done \\(",
  ports: [{ name: "Jogo", container: "same", protocol: "tcp", default: 25565 }],
  limits: { memory: 4096, cpu: 0, disk: 20480 },
  vars: [
    { key: "MC_VERSION", name: "Versão do Minecraft", description: "latest = a mais nova. Ex.: 1.21.11", default: "latest" },
    { key: "MOTD", name: "Mensagem do servidor", default: "Servidor no Piphin" },
    { key: "MAX_PLAYERS", name: "Máximo de jogadores", type: "number", default: "20", min: 1, max: 1000 },
    { key: "DIFFICULTY", name: "Dificuldade", type: "select", default: "normal", options: [{ value: "peaceful", name: "Pacífico" }, { value: "easy", name: "Fácil" }, { value: "normal", name: "Normal" }, { value: "hard", name: "Difícil" }] },
    { key: "ONLINE_MODE", name: "Só contas originais", type: "bool", default: "true" },
    { key: "EULA", name: "Aceito o EULA do Minecraft (minecraft.net/eula)", type: "bool", default: "false", mustBe: "true", mustBeMessage: "É preciso aceitar o EULA do Minecraft" },
  ],
};
