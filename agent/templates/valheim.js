// Valheim (servidor dedicado pela SteamCMD). Usa duas portas UDP seguidas (jogo e consulta)
module.exports = {
  id: "valheim", order: 4, name: "Valheim", category: "jogos", icon: "axe",
  description: "Servidor dedicado do Valheim, baixado pela SteamCMD. Usa duas portas UDP seguidas.",
  image: "cm2network/steamcmd:root", installImage: "cm2network/steamcmd:root",
  install: `/home/steam/steamcmd/steamcmd.sh +force_install_dir /mnt/server +login anonymous +app_update 896660 validate +quit
test -f /mnt/server/valheim_server.x86_64 || { echo "A SteamCMD não baixou o Valheim"; exit 1; }
chmod +x /mnt/server/valheim_server.x86_64`,
  startup: "export LD_LIBRARY_PATH=./linux64:$LD_LIBRARY_PATH SteamAppId=892970; ./valheim_server.x86_64 -nographics -batchmode -name \"{{SERVER_NAME}}\" -port {{SERVER_PORT}} -world \"{{WORLD_NAME}}\" -password \"{{PASSWORD}}\" -public {{PUBLIC}} -savedir /home/container/save",
  stop: "SIGINT", done: "Game server connected",
  ports: [{ name: "Jogo", container: "same", protocol: "udp", default: 2456 }, { name: "Consulta", container: "same", protocol: "udp", offset: 1 }],
  limits: { memory: 4096, cpu: 0, disk: 10240 },
  vars: [
    { key: "SERVER_NAME", name: "Nome na lista de servidores", default: "Servidor Piphin", required: true },
    { key: "WORLD_NAME", name: "Nome do mundo", default: "Mundo", required: true },
    { key: "PASSWORD", name: "Senha (mínimo 5 letras)", type: "password", default: "", required: true, minLength: 5 },
    { key: "PUBLIC", name: "Aparecer na lista pública", type: "select", default: "0", options: [{ value: "0", name: "Não" }, { value: "1", name: "Sim" }] },
  ],
};
