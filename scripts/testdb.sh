#!/usr/bin/env bash
# One shared PostgreSQL for every DB-backed test run on this machine.
#
# The problem this replaces: each agent worktree started its own container and
# never stopped it. Twenty-five accumulated across six different images while CI
# pins exactly one, so most work was being validated against a PostgreSQL the
# product does not ship on — a correctness problem, not only a slow one. Each
# run also re-applied the whole migration chain, which is the slowest part of
# starting a suite.
#
# What this gives instead:
#   * one container, on the image CI pins, reused by everyone;
#   * a bootstrapped TEMPLATE database, so a fresh database is a file copy
#     instead of a migration replay;
#   * a per-caller database, so parallel suites cannot see each other's rows.
#
# Usage:
#   scripts/testdb.sh up                 start the container and build the template
#   scripts/testdb.sh new [name]         create a fresh database, print its env exports
#   scripts/testdb.sh drop <name>        drop one database
#   scripts/testdb.sh env <name>         print exports for an existing database
#   scripts/testdb.sh status             show the container, template and databases
#   scripts/testdb.sh gc                 drop databases unused for over a day
#   scripts/testdb.sh reset              rebuild the template from the current schema
#
# Typical use from a worktree:
#   eval "$(scripts/testdb.sh new)" && npm test
set -euo pipefail

# Must match .github/workflows/test.yml. A suite that passes here and not in CI
# because of a version difference is worse than no suite at all.
IMAGE="postgres:16.9-alpine3.22@sha256:7c688148e5e156d0e86df7ba8ae5a05a2386aaec1e2ad8e6d11bdf10504b1fb7"
CONTAINER=openbooks-testdb
PORT=${OPENBOOKS_TESTDB_PORT:-5599}
SUPER=openbooks
SUPERPASS=openbooks
# Overridable so the harness's own concurrency regression can exercise publish
# and copy against a throwaway template instead of the shared one.
TEMPLATE=${OPENBOOKS_TESTDB_TEMPLATE:-openbooks_template}
RUNTIME_ROLE=openbooks_app
RUNTIME_PASS=openbooks-runtime-test-password

psql_super() { PGPASSWORD=$SUPERPASS psql -h 127.0.0.1 -p "$PORT" -U "$SUPER" -d postgres -v ON_ERROR_STOP=1 "$@"; }
url_for() { echo "postgres://${SUPER}:${SUPERPASS}@127.0.0.1:${PORT}/$1"; }
runtime_url_for() { echo "postgres://${RUNTIME_ROLE}:${RUNTIME_PASS}@127.0.0.1:${PORT}/$1"; }

require_docker() {
  command -v docker >/dev/null 2>&1 || { echo "testdb: docker is not on PATH" >&2; exit 1; }
  docker info >/dev/null 2>&1 || { echo "testdb: docker is not running" >&2; exit 1; }
}

