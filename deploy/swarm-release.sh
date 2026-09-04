#!/usr/bin/env bash
#
# Release an image digest to the Docker Swarm stack: migrate first, then swap.
#
# WHY THIS EXISTS
# ---------------
# compose.yaml runs the database bootstrap as a one-shot service that `web`
# waits on (`depends_on: service_completed_successfully`), so a Compose
# deployment always applies pending migrations before the new code serves.
#
# Swarm has no such ordering primitive: `depends_on` is ignored in stack mode.
# The swarm stack therefore carried only `web` and `worker`, and NOTHING ever
# applied migrations there -- production served code that was 22 migrations
# ahead of its own schema, with no error at deploy time to say so. The image
# entrypoint cannot close the gap either, and deliberately does not: the web
# server must never hold migration-owner credentials (see the Dockerfile).
#
# So the ordering that Compose gets declaratively, swarm must get procedurally.
# This script is that procedure. Migrations run FIRST, as a one-shot container
# built from the exact digest being released; a failure aborts before the stack
# is touched, leaving the previous version serving.
#
# MIGRATION ROLE
# --------------
# Bootstrap normally demands separate migration and runtime roles. This cluster
# has one role that owns the schema and is otherwise unprivileged, which is what
# OPENBOOKS_CONSTRAINED_SCHEMA_OWNER_MIGRATION is for: it verifies the role is
# non-superuser, cannot bypass RLS, and owns every public table, then runs the
# migration chain and nothing else -- no seeding, no role creation.
#
# Usage: swarm-release.sh sha256:<64 hex>
set -euo pipefail

NEW="${1:-}"
APP="${OPENBOOKS_STACK_APP:-compose-bypass-open-source-driver-miu7hf}"
IMAGE_REPO="${OPENBOOKS_IMAGE_REPO:-ghcr.io/braedonsaunders/openbooks}"

[[ "$NEW" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo "usage: $(basename "$0") sha256:<64 hex>" >&2; exit 1; }

PG=$(sudo docker ps -qf name=dokploy-postgres | head -1)
[ -n "$PG" ] || { echo "dokploy-postgres container not found" >&2; exit 1; }

dokploy_sql() {
  # `docker exec -i` would consume this script's own stdin when the script is
  # piped over ssh, silently truncating everything below.
  sudo docker exec "$PG" psql -U dokploy -d dokploy -tAc "$1" </dev/null
}

OLD=$(dokploy_sql "select \"composeFile\" from compose where \"appName\"='$APP'" \
      | grep -oE 'openbooks@sha256:[0-9a-f]{64}' | head -1 | cut -d@ -f2)
echo "old digest: ${OLD:-none}"
echo "new digest: $NEW"

STAMP=$(date +%Y%m%d-%H%M%S)
BK="/home/administrator/openbooks-deploy-backup-$STAMP"
mkdir -p "$BK"
dokploy_sql "select \"composeFile\" from compose where \"appName\"='$APP'" > "$BK/composeFile.yml"
dokploy_sql "select env from compose where \"appName\"='$APP'" > "$BK/compose.env"
echo "backup: $BK"

# ---------------------------------------------------------------------------
# 1. Migrate, from the exact image being released, BEFORE anything serves it.
# ---------------------------------------------------------------------------
# Export line-wise: `set -a; . file` breaks on unquoted parentheses in secrets.
ENV_FILE="$BK/compose.env"
DB_URL=""
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue;; esac
  [ "${line%%=*}" = "OPENBOOKS_DB_URL" ] && DB_URL="${line#*=}"
done < "$ENV_FILE"
[ -n "$DB_URL" ] || { echo "OPENBOOKS_DB_URL missing from the stack env" >&2; exit 1; }

echo "applying migrations from ${IMAGE_REPO}@${NEW} ..."
sudo docker run --rm \
  -e NODE_ENV=production \
  -e OPENBOOKS_BOOTSTRAP=1 \
  -e OPENBOOKS_CONSTRAINED_SCHEMA_OWNER_MIGRATION=1 \
  -e "OPENBOOKS_DB_URL=$DB_URL" \
  -e "OPENBOOKS_RUNTIME_DB_URL=$DB_URL" \
  "${IMAGE_REPO}@${NEW}" node scripts/bootstrap.mjs

# ---------------------------------------------------------------------------
# 2. Only now repoint the stack. The schema is already ahead of the new code.
# ---------------------------------------------------------------------------
if [ "$OLD" = "$NEW" ]; then
  echo "stack already pinned to this digest; migrations applied, nothing to swap"
  exit 0
fi

sudo docker exec "$PG" psql -U dokploy -d dokploy -v ON_ERROR_STOP=1 </dev/null -c \
  "update compose set \"composeFile\" = replace(\"composeFile\", '$OLD', '$NEW') where \"appName\" = '$APP'"

PINS=$(dokploy_sql "select \"composeFile\" from compose where \"appName\"='$APP'" | grep -c "openbooks@$NEW" || true)
echo "pins on new digest: $PINS (expect 2 -- web and worker)"
[ "$PINS" = "2" ] || {
  echo "digest swap did not update both pins; restoring" >&2
  sudo docker exec "$PG" psql -U dokploy -d dokploy -v ON_ERROR_STOP=1 </dev/null -c \
    "update compose set \"composeFile\" = replace(\"composeFile\", '$NEW', '$OLD') where \"appName\" = '$APP'"
  exit 1; }

DIR="/etc/dokploy/compose/$APP/code"
sudo mkdir -p "$DIR"
dokploy_sql "select \"composeFile\" from compose where \"appName\"='$APP'" | sudo tee "$DIR/docker-compose.yml" >/dev/null
dokploy_sql "select env from compose where \"appName\"='$APP'" | sudo tee "$DIR/.env" >/dev/null

set +u
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue;; esac
  # shellcheck disable=SC2163  # $line is a whole KEY=value assignment, which is
  # the point: exporting it verbatim avoids `set -a; . file`, which mis-parses
  # unquoted parentheses that appear in some of these secrets.
  export "$line"
done < <(sudo cat "$DIR/.env")
set -u

cd "$DIR"
sudo -E docker stack deploy --with-registry-auth -c docker-compose.yml "$APP"
echo "stack deploy issued"
