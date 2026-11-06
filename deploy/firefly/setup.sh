#!/usr/bin/env bash
# Primeira instalação do Firefly III: gera o .env com segredos aleatórios e sobe os containers.
# Uso: deploy/firefly/setup.sh [dominio-firefly] [dominio-importador]
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  rnd() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1"; }
  umask 077
  cat > .env <<ENV
FF_DOMAIN=${1:-financas.fourwebs.com.br}
IMPORTER_DOMAIN=${2:-importar.fourwebs.com.br}
FF_APP_KEY=$(rnd 32)
FF_DB_PASSWORD=$(rnd 32)
FF_CRON_TOKEN=$(rnd 32)
ENV
  echo ".env criado em $(pwd)/.env"
fi
docker compose pull --quiet
docker compose up -d
echo "Firefly III: http://$(hostname -I | awk '{print $1}'):3335  ·  importador: :3336"
