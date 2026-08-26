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
TEMPLATE=openbooks_template
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

template_exists() {
  [ "$(psql_super -tAc "select 1 from pg_database where datname='${TEMPLATE}'" 2>/dev/null)" = "1" ]
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
  # One global template, many worktrees. Without this lock two concurrent
  # rebuilds interleave and the loser's schema wins silently.
  exec 9>"${TMPDIR:-/tmp}/openbooks-testdb-template.lock"
  flock 9 2>/dev/null || true
  echo "testdb: building $TEMPLATE (migrations run once, then every new database is a copy)" >&2
  drop_template
  psql_super -c "create database ${TEMPLATE}" >/dev/null
  (
    cd "$repo"
    NODE_ENV=test \
    OPENBOOKS_DB_URL="$(url_for "$TEMPLATE")" \
    OPENBOOKS_RUNTIME_DB_URL="$(runtime_url_for "$TEMPLATE")" \
    OPENBOOKS_DB_PASSWORD="$RUNTIME_PASS" \
    OPENBOOKS_DATA_KEY=${OPENBOOKS_DATA_KEY:-000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f} \
    SESSION_SECRET=${SESSION_SECRET:-openbooks-test-secret-not-production} \
    ORG_COUNTRY=${ORG_COUNTRY:-US} ORG_CURRENCY=${ORG_CURRENCY:-USD} \
    npx tsx scripts/bootstrap.ts >&2
  )
  # A template must have no other sessions, and marking it as one keeps a stray
  # connection from silently breaking every later copy.
  # Record which schema built this template so a stale checkout cannot rebuild
  # it backwards without saying so.
  psql_super -d "$TEMPLATE" -c "
    create table if not exists openbooks_testdb_meta (
      fingerprint text not null, migration_count int not null, built_at timestamptz not null default now());
    delete from openbooks_testdb_meta;
    insert into openbooks_testdb_meta (fingerprint, migration_count)
    values ('$(schema_fingerprint)', $(migration_count));" >/dev/null
  psql_super -c "update pg_database set datistemplate = true where datname = '${TEMPLATE}'" >/dev/null
  echo "testdb: template ready ($(migration_count) migrations)" >&2
}

# Warn loudly when the template was built from a different schema than the
# caller's checkout. Silence here is what let a worker copy a template missing
# its own migration and conclude the migration did not work.
check_template_freshness() {
  local mine theirs mine_n theirs_n
  mine=$(schema_fingerprint); theirs=$(template_meta fingerprint)
  [ -z "$theirs" ] && return 0
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
    template_exists || build_template
    echo "testdb: ready on port $PORT" >&2
    ;;

  new)
    require_docker
    start_container
    template_exists || build_template
    check_template_freshness
    # Default to the worktree's own name so two agents never collide and a
    # human can tell whose database is whose.
    raw=${2:-$(basename "$(git rev-parse --show-toplevel)")_$(git rev-parse --short HEAD 2>/dev/null || echo local)}
    # printf, not echo: `tr -c` would turn echo's trailing newline into an
    # underscore and silently create a database nobody asked for.
    db=$(printf '%s' "ob_$raw" | tr -c 'a-zA-Z0-9_' '_' | cut -c1-60 | tr 'A-Z' 'a-z')
    psql_super -c "drop database if exists ${db} with (force)" >/dev/null
    psql_super -c "create database ${db} template ${TEMPLATE}" >/dev/null
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
    template_exists && echo "template:  $TEMPLATE present" || echo "template:  MISSING — run 'scripts/testdb.sh up'"
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
    theirs_n=$(template_exists && template_meta migration_count || echo 0)
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
