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
docker image prune -f >/dev/null
echo "$(date -u +%FT%TZ) atualização ok: $(git log --oneline -1)"
