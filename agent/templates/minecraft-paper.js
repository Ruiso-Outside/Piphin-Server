// Minecraft Java com Paper (plugins, mais leve que o oficial). API de downloads: fill.papermc.io v3
const java = require("./_java");
module.exports = {
  id: "minecraft-paper", order: 1, name: "Minecraft Java (Paper)", category: "jogos", icon: "pickaxe",
  description: "Servidor de Minecraft Java com Paper: mais rápido que o oficial e aceita plugins (pasta plugins).",
  image: "eclipse-temurin:25-jre", autoImage: true,
  images: [{ name: "Java 25", image: "eclipse-temurin:25-jre" }, { name: "Java 21", image: "eclipse-temurin:21-jre" }, { name: "Java 17", image: "eclipse-temurin:17-jre" }, { name: "Java 8", image: "eclipse-temurin:8-jre" }],
  installImage: "alpine:3.20",
  install: `apk add --no-cache curl jq >/dev/null
${java}
V="$MC_VERSION"
if [ -z "$V" ] || [ "$V" = "latest" ]; then
  V=$(curl -fsSL https://fill.papermc.io/v3/projects/paper | jq -r '[.versions | to_entries[] | .value[]] | map(select(test("^[0-9.]+$"))) | .[0]')
fi
echo "Minecraft $V"
url=$(curl -fsSL "https://fill.papermc.io/v3/projects/paper/versions/$V/builds/latest" | jq -r '.downloads."server:default".url // empty')
[ -n "$url" ] || { echo "Versão $V não encontrada no Paper"; exit 1; }
curl -fsSL -o server.jar "$url"
mc_java "$V"
echo "eula=$EULA" > eula.txt
if [ ! -f server.properties ]; then
  printf 'motd=%s\\nmax-players=%s\\nonline-mode=%s\\ndifficulty=%s\\n' "$MOTD" "$MAX_PLAYERS" "$ONLINE_MODE" "$DIFFICULTY" > server.properties
fi
echo "Pronto: Paper $V"`,
  startup: "java -Xms128M -Xmx{{SERVER_MEMORY_JVM}}M -XX:+UseG1GC -jar server.jar --port {{SERVER_PORT}} nogui",
  stop: "stop", done: "Done \\(",
  ports: [{ name: "Jogo", container: "same", protocol: "tcp", default: 25565 }],
  limits: { memory: 4096, cpu: 0, disk: 20480 },
  vars: [
    { key: "MC_VERSION", name: "Versão do Minecraft", description: "latest = a mais nova. Ex.: 1.21.11", default: "latest" },
    { key: "MOTD", name: "Mensagem do servidor", default: "Servidor no Piphin" },
    { key: "MAX_PLAYERS", name: "Máximo de jogadores", type: "number", default: "20", min: 1, max: 1000 },
    { key: "DIFFICULTY", name: "Dificuldade", type: "select", default: "normal", options: [{ value: "peaceful", name: "Pacífico" }, { value: "easy", name: "Fácil" }, { value: "normal", name: "Normal" }, { value: "hard", name: "Difícil" }] },
    { key: "ONLINE_MODE", name: "Só contas originais", type: "bool", default: "true", description: "Desligue para aceitar contas não oficiais" },
    { key: "EULA", name: "Aceito o EULA do Minecraft (minecraft.net/eula)", type: "bool", default: "false", mustBe: "true", mustBeMessage: "É preciso aceitar o EULA do Minecraft" },
  ],
  notes: "Os jogadores entram com o IP da máquina e a porta. Plugins vão na pasta plugins.",
};
