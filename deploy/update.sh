#!/usr/bin/env bash
# Atualização automática: código do fork (git), imagens oficiais (Ghostfolio, Postgres, Redis)
# e rebuild dos serviços próprios. Faz backup antes. Uso: deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
deploy/backup.sh
git fetch --quiet origin main
if ! git merge --ff-only --quiet origin/main; then
  echo "$(date -u +%FT%TZ) aviso: há mudanças locais no servidor; código não atualizado" >&2
fi
docker compose pull --quiet --ignore-buildable
docker compose up -d --build --remove-orphans
# Firefly III (controle financeiro), se instalado com deploy/firefly/setup.sh
if [ -f deploy/firefly/.env ]; then
  docker compose --project-directory deploy/firefly -f deploy/firefly/compose.yml pull --quiet
  docker compose --project-directory deploy/firefly -f deploy/firefly/compose.yml up -d --remove-orphans
fi
# wger (peso, academia e treinos), se instalado com deploy/wger/setup.sh
if [ -f deploy/wger/.env ]; then
  docker compose --project-directory deploy/wger -f deploy/wger/compose.yml pull --quiet
  docker compose --project-directory deploy/wger -f deploy/wger/compose.yml up -d --remove-orphans
fi
docker image prune -f >/dev/null
echo "$(date -u +%FT%TZ) atualização ok: $(git log --oneline -1)"
