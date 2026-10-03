#!/usr/bin/env bash
# Deja el worker corriendo como servicio en un servidor Linux (Ubuntu),
# por ejemplo la maquina gratis de Oracle Cloud. Arranca solo al prender
# el servidor y se relanza si se cae. Se puede correr de nuevo sin problema.
#
# Uso, desde la carpeta worker/ ya copiada al servidor (con .env y auth/):
#   bash linux/instalar.sh

set -euo pipefail

WORKER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICIO="cash-market-worker"
USUARIO="$(id -un)"

if [ ! -f "$WORKER_DIR/.env" ]; then
  echo "Falta $WORKER_DIR/.env (copiar .env.example a .env y completarlo)." >&2
  exit 1
fi

# Node.js 20 o superior.
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Instalando Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# Las maquinas chicas (1 GB) se quedan sin memoria en npm install sin swap.
if [ "$(swapon --show | wc -l)" -eq 0 ] && [ ! -f /swapfile ]; then
  echo "Creando swap de 2 GB..."
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# Que los horarios del log y de la mora diaria sean los de Argentina.
sudo timedatectl set-timezone America/Argentina/Buenos_Aires || true

cd "$WORKER_DIR"
npm ci --omit=dev

sudo tee "/etc/systemd/system/$SERVICIO.service" >/dev/null <<EOF
[Unit]
Description=Cash Market - Worker WhatsApp
After=network-online.target
Wants=network-online.target

[Service]
User=$USUARIO
WorkingDirectory=$WORKER_DIR
ExecStart=$(command -v node) src/index.js
# Tambien relanza despues de "Desvincular" (el worker sale con codigo 0).
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICIO" >/dev/null
sudo systemctl restart "$SERVICIO"

echo
echo "Listo: el worker corre como servicio '$SERVICIO' y arranca solo al prender el servidor."
echo "Ver el log en vivo:  journalctl -u $SERVICIO -f"
echo "Detener:             sudo systemctl stop $SERVICIO"
