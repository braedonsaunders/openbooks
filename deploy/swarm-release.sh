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
# Bootstrap normally demands separate migration and runtime roles. This
# cluster migrates as the role that owns the schema and is otherwise
# unprivileged, which is what OPENBOOKS_CONSTRAINED_SCHEMA_OWNER_MIGRATION is
# for: it verifies the owner is non-superuser, cannot bypass RLS, and owns
# every public table, then runs the migration chain and nothing else -- no
# seeding, no role creation. The runtime login is ALWAYS a second,
# non-owner role: bootstrap grants it application privileges, proves it owns
# nothing, and RLS-proves it before the stack is touched. A release where
# both logins are the same role is refused twice (here, and by bootstrap in
# production) because serving application traffic as the schema owner lets
# the app ALTER/DROP its own isolation.
#
# OPERATOR SETUP (one time; see deploy/README.md for the full procedure)
# 1. As the database administrator, create the runtime login (least
#    privilege, owns nothing) AND the dedicated cross-tenant login
#    (BYPASSRLS, dedicated, owns nothing — production web/worker refuse at
#    import without its URL):
#      CREATE ROLE openbooks_runtime LOGIN NOSUPERUSER NOBYPASSRLS
#        NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '<24+ chars>';
#      GRANT CONNECT, TEMPORARY ON DATABASE <db> TO openbooks_runtime;
#      CREATE ROLE openbooks_bypass LOGIN NOSUPERUSER BYPASSRLS
#        NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '<24+ chars>';
#      GRANT CONNECT, TEMPORARY ON DATABASE <db> TO openbooks_bypass;
#    Details: docs/operations/communal-postgres.md.
# 2. In the Dokploy stack env, set OPENBOOKS_DB_URL to the RUNTIME login URL
#    (this is what web/worker serve with), OPENBOOKS_BYPASS_DB_URL to the
#    CROSS-TENANT login URL, and add OPENBOOKS_MIGRATION_DB_URL with the
#    schema-OWNER login URL (migrations only, never served).
# Until all three are present (and runtime/owner different) this script
# refuses to deploy. The pre-swap migration verifies the cross-tenant login
# holds BYPASSRLS, so a stack that cannot boot its new servers never swaps.
#
# Usage: swarm-release.sh sha256:<64 hex>
#
# The release tag for the pre-migration snapshot filename arrives in a
# digest-keyed file in the release user's home
# (~/.openbooks-release-version-<12 hex>), staged by deploy-production.yml
# before this script runs and deleted once read. The ssh argv carries the
# digest alone, so a manual run without the staging step snapshots as
# "untagged". The digest in the filename means a stale file can never
# mislabel a later release.
set -euo pipefail
# Recovery files include deployment credentials and must remain owner-only.
umask 077

NEW="${1:-}"
APP="${OPENBOOKS_STACK_APP:-compose-bypass-open-source-driver-miu7hf}"
IMAGE_REPO="${OPENBOOKS_IMAGE_REPO:-ghcr.io/braedonsaunders/openbooks}"

[[ "$NEW" =~ ^sha256:[0-9a-f]{64}$ ]] || {
  echo "usage: swarm-release.sh sha256:<64 hex>" >&2; exit 1; }

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
# 2. Migrate, from the exact image being released, BEFORE anything serves it.
# ---------------------------------------------------------------------------
# Export line-wise: `set -a; . file` breaks on unquoted parentheses in secrets.
ENV_FILE="$BK/compose.env"
RUNTIME_URL=""
BYPASS_URL=""
MIGRATION_URL=""
while IFS= read -r line; do
  case "$line" in ''|'#'*) continue;; esac
  [ "${line%%=*}" = "OPENBOOKS_DB_URL" ] && RUNTIME_URL="${line#*=}"
  [ "${line%%=*}" = "OPENBOOKS_BYPASS_DB_URL" ] && BYPASS_URL="${line#*=}"
  [ "${line%%=*}" = "OPENBOOKS_MIGRATION_DB_URL" ] && MIGRATION_URL="${line#*=}"
