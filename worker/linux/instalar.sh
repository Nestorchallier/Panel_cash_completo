#!/usr/bin/env bash
# Instala el worker como servicio de Linux (systemd) en un servidor Ubuntu,
# por ejemplo la máquina gratuita de Oracle Cloud: arranca solo al prender
# el servidor y se relanza si se cae (también después de "Desvincular"
# desde el panel, así aparece el QR nuevo sin tocar nada).
#
# Uso, desde la carpeta worker/ ya copiada al servidor (con su .env):
#   bash linux/instalar.sh
# Se puede correr de nuevo sin problema (por ejemplo después de actualizar
# el código): reinstala dependencias y reinicia el servicio.

set -euo pipefail

WORKER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICIO="cash-market-worker"
USUARIO="$(id -un)"
# Los horarios de envío de la cola (cola.js) usan la hora local: el
# servidor tiene que estar en hora argentina, no en UTC.
ZONA="America/Argentina/Buenos_Aires"

if [ ! -f "$WORKER_DIR/.env" ]; then
  echo "Falta $WORKER_DIR/.env (copiá el de la PC o completá .env.example)." >&2
  exit 1
fi

version_node() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(version_node)" -lt 20 ]; then
  echo "Instalando Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# Las máquinas chicas (1 GB, como la E2.1.Micro) se quedan sin memoria en
# npm ci si no tienen swap.
if [ "$(swapon --show | wc -l)" -eq 0 ] && [ ! -f /swapfile ]; then
  echo "Creando swap de 2 GB..."
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile > /dev/null
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab > /dev/null
fi

sudo timedatectl set-timezone "$ZONA" || true

echo "Instalando dependencias..."
cd "$WORKER_DIR"
npm ci --omit=dev


sudo tee "/etc/systemd/system/$SERVICIO.service" > /dev/null <<UNIT
[Unit]
Description=CRM Panel Unificado - Worker WhatsApp
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
User=$USUARIO
WorkingDirectory=$WORKER_DIR
ExecStart=$(command -v node) src/index.js
Environment=NODE_ENV=production
Environment=TZ=$ZONA
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICIO" > /dev/null
sudo systemctl restart "$SERVICIO"

echo
echo "Listo: el worker corre como servicio '$SERVICIO' y arranca solo con el servidor."
echo "Ver el log en vivo:   journalctl -u $SERVICIO -f"
echo "Estado:               systemctl status $SERVICIO"
echo "Detener / iniciar:    sudo systemctl stop $SERVICIO  /  sudo systemctl start $SERVICIO"
