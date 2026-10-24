#!/usr/bin/env bash
# Agenda no cron do usuário: todo dia às 04:00 (horário do servidor), backup + atualização.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$DIR/backups"
( crontab -l 2>/dev/null | grep -v "ghostfolio-deploy" || true
  echo "0 4 * * * $DIR/deploy/update.sh >> $DIR/backups/cron.log 2>&1 # ghostfolio-deploy"
) | crontab -
crontab -l | grep ghostfolio-deploy
