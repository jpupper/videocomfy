#!/bin/bash
# ============================================================
# jpiassets - actualizacion del backend en el VPS (corre DENTRO del VPS)
#   SSH: cd /root/comfylatam && bash deploy_scripts/server_update.sh
#   (una sola app: el hub vive en hub/ y sirve el public/ de la app)
# NO toca el .env del VPS (es config del server, no fuente).
# ============================================================

sed -i 's/\r$//' .env 2>/dev/null
sed -i 's/\r$//' deploy_scripts/server_update.sh 2>/dev/null

if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
else
    echo "ADVERTENCIA: no hay .env en el VPS (el server arranca igual, pero sin AGENT_TOKEN no conecta la PC)."
fi

APP_NAME="comfylatam"
REPO="${GITHUB_REPO:-jpupper/jpiassets}"
TOKEN=$(echo $GITHUB_TOKEN | tr -d '\r')
REPO_URL="https://$TOKEN@github.com/$REPO"

echo "------------------------------------------------"
echo "DEPLOY: $APP_NAME (Repo: $REPO)"
echo "------------------------------------------------"

if [ ! -d ".git" ]; then
    echo "Clonando repositorio por primera vez..."
    git init
    git remote add origin "$REPO_URL"
    git fetch origin main
    git checkout -f main
else
    echo "Actualizando repositorio..."
    git remote set-url origin "$REPO_URL"
    git fetch origin main
    git reset --hard origin/main
fi

echo "Instalando dependencias de Node..."
npm install --no-audit --no-fund

echo "Reiniciando instancia de PM2 ($APP_NAME)..."
pm2 delete "$APP_NAME" 2>/dev/null
pm2 delete jpiassets 2>/dev/null   # nombre viejo (antes del renombre a comfylatam)
pm2 start hub/server.js --name "$APP_NAME" --update-env
pm2 save

echo "------------------------------------------------"
echo "DEPLOY FINALIZADO CON EXITO"
echo "------------------------------------------------"
echo "Health: curl -s http://127.0.0.1:8086/comfylatam/health"
