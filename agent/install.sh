#!/usr/bin/env bash
# Piphin Agent · instalador para Ubuntu Server (e Debian). Rodar como root:
#   curl -fsSL https://github.com/Ruiso-Outside/Piphin-Server/releases/latest/download/install.sh | sudo bash
# Rodar de novo atualiza o agente (os servidores e os dados ficam). Para desinstalar: sudo bash install.sh --uninstall
set -euo pipefail

REPO="Ruiso-Outside/Piphin-Server"
BASE="${PIPHIN_BASE:-https://github.com/$REPO/releases/latest/download}"
APP=/opt/piphin-agent
ETC=/etc/piphin-agent
DATA=/var/lib/piphin-agent
UNIT=/etc/systemd/system/piphin-agent.service
NODE_MAJOR=22

c_ok() { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mErro: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "rode como root (use sudo)"
command -v apt-get >/dev/null || die "este instalador é para Ubuntu Server ou Debian"
command -v systemctl >/dev/null || die "o systemd é necessário"

# ---------------------------------------------------------------- desinstalar
if [ "${1:-}" = "--uninstall" ]; then
  c_step "Removendo o Piphin Agent"
  systemctl disable --now piphin-agent 2>/dev/null || true
  if command -v docker >/dev/null; then
    ids=$(docker ps -aq --filter label=piphin.server --filter label=piphin.install || true)
    [ -n "$ids" ] && docker rm -f $ids >/dev/null || true
  fi
  rm -f "$UNIT" /usr/local/bin/piphin-agent
  systemctl daemon-reload
  rm -rf "$APP"
  read -r -p "Apagar também os servidores e os backups em $DATA? [s/N] " ans </dev/tty || ans=n
  case "$ans" in s|S|y|Y) rm -rf "$DATA" "$ETC"; c_ok "Tudo removido." ;; *) c_ok "Agente removido. Os dados continuam em $DATA e $ETC." ;; esac
  exit 0
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH=x64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "processador não suportado: $(uname -m)" ;;
esac

c_step "Pacotes básicos"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates tar xz-utils openssl >/dev/null

c_step "Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
else
  echo "Já instalado: $(docker --version)"
fi
systemctl enable --now docker >/dev/null

c_step "Node.js"
NODE="$APP/node/bin/node"
if [ -x "$NODE" ] && [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
  echo "Já instalado: $("$NODE" -v)"
else
  tmp=$(mktemp -d)
  sums=$(curl -fsSL "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/SHASUMS256.txt")
  file=$(printf '%s\n' "$sums" | awk '{print $2}' | grep -E "^node-v[0-9.]+-linux-$ARCH\.tar\.xz$" | head -n1)
  [ -n "$file" ] || die "não encontrei o Node.js $NODE_MAJOR para $ARCH"
  curl -fsSL -o "$tmp/$file" "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/$file"
  (cd "$tmp" && printf '%s\n' "$sums" | grep " $file\$" | sha256sum -c - >/dev/null) || die "o download do Node.js veio corrompido"
  rm -rf "$APP/node" && mkdir -p "$APP/node"
  tar -xJf "$tmp/$file" -C "$APP/node" --strip-components=1
  rm -rf "$tmp"
  echo "Instalado: $("$NODE" -v)"
fi

c_step "Piphin Agent"
tmp=$(mktemp -d)
if [ -n "${PIPHIN_LOCAL:-}" ]; then cp "$PIPHIN_LOCAL" "$tmp/agent.tar.gz"; else curl -fsSL -o "$tmp/agent.tar.gz" "$BASE/piphin-agent.tar.gz"; fi
rm -rf "$APP/app.new" && mkdir -p "$APP/app.new"
tar -xzf "$tmp/agent.tar.gz" -C "$APP/app.new"
[ -f "$APP/app.new/src/main.js" ] || die "pacote do agente inválido"
rm -rf "$APP/app" && mv "$APP/app.new" "$APP/app"
rm -rf "$tmp"
cat > /usr/local/bin/piphin-agent <<EOF
#!/bin/sh
exec "$NODE" "$APP/app/src/main.js" "\$@"
EOF
chmod 755 /usr/local/bin/piphin-agent
echo "Versão: $(piphin-agent version)"

c_step "Configuração"
mkdir -p "$ETC" "$DATA"
chmod 700 "$ETC" "$DATA"
if [ ! -f "$ETC/config.json" ]; then
  cat > "$ETC/config.json" <<EOF
{
  "name": "$(hostname)",
  "port": 8443,
  "discoveryPort": 8444,
  "dataDir": "$DATA",
  "key": "$ETC/key.pem",
  "cert": "$ETC/cert.pem"
}
EOF
fi
if [ ! -f "$ETC/cert.pem" ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -subj "/CN=piphin-agent-$(hostname)" -keyout "$ETC/key.pem" -out "$ETC/cert.pem" 2>/dev/null
  chmod 600 "$ETC/key.pem"
  echo "Certificado criado."
fi

cat > "$UNIT" <<EOF
[Unit]
Description=Piphin Agent (servidores do Piphin Hub)
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
ExecStart=/usr/local/bin/piphin-agent run
Restart=always
RestartSec=3
Environment=NODE_ENV=production
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable piphin-agent >/dev/null
systemctl restart piphin-agent

if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 8443/tcp >/dev/null && ufw allow 8444/udp >/dev/null
  echo "Firewall (ufw): portas 8443/tcp e 8444/udp liberadas."
fi

sleep 2
systemctl is-active --quiet piphin-agent || { journalctl -u piphin-agent -n 30 --no-pager; die "o serviço não iniciou"; }
c_ok "Piphin Agent rodando."
piphin-agent pair
echo "No Piphin Hub: abra o Piphin Server > Adicionar máquina e digite o código acima."
echo "Para um código novo depois: sudo piphin-agent pair"
