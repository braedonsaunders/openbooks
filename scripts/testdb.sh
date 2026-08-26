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

build_template() {
  local repo
  repo=$(git rev-parse --show-toplevel)
  echo "testdb: building $TEMPLATE (migrations run once, then every new database is a copy)" >&2
  psql_super -c "drop database if exists ${TEMPLATE} with (force)" >/dev/null
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
  psql_super -c "update pg_database set datistemplate = true where datname = '${TEMPLATE}'" >/dev/null
  echo "testdb: template ready" >&2
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
    build_template
    ;;

  *)
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
