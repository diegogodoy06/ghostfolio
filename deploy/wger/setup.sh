#!/usr/bin/env bash
# Primeira instalação do wger: gera o .env com segredos aleatórios, sobe os containers, gera as
# chaves JWT e baixa a base de exercícios. Uso: deploy/wger/setup.sh [url-do-wger]
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  rnd() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1" || true; }
  umask 077
  pw=$(rnd 32)
  cat > .env <<ENV
WG_SITE_URL=${1:-http://$(hostname -I | awk '{print $1}'):3336}
SECRET_KEY=$(rnd 64)
POSTGRES_USER=wger
POSTGRES_PASSWORD=$pw
POSTGRES_DB=wger
PS_DATABASE_URI=postgres://wger:$pw@db:5432/wger
ENV
  echo ".env criado em $(pwd)/.env"
fi
docker compose pull --quiet
docker compose up -d
echo "Aguardando o wger iniciar (a primeira vez leva alguns minutos)…"
until [ "$(docker inspect -f '{{.State.Health.Status}}' wg-web)" = healthy ]; do sleep 5; done
if ! grep -q '^JWT_PRIVATE_KEY=' .env; then
  docker compose exec -T web ./manage.py generate-jwt-keys | grep -E '^JWT_(PUBLIC|PRIVATE)_KEY=' >> .env
  docker compose up -d web
fi
docker compose exec -T web python3 manage.py sync-exercises >/dev/null || echo "aviso: não sincronizou os exercícios; rode de novo depois"
echo "wger: $(grep '^WG_SITE_URL=' .env | cut -d= -f2-)"
