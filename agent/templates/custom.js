// Qualquer imagem Docker: você escolhe a imagem, o comando, a pasta dos arquivos e a porta
module.exports = {
  id: "custom", order: 90, name: "Imagem Docker personalizada", category: "outros", icon: "box",
  description: "Para qualquer outra coisa: escolha uma imagem do Docker Hub, o comando de início e a porta.",
  image: "", install: null, editableStartup: true, startup: "",
  stop: "SIGTERM", user: "root", chown: "",
  ports: [{ name: "Principal", container: "same", protocol: "tcp", default: 8090 }],
  limits: { memory: 1024, cpu: 1, disk: 4096 },
  vars: [
    { key: "IMAGE", name: "Imagem do Docker", description: "Ex.: ghcr.io/usuario/app:latest ou uptime-kuma:1", default: "", required: true },
    { key: "MOUNT", name: "Pasta dos arquivos dentro do contêiner", default: "/home/container" },
  ],
  notes: "Deixe o comando de início vazio para usar o da própria imagem. A porta de fora é a mesma de dentro.",
};