done < "$ENV_FILE"
[ -n "$RUNTIME_URL" ] || { echo "OPENBOOKS_DB_URL (runtime login) missing from the stack env" >&2; exit 1; }
[ -n "$BYPASS_URL" ] || {
  echo "OPENBOOKS_BYPASS_DB_URL (cross-tenant login) missing from the stack env." >&2
  echo "Production web/worker refuse at import without it; create the dedicated BYPASSRLS login and wire its URL per the OPERATOR SETUP section in deploy/swarm-release.sh." >&2
  exit 1; }
[ -n "$MIGRATION_URL" ] || {
  echo "OPENBOOKS_MIGRATION_DB_URL (schema-owner login) missing from the stack env." >&2
  echo "Create the runtime login and wire both URLs per the OPERATOR SETUP section in deploy/swarm-release.sh." >&2
  exit 1; }
[ "$RUNTIME_URL" != "$MIGRATION_URL" ] || {
  echo "refusing to deploy: the runtime and migration database URLs are identical." >&2
  echo "Web/worker must serve as a non-owner runtime login while migrations run as the schema owner." >&2
  exit 1; }

# The snapshot must cover the same production database that receives the
# migration. The schema owner cannot dump tables with FORCE ROW LEVEL SECURITY;
# the dedicated BYPASSRLS login can, without granting it schema ownership.
database_identity() {
  sudo docker exec "$PG" psql -X -q -A -t -v ON_ERROR_STOP=1 "$1" \
    -c "select inet_server_addr()::text || ':' || inet_server_port()::text || '/' || current_database()" </dev/null
}
MIGRATION_TARGET=$(database_identity "$MIGRATION_URL")
BYPASS_TARGET=$(database_identity "$BYPASS_URL")
RUNTIME_TARGET=$(database_identity "$RUNTIME_URL")
[[ "$MIGRATION_TARGET" == 10.0.0.85:5432/* ]] || {
  echo "refusing to deploy: migration URL reaches $MIGRATION_TARGET rather than production PostgreSQL at 10.0.0.85:5432" >&2
  exit 1; }
[ "$MIGRATION_TARGET" = "$BYPASS_TARGET" ] && [ "$MIGRATION_TARGET" = "$RUNTIME_TARGET" ] || {
  echo "refusing to deploy: runtime, bypass and migration URLs do not reach the same database" >&2
  exit 1; }
BYPASS_ROLE=$(sudo docker exec "$PG" psql -X -q -A -t -v ON_ERROR_STOP=1 "$BYPASS_URL" \
  -c "select rolbypassrls and not rolsuper from pg_roles where rolname = current_user" </dev/null)
[ "$BYPASS_ROLE" = "t" ] || {
  echo "refusing to deploy: snapshot login is not a dedicated non-superuser BYPASSRLS role" >&2
  exit 1; }
echo "production database target and complete-snapshot role verified"

# ---------------------------------------------------------------------------
# 1. Snapshot the target database BEFORE anything migrates it. A mid-chain
#    bootstrap failure leaves earlier migrations committed; without a snapshot
#    there is nothing to restore. (Placed after the URL checks because the
#    dump connects with the dedicated bypass URL validated above.)
# ---------------------------------------------------------------------------
# The tag names the release in the dump filename; anything outside the
# filename-safe set is flattened so a tag can never escape the backup
# directory. Retention keeps the newest OPENBOOKS_DB_BACKUP_KEEP dumps
# (default 5, this one included) and prunes older ones.
STAGED_TAG=""
VERSION_FILE="$HOME/.openbooks-release-version-$(printf '%s' "${NEW#sha256:}" | cut -c1-12)"
if [ -f "$VERSION_FILE" ]; then
  STAGED_TAG=$(cat "$VERSION_FILE")
  rm -f -- "$VERSION_FILE"
fi
TAG_SANITIZED=$(printf '%s' "${STAGED_TAG:-untagged}" | tr -c 'A-Za-z0-9._-' '_')
SHORT_SHA="${NEW#sha256:}"
SHORT_SHA="${SHORT_SHA:0:12}"
DB_BACKUP_DIR="${OPENBOOKS_DB_BACKUP_DIR:-/home/administrator/openbooks-db-backups}"
DB_BACKUP_KEEP="${OPENBOOKS_DB_BACKUP_KEEP:-5}"
[[ "$DB_BACKUP_KEEP" =~ ^[0-9]+$ ]] && [ "$DB_BACKUP_KEEP" -ge 1 ] || {
  echo "OPENBOOKS_DB_BACKUP_KEEP must be a positive integer (got '${DB_BACKUP_KEEP}')" >&2; exit 1; }
mkdir -p "$DB_BACKUP_DIR"
DUMP_FILE="$DB_BACKUP_DIR/pre-${TAG_SANITIZED}-${SHORT_SHA}-${STAMP}.dump"

echo "snapshotting the target database to $DUMP_FILE ..."
# pg_dump is the client inside the Dokploy postgres container: it connects to
# the dedicated BYPASSRLS URL for that same database, and the archive streams to
# the host backup directory. The URL travels as a transient process argument
# visible only to root on the manager, which already owns the credential
# files this script writes.
# shellcheck disable=SC2024  # the redirect intentionally runs as the release
# user, who owns the backup directory; only the docker call needs sudo.
if ! sudo docker exec "$PG" pg_dump -Fc "$BYPASS_URL" </dev/null > "$DUMP_FILE"; then
  echo "pre-migration snapshot failed: pg_dump of the target database did not complete; refusing the release" >&2
  rm -f -- "$DUMP_FILE"
  exit 1
fi
# The dump is not a backup until pg_restore can list it. Its stdin is the
# dump file itself rather than the ssh pipe this script arrives over, so -i
# is correct here.
DUMP_LIST="$BK/pre-snapshot.list"
# shellcheck disable=SC2024  # same ownership split as the pg_dump call above.
if ! sudo docker exec -i "$PG" pg_restore --list < "$DUMP_FILE" > "$DUMP_LIST"; then
  echo "pre-migration snapshot failed verification: pg_restore --list could not read $DUMP_FILE; refusing the release" >&2
  rm -f -- "$DUMP_FILE"
  exit 1
fi
echo "snapshot verified: $DUMP_FILE ($(wc -l < "$DUMP_LIST") catalog entries)"
echo "rollback: pg_restore --clean --if-exists --dbname=\"\$OPENBOOKS_MIGRATION_DB_URL\" < \"$DUMP_FILE\""
echo "To roll back after migrations apply, restore the snapshot above into the target database, then redeploy the previous digest."

# Retain only the newest dumps; only pre-*.dump files are ever removed.
shopt -s nullglob
dump_files=( "$DB_BACKUP_DIR"/pre-*.dump )
shopt -u nullglob
if [ "${#dump_files[@]}" -gt "$DB_BACKUP_KEEP" ]; then
  mapfile -t dump_newest_first < <(ls -1t "${dump_files[@]}")
  for old in "${dump_newest_first[@]:$DB_BACKUP_KEEP}"; do
    rm -f -- "$old"
    echo "pruned snapshot older than the newest $DB_BACKUP_KEEP: $old"
  done
fi

# Keep credentialed URLs out of the Docker process argument list.
MIGRATION_ENV=$(mktemp "$BK/migration.XXXXXXXX.env")
cleanup_migration_env() {
  local release_status=$?
  trap - EXIT
  trap '' INT TERM
  if ! timeout 5 rm -f -- "$MIGRATION_ENV" || [ -e "$MIGRATION_ENV" ]; then
    echo "migration credential file cleanup failed: $MIGRATION_ENV" >&2
    [ "$release_status" -ne 0 ] || release_status=1
  fi
  exit "$release_status"
}
trap cleanup_migration_env EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'OPENBOOKS_DB_URL=%s\nOPENBOOKS_RUNTIME_DB_URL=%s\nOPENBOOKS_BYPASS_DB_URL=%s\n' "$MIGRATION_URL" "$RUNTIME_URL" "$BYPASS_URL" > "$MIGRATION_ENV"
chmod 600 "$MIGRATION_ENV"

echo "applying migrations from ${IMAGE_REPO}@${NEW} ..."
sudo docker run --rm \
  -e NODE_ENV=production \
  -e OPENBOOKS_BOOTSTRAP=1 \
  -e OPENBOOKS_CONSTRAINED_SCHEMA_OWNER_MIGRATION=1 \
  --env-file "$MIGRATION_ENV" \
  "${IMAGE_REPO}@${NEW}" node scripts/bootstrap.mjs

# ---------------------------------------------------------------------------
# 3. Only now repoint the stack. The schema is already ahead of the new code.
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
sudo chmod 600 "$DIR/.env"

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