container_running() { [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" = "true" ]; }

start_container() {
  if container_running; then return; fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "testdb: starting $CONTAINER on port $PORT" >&2
  docker run -d --name "$CONTAINER" \
    -e POSTGRES_USER="$SUPER" -e POSTGRES_PASSWORD="$SUPERPASS" -e POSTGRES_DB=postgres \
    -p "127.0.0.1:${PORT}:5432" \
    --health-cmd "pg_isready -U $SUPER -d postgres" \
    --health-interval 2s --health-timeout 3s --health-retries 30 \
    "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null)" = "healthy" ] && return
    sleep 1
  done
  echo "testdb: $CONTAINER did not become healthy" >&2
  exit 1
}

# One global template, many worktrees, and `flock` is not installed on macOS —
# so the old `flock 9 2>/dev/null || true` was a silent no-op on every developer
# machine and nothing was ever serialized. mkdir is atomic on every filesystem
# this runs on, needs no extra binary, and cannot fail open.
LOCK_DIR="${TMPDIR:-/tmp}/openbooks-testdb-${TEMPLATE}.lock.d"
LOCK_HELD=0
STAGING=""

release_lock() {
  [ "$LOCK_HELD" = 1 ] || return 0
  rm -rf "$LOCK_DIR"
  LOCK_HELD=0
}

cleanup() {
  # A half-built staging database must never outlive the run that made it.
  if [ -n "$STAGING" ]; then
    psql_super -c "drop database if exists ${STAGING} with (force)" >/dev/null 2>&1 || true
    STAGING=""
  fi
  release_lock
}

acquire_lock() {
  # Reentrant: `new` takes the lock, then may call build_template inside it.
  [ "$LOCK_HELD" = 1 ] && return 0
  local waited=0 owner
  while ! mkdir "$LOCK_DIR" 2>/dev/null; do
    owner=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
    # A crashed build otherwise wedges every worktree on the machine forever.
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      echo "testdb: clearing template lock left behind by dead pid $owner" >&2
      rm -rf "$LOCK_DIR"
      continue
    fi
    if [ "$waited" -ge "${OPENBOOKS_TESTDB_LOCK_WAIT:-900}" ]; then
      echo "testdb: gave up after ${waited}s waiting for the template lock (held by pid ${owner:-unknown})" >&2
      echo "testdb: if that process is gone, remove $LOCK_DIR" >&2
      exit 1
    fi
    [ "$waited" -eq 0 ] && echo "testdb: waiting for the template lock (held by pid ${owner:-unknown})" >&2
    sleep 1
    waited=$((waited + 1))
  done
  printf '%s' "$$" >"$LOCK_DIR/pid"
  LOCK_HELD=1
  trap cleanup EXIT INT TERM
}

template_exists() {
  [ "$(psql_super -tAc "select 1 from pg_database where datname='${TEMPLATE}'" 2>/dev/null)" = "1" ]
}

# Existing is not the same as usable. build_template used to `create database`
# and only then run migrations, so for the length of a bootstrap the published
# name existed while holding nothing. `new` checked existence alone, copied that
# empty database, and its suite reported missing columns as product failures —
# false test evidence, which is worse than a slow run. The build record is
# written last, so its presence is what "ready" means.
template_ready() {
  template_exists || return 1
  [ -n "$(template_meta fingerprint)" ] || return 1
}

# Identity of the schema a template was built from: every generated migration
# filename and its content hash. Cheap to compute, and it changes the moment a
# slice adds or edits an ordinal.
schema_fingerprint() {
  local repo
  repo=$(git rev-parse --show-toplevel)
  ( cd "$repo/schema/migrations/generated" 2>/dev/null && ls -1 *.sql 2>/dev/null | sort | while read -r f; do
      printf '%s:%s\n' "$f" "$(shasum -a 256 "$f" | cut -d" " -f1)"
    done ) | shasum -a 256 | cut -d" " -f1
}

migration_count() {
  local repo
  repo=$(git rev-parse --show-toplevel)
  ls -1 "$repo"/schema/migrations/generated/*.sql 2>/dev/null | wc -l | tr -d " "
}

template_meta() {
  # $1 = column. Empty when the template predates the metadata table.
  psql_super -d "$TEMPLATE" -tAc \
    "select ${1} from openbooks_testdb_meta limit 1" 2>/dev/null | tr -d " " || true
}

drop_template() {
  # PostgreSQL refuses to drop a database flagged as a template, and
  # build_template sets that flag — so every reset after the first failed with
  # "cannot drop a template database" and silently left the OLD schema in place.
  # Migration slices then copied a template missing their own migration.
  psql_super -c "update pg_database set datistemplate = false where datname = '${TEMPLATE}'" >/dev/null 2>&1 || true
  psql_super -c "drop database if exists ${TEMPLATE} with (force)" >/dev/null
}

build_template() {
  local repo
  repo=$(git rev-parse --show-toplevel)
  acquire_lock
  # Build under a name nothing copies from, then publish by rename. A reader can
  # then only ever see the published name fully built, whether or not it took
  # the lock, so this holds even against a caller that predates this script.
  STAGING="${TEMPLATE}_staging_$$"
  echo "testdb: building $TEMPLATE (migrations run once, then every new database is a copy)" >&2
  psql_super -c "drop database if exists ${STAGING} with (force)" >/dev/null
  psql_super -c "create database ${STAGING}" >/dev/null
  (
    cd "$repo"
    NODE_ENV=test \
    OPENBOOKS_DB_URL="$(url_for "$STAGING")" \
    OPENBOOKS_RUNTIME_DB_URL="$(runtime_url_for "$STAGING")" \
    OPENBOOKS_DB_PASSWORD="$RUNTIME_PASS" \
    OPENBOOKS_DATA_KEY=${OPENBOOKS_DATA_KEY:-000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f} \
    SESSION_SECRET=${SESSION_SECRET:-openbooks-test-secret-not-production} \
    ORG_COUNTRY=${ORG_COUNTRY:-US} ORG_CURRENCY=${ORG_CURRENCY:-USD} \
    npx tsx scripts/bootstrap.ts >&2
  )
  # Record which schema built this template so a stale checkout cannot rebuild
  # it backwards without saying so. Written last: it is the readiness signal.
  psql_super -d "$STAGING" -c "
    create table if not exists openbooks_testdb_meta (
      fingerprint text not null, migration_count int not null, built_at timestamptz not null default now());
    delete from openbooks_testdb_meta;
    insert into openbooks_testdb_meta (fingerprint, migration_count)
    values ('$(schema_fingerprint)', $(migration_count));" >/dev/null
  local built
  built=$(psql_super -d "$STAGING" -tAc "select fingerprint from openbooks_testdb_meta limit 1" 2>/dev/null | tr -d " ")
  if [ "$built" != "$(schema_fingerprint)" ]; then
    echo "testdb: refusing to publish — the staging template has no usable build record" >&2
    exit 1
  fi
  # Publish. Rename is atomic in the catalog; the old template is dropped first
  # because the name has to be free, and both happen under the lock.
  drop_template
  psql_super -c "alter database ${STAGING} rename to ${TEMPLATE}" >/dev/null
  psql_super -c "update pg_database set datistemplate = true where datname = '${TEMPLATE}'" >/dev/null
  STAGING=""
  echo "testdb: template ready ($(migration_count) migrations)" >&2
  release_lock
}

# Warn loudly when the template was built from a different schema than the
# caller's checkout. Silence here is what let a worker copy a template missing
# its own migration and conclude the migration did not work.
check_template_freshness() {
  local mine theirs mine_n theirs_n
  mine=$(schema_fingerprint); theirs=$(template_meta fingerprint)
  # Silence here is what let a half-built template pass as usable. Every
  # template this script publishes carries a build record, so its absence means
  # the database is not one — never that it is old and fine.
  if [ -z "$theirs" ]; then
    echo "testdb: the template has no build record, so its schema is unknown." >&2
    echo "testdb: refusing to hand back a database copied from it. Run: scripts/testdb.sh reset" >&2
    exit 1
  fi
  [ "$mine" = "$theirs" ] && return 0
  mine_n=$(migration_count); theirs_n=$(template_meta migration_count)
  echo "testdb: WARNING — the template was built from a different schema than this checkout" >&2
  echo "testdb:   template: ${theirs_n} migrations   this checkout: ${mine_n} migrations" >&2
  if [ "${mine_n:-0}" -gt "${theirs_n:-0}" ]; then
    echo "testdb:   your migrations are NOT in the template. Run: scripts/testdb.sh reset" >&2
  else
    echo "testdb:   your checkout is behind the template. Rebase before trusting a run." >&2
  fi
}

print_env() {
  local db=$1
  echo "export OPENBOOKS_DB_URL='$(url_for "$db")'"
  echo "export OPENBOOKS_RUNTIME_DB_URL='$(runtime_url_for "$db")'"
  echo "export OPENBOOKS_DB_PASSWORD='${RUNTIME_PASS}'"
  echo "export PGPASSWORD='${SUPERPASS}'"
  echo "export NODE_ENV=test"
  echo "export OPENBOOKS_TRUSTED_TEST_BYPASS=1"
  echo "export OPENBOOKS_DATA_KEY='${OPENBOOKS_DATA_KEY:-000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f}'"
  echo "export SESSION_SECRET='${SESSION_SECRET:-openbooks-test-secret-not-production}'"
  echo "export ORG_COUNTRY='${ORG_COUNTRY:-US}'"
  echo "export ORG_CURRENCY='${ORG_CURRENCY:-USD}'"
}

cmd=${1:-help}
case "$cmd" in
  up)
    require_docker
    start_container
    template_ready || build_template
    echo "testdb: ready on port $PORT" >&2
    ;;

  new)
    require_docker
    start_container
    # Held across the readiness check AND the copy: otherwise a concurrent reset
    # can drop the template between deciding it is good and reading from it.
    acquire_lock
    template_ready || build_template
    check_template_freshness
    # Default to the worktree's own name so two agents never collide and a
    # human can tell whose database is whose.
    raw=${2:-$(basename "$(git rev-parse --show-toplevel)")_$(git rev-parse --short HEAD 2>/dev/null || echo local)}
    # printf, not echo: `tr -c` would turn echo's trailing newline into an
    # underscore and silently create a database nobody asked for.
    db=$(printf '%s' "ob_$raw" | tr -c 'a-zA-Z0-9_' '_' | cut -c1-60 | tr 'A-Z' 'a-z')
    psql_super -c "drop database if exists ${db} with (force)" >/dev/null
    psql_super -c "create database ${db} template ${TEMPLATE}" >/dev/null
    # Prove the copy carries the schema the template advertised. A suite that
    # fails on a missing column should be able to blame the product, not us.
    want=$(template_meta fingerprint)
    got=$(psql_super -d "$db" -tAc "select fingerprint from openbooks_testdb_meta limit 1" 2>/dev/null | tr -d " ")
    if [ -z "$got" ] || [ "$got" != "$want" ]; then
      psql_super -c "drop database if exists ${db} with (force)" >/dev/null 2>&1 || true
      echo "testdb: the copy did not match the template it came from; refusing to hand it back." >&2
      exit 1
    fi
    release_lock
    echo "testdb: $db ready (copied from $TEMPLATE)" >&2
    print_env "$db"
    ;;

  env)
    [ $# -ge 2 ] || { echo "testdb: env needs a database name" >&2; exit 1; }
    print_env "$2"
    ;;

  drop)
    require_docker
    [ $# -ge 2 ] || { echo "testdb: drop needs a database name" >&2; exit 1; }
    psql_super -c "drop database if exists $2 with (force)" >/dev/null
    echo "testdb: dropped $2" >&2
    ;;

  status)
    require_docker
    if container_running; then
      echo "container: $CONTAINER running on 127.0.0.1:$PORT ($IMAGE)"
    else
      echo "container: not running"
      exit 0
    fi
    if template_ready; then
      echo "template:  $TEMPLATE ready ($(template_meta migration_count) migrations, fingerprint $(template_meta fingerprint | cut -c1-12))"
    elif template_exists; then
      echo "template:  $TEMPLATE PRESENT BUT NOT READY — no build record; run 'scripts/testdb.sh reset'"
    else
      echo "template:  MISSING — run 'scripts/testdb.sh up'"
    fi
    echo "databases:"
    psql_super -tAc "select datname, pg_size_pretty(pg_database_size(datname)) from pg_database where datname like 'ob\\_%' order by datname" \
      | sed 's/|/  /' | sed 's/^/  /'
    ;;

  gc)
    require_docker
    # Test databases are disposable; anything untouched for a day is abandoned.
    mapfile -t stale < <(psql_super -tAc "
      select d.datname from pg_database d
       where d.datname like 'ob\\_%'
         and not exists (select 1 from pg_stat_activity a where a.datname = d.datname)
         and coalesce((select max(greatest(s.stats_reset, now() - interval '999 days'))
                         from pg_stat_database s where s.datname = d.datname), now())
             < now() - interval '1 day'")
    if [ ${#stale[@]} -eq 0 ]; then echo "testdb: nothing to collect"; exit 0; fi
    for db in "${stale[@]}"; do
      [ -n "$db" ] || continue
      psql_super -c "drop database if exists ${db} with (force)" >/dev/null
      echo "testdb: dropped stale $db"
    done
    ;;

  reset)
    require_docker
    start_container
    # One global template shared by every worktree: a stale checkout rebuilding
    # it would silently regress everyone else's schema.
    theirs_n=$(template_ready && template_meta migration_count || echo 0)
    mine_n=$(migration_count)
    if [ "${2:-}" != "--force" ] && [ "${theirs_n:-0}" -gt "${mine_n:-0}" ]; then
      echo "testdb: refusing to rebuild backwards — the template has ${theirs_n} migrations and this checkout has ${mine_n}." >&2
      echo "testdb: rebase this worktree, or pass --force if you really mean to drop the newer schema." >&2
      exit 1
    fi
    build_template
    ;;

  *)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
