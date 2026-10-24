#!/usr/bin/env bash
# Migra a instância deste Mac para o servidor, com o mesmo banco e os mesmos dados.
# Uso (no Mac, na raiz do repositório):
#   deploy/migrate.sh usuario@servidor /opt/ghostfolio gf.dominio.com rel.dominio.com email@dominio.com
# Pré-requisitos no servidor: Docker com Compose ≥ 2.24, git, portas 80/443 livres e os dois
# domínios apontando (registro A/AAAA) para ele.
set -euo pipefail
TARGET=${1:?usuario@servidor}; DIR=${2:?pasta no servidor}; GF=${3:?domínio do Ghostfolio}; REL=${4:?domínio dos relatórios}; EMAIL=${5:-}
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
PROJECT=${COMPOSE_PROJECT_NAME:-ghostfolio}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
r() { ssh "$TARGET" "$@"; }

echo "1/6 Conferindo o servidor"
r "docker compose version --short && git --version" >/dev/null
r "cd /tmp && (ss -ltn 2>/dev/null || netstat -ltn) | grep -E ':(80|443) ' && echo 'portas 80/443 ocupadas' && exit 1 || true"

echo "2/6 Código do fork no servidor"
r "test -d '$DIR/.git' || git clone --depth 50 https://github.com/diegogodoy06/ghostfolio.git '$DIR'"
r "cd '$DIR' && git fetch --quiet origin main && git checkout --quiet main && git merge --ff-only --quiet origin/main"

echo "3/6 Congelando e exportando os dados locais"
docker compose stop ghostfolio-sync ghostfolio-relatorios ghostfolio
docker exec gf-postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$TMP/ghostfolio.dump"
for v in relatorios-data sync-data; do
  docker run --rm -v "${PROJECT}_${v}:/v:ro" -v "$TMP:/out" alpine tar -C /v -czf "/out/$v.tgz" .
done
{ cat .env; printf '\n# Servidor\nCOMPOSE_FILE=compose.yml:deploy/compose.server.yml\nGF_DOMAIN=%s\nREL_DOMAIN=%s\nACME_EMAIL=%s\n' "$GF" "$REL" "$EMAIL"; } > "$TMP/env"

echo "4/6 Copiando para o servidor (banco, volumes, extratos e segredos)"
r "mkdir -p '$DIR/.migrate' '$DIR/extratos' && chmod 700 '$DIR/.migrate'"
scp -q "$TMP/ghostfolio.dump" "$TMP/relatorios-data.tgz" "$TMP/sync-data.tgz" "$TARGET:$DIR/.migrate/"
scp -q "$TMP/env" "$TARGET:$DIR/.env"
scp -q custom/sync/sync.env "$TARGET:$DIR/custom/sync/sync.env"
scp -q extratos/*.xlsx extratos/*.json "$TARGET:$DIR/extratos/"
r "chmod 600 '$DIR/.env' '$DIR/custom/sync/sync.env'"

echo "5/6 Restaurando no servidor"
r "cd '$DIR' && set -a && . ./.env && set +a && \
  docker compose up -d postgres redis && \
  until docker exec gf-postgres pg_isready -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" >/dev/null 2>&1; do sleep 2; done && \
  docker exec -i gf-postgres pg_restore -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" --clean --if-exists --no-owner < .migrate/ghostfolio.dump && \
  for v in relatorios-data sync-data; do docker volume create ${PROJECT}_\$v >/dev/null && \
    docker run --rm -v ${PROJECT}_\$v:/v -v \"\$PWD/.migrate:/in:ro\" alpine sh -c 'tar -C /v -xzf /in/'\$v'.tgz && chown -R 1000:1000 /v'; done && \
  sudo -n chown -R 1000:1000 extratos 2>/dev/null || chown -R 1000:1000 extratos 2>/dev/null || chmod 777 extratos"

echo "6/6 Subindo tudo e agendando backup + atualização diária"
r "cd '$DIR' && docker compose up -d --build && deploy/install-cron.sh && rm -rf .migrate"
echo "Pronto: https://$GF e https://$REL"
