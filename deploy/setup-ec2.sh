#!/usr/bin/env bash
# StreamLab - Instalación automática en EC2 (Ubuntu 24.04)
# Uso (dentro de la carpeta del proyecto): bash deploy/setup-ec2.sh

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"

echo "==> Carpeta del proyecto: $APP_DIR"
echo "==> 1/6 Paquetes del sistema (ffmpeg, git, curl)"
sudo apt-get update -y -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ffmpeg git curl ca-certificates libcap2-bin >/dev/null

echo "==> 2/6 Node.js 22 LTS"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs >/dev/null
fi
echo "   node $(node -v) | npm $(npm -v) | $(ffmpeg -version | head -1 | cut -d' ' -f1-3)"

echo "==> 3/6 Memoria swap de 1 GB (la t3.micro solo tiene 1 GB de RAM)"
if ! sudo swapon --show | grep -q /swapfile; then
  sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> 4/6 Dependencias de la app (npm ci)"
npm ci --omit=dev --no-audit --no-fund

echo "==> 5/6 Archivo .env de producción"
is_ip() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; }
TOKEN=$(curl -fs -m 2 -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" || true)
PUBLIC_IP=$(curl -fs -m 2 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || true)
is_ip "$PUBLIC_IP" || PUBLIC_IP=$(curl -fs -m 5 https://checkip.amazonaws.com | tr -d '[:space:]' || true)
is_ip "$PUBLIC_IP" || PUBLIC_IP=localhost

cat > .env <<ENV
PORT=80
RTMP_PORT=1935
PUBLIC_HOST=
FFMPEG_PATH=$(command -v ffmpeg)
RECORD_VOD=true
ENV

# Permite que Node use el puerto 80 sin ejecutarse como root
sudo setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(command -v node)")"

echo "==> 6/6 PM2: mantener la app encendida y arrancarla con el servidor"
command -v pm2 >/dev/null || sudo npm install -g pm2 --no-audit --no-fund >/dev/null
pm2 delete streamlab >/dev/null 2>&1 || true
pm2 start npm --name streamlab -- start
pm2 save
sudo env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$USER" --hp "$HOME" >/dev/null 2>&1 || echo "   (aviso) pm2 startup no disponible en este sistema"

sleep 3
if curl -fs "http://localhost/api/health" >/dev/null; then
  echo ""
  echo "✔ StreamLab está en línea"
  echo "  Web: http://$PUBLIC_IP"
  echo "  OBS: rtmp://$PUBLIC_IP:1935/live"
  echo ""
else
  echo "✖ La app no respondió. Revisa: pm2 logs streamlab"; exit 1
fi