#!/usr/bin/env bash
set -e

echo "==> Instalando e buildando backend..."
npm install --include=dev
npm run build

echo "==> Clonando e buildando frontend..."
cd /tmp
git clone --depth 1 https://github.com/Igatecnologia/front-end-gest-o.git
cd front-end-gest-o
npm install
VITE_API_BASE_URL= VITE_USE_MOCKS=false npm run build

echo "==> Copiando frontend para backend..."
mkdir -p /opt/render/project/src/front-end-dist
cp -r dist/* /opt/render/project/src/front-end-dist/

echo "==> Build completo!"
