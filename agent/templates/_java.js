// trecho comum dos modelos de Minecraft Java: descobre a versão do Java que a versão do jogo pede (pela Mojang)
// e grava a imagem certa em .piphin-image (o agente troca a imagem depois da instalação)
module.exports = `
mc_java() {
  url=$(curl -fsSL https://piston-meta.mojang.com/mc/game/version_manifest_v2.json | jq -r --arg v "$1" '.versions[] | select(.id == $v) | .url' | head -n1)
  j=21
  if [ -n "$url" ]; then j=$(curl -fsSL "$url" | jq -r '.javaVersion.majorVersion // 21'); fi
  case "$j" in 8|11|17|21|25) ;; *) if [ "$j" -lt 17 ]; then j=17; elif [ "$j" -lt 21 ]; then j=21; else j=25; fi ;; esac
  echo "eclipse-temurin:$j-jre" > /mnt/server/.piphin-image
  echo "Java $j"
}
`;
