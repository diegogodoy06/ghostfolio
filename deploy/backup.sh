#!/usr/bin/env bash
# Backup diário: banco do Ghostfolio, simulação/metas, estado da sincronização e extratos.
# Guarda os últimos 14 em backups/. Uso: deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
DEST=backups/$(date -u +%Y%m%d-%H%M%S)
mkdir -p "$DEST"
docker exec gf-postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$DEST/ghostfolio.dump"
for v in relatorios-data sync-data; do
  docker run --rm -v "${COMPOSE_PROJECT_NAME}_${v}:/v:ro" -v "$PWD/$DEST:/out" alpine tar -C /v -czf "/out/$v.tgz" .
done
tar -czf "$DEST/extratos.tgz" extratos
chmod -R go-rwx backups
ls -1dt backups/2* | tail -n +15 | xargs -r rm -rf
echo "$(date -u +%FT%TZ) backup ok: $DEST ($(du -sh "$DEST" | cut -f1))"
