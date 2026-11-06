// Jogo Unreal próprio (pacote Linux): usado pelos "Meus jogos". Acha o servidor sozinho na pasta game:
// <Projeto>Server.sh (build de servidor dedicado) ou <Projeto>.sh (o jogo normal, sem tela, hospedando o mapa).
module.exports = {
  id: "unreal-game", order: 50, name: "Jogo Unreal (pacote Linux)", category: "meus", icon: "joystick", hidden: true,
  description: "Roda o pacote Linux de um jogo feito na Unreal Engine. Envie o pacote pelos Meus jogos.",
  image: "ghcr.io/ptero-eggs/yolks:debian", gameDir: "game",
  // a Unreal não aceita rodar como root: o contêiner usa o usuário 1000
  startup: `cd /home/container/game 2>/dev/null || { echo "O jogo ainda não foi enviado: mande o pacote pelos Meus jogos."; exit 1; }
L=$(ls ./*Server.sh 2>/dev/null | head -n1); MODE=dedicado
if [ -z "$L" ]; then L=$(ls ./*.sh 2>/dev/null | grep -v '/Engine' | head -n1); MODE=listen; fi
[ -n "$L" ] || { echo "Não achei o executável do jogo (o arquivo .sh na raiz do pacote)."; exit 1; }
chmod +x "$L" ./Engine/Binaries/Linux/* ./*/Binaries/Linux/* 2>/dev/null
if [ "$MODE" = listen ]; then
  [ -n "$MAP" ] || { echo "Preencha o mapa nas opções do servidor: o jogo normal precisa saber qual mapa hospedar."; exit 1; }
  echo "Rodando $L sem tela, hospedando $MAP"
  exec "$L" "$MAP?listen" -nullrhi -nosound -unattended -log -FullStdOutLogOutput -Port=$SERVER_PORT $EXTRA_ARGS
fi
echo "Rodando o servidor dedicado $L"
exec "$L" $MAP -log -FullStdOutLogOutput -unattended -Port=$SERVER_PORT $EXTRA_ARGS`,
  stop: "SIGINT", done: "listening on port|Game Engine Initialized",
  ports: [{ name: "Jogo", container: "same", protocol: "udp", default: 7777 }],
  limits: { memory: 4096, cpu: 0, disk: 0 },
  vars: [
    { key: "MAP", name: "Mapa", description: "Ex.: /Game/Maps/MeuMapa. Obrigatório quando o pacote é o jogo normal, sem um arquivo terminado em Server.sh. No servidor dedicado, vazio = o mapa padrão.", default: "" },
    { key: "EXTRA_ARGS", name: "Opções extras", description: "Mais opções para a linha de comando do jogo, como -MaxPlayers=16.", default: "" },
  ],
};
