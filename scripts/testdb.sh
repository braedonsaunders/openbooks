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
#   scripts/testdb.sh drop [--dry-run] <name>
#                                        drop one test database (name with or
#                                        without the ob_ prefix; refuses anything
#                                        else; a miss is an error, never a success)
#   scripts/testdb.sh env <name>         print exports for an existing database
#   scripts/testdb.sh status             show the container, template and databases
#   scripts/testdb.sh gc [--dry-run] [--older-than <interval>] [--include-unstamped]
#                                        drop test databases copied more than
#                                        <interval> ago (default 1 day) that hold
#                                        no live connection; --dry-run prints the
#                                        plan and drops nothing
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
# The superuser login to the SAME database: what CI exposes as
# OPENBOOKS_TEST_ADMIN_DB_URL (.github/workflows/test.yml) for the few suites
# that replay migrations or provision a throwaway database.
admin_url_for() { echo "postgres://${SUPER}:${SUPERPASS}@127.0.0.1:${PORT}/$1"; }

require_docker() {
  command -v docker >/dev/null 2>&1 || { echo "testdb: docker is not on PATH" >&2; exit 1; }
  docker info >/dev/null 2>&1 || { echo "testdb: docker is not running" >&2; exit 1; }
}

container_running() { [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" = "true" ]; }

start_container() {
  if container_running; then return; fi
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "testdb: starting $CONTAINER on port $PORT" >&2
  # --shm-size is not optional. Docker's default is 64 MB, and PostgreSQL
  # consumes ~61 MB of /dev/shm at baseline, leaving ~3 MB for the dynamic
  # shared memory a parallel worker needs. Under concurrent suites that runs
  # out and every affected query dies with "could not resize shared memory
  # segment ... No space left on device" — which fails WHOLE suites and reads
  # exactly like a code regression. Measured on one suite: 0 pass / 16 fail
  # against an exhausted /dev/shm, 15 / 16 with headroom, nothing in between
  # but the memory. A false red is worse than a slow test.
  docker run -d --name "$CONTAINER" \
    --shm-size=1g \
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
    OPENBOOKS_TEST_OWNERSHIP_TRANSFER=1 \
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
  # Tests connect as the constrained runtime role (the template transferred
  # ownership to it at build): superuser sessions bypass every RLS policy, so
  # a superuser OPENBOOKS_DB_URL would make isolation assertions vacuous.
  # Interactive superuser psql is still one flag away (PGPASSWORD below is the
  # superuser password): psql -U openbooks -h 127.0.0.1 -p "$PORT" "$db".
  echo "export OPENBOOKS_DB_URL='$(runtime_url_for "$db")'"
  echo "export OPENBOOKS_RUNTIME_DB_URL='$(runtime_url_for "$db")'"
  # Migration-replay and self-provisioning suites (bank-statement-source-
  # evidence, order-quantity-progress-migration, recognition-event-tenant-
  # integrity, hrm migration-cli-gate) need the privileged login and refuse
  # by name without it. Emitting it here is what keeps a local run from
  # ever reaching their refusal.
  echo "export OPENBOOKS_TEST_ADMIN_DB_URL='$(admin_url_for "$db")'"
  # The ephemeral marker, read back from the database's own comment. The
  # fixtures refuse to touch a database whose comment does not carry the
  # marker they were handed (engine/src/testing/fixtures.ts), so a caller who
  # eval'd these exports and still had to stamp it by hand would see EVERY
  # fixture insert fail with a refusal that reads like a broken suite. Emitting
  # it here is what makes `eval "$(scripts/testdb.sh new x)"` sufficient on its
  # own. `env` prints the marker the database already carries, so a second
  # shell joins the same database rather than inventing a marker it rejects.
  local marker
  marker=$(psql_super -tAc "select shobj_description(oid, 'pg_database') from pg_database where datname = '$db'" 2>/dev/null | tr -d ' ')
  case "$marker" in
    openbooks-ci-ephemeral-*) echo "export OPENBOOKS_TEST_DB_MARKER='$marker'" ;;
    *) echo "# testdb: $db carries no ephemeral marker; fixtures will refuse it" >&2 ;;
  esac
  echo "export OPENBOOKS_TEST_DB_ISOLATED=1"
  echo "export OPENBOOKS_DB_PASSWORD='${RUNTIME_PASS}'"
  echo "export PGPASSWORD='${SUPERPASS}'"
  echo "export NODE_ENV=test"
  echo "export OPENBOOKS_TRUSTED_TEST_BYPASS=1"
  echo "export OPENBOOKS_DATA_KEY='${OPENBOOKS_DATA_KEY:-000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f}'"
  echo "export SESSION_SECRET='${SESSION_SECRET:-openbooks-test-secret-not-production}'"
  echo "export ORG_COUNTRY='${ORG_COUNTRY:-US}'"
  echo "export ORG_CURRENCY='${ORG_CURRENCY:-USD}'"
}

# Every test database is named ob_<sanitised>. `new` builds the name this way
# and `drop` must resolve a caller's name identically, or a drop of the name a
# shard was HANDED silently misses (drop used to take the raw argument while
# new prefixed it, and `if exists` turned that miss into a printed success).
# A per-copy nonce for the ephemeral marker. uuidgen is present on macOS and
# in the CI image; the /proc fallback keeps this working in a bare container.
marker_nonce() {
  if command -v uuidgen >/dev/null 2>&1; then uuidgen | tr 'A-Z' 'a-z'
  elif [ -r /proc/sys/kernel/random/uuid ]; then cat /proc/sys/kernel/random/uuid
  else printf '%s-%s' "$$" "$(date +%s)"; fi
}

test_db_name() {
  local raw=$1
  case "$raw" in ob_*) raw=${raw#ob_} ;; esac
  printf '%s' "ob_$raw" | tr -c 'a-zA-Z0-9_' '_' | cut -c1-60 | tr 'A-Z' 'a-z'
}

db_exists() {
  [ "$(psql_super -tAc "select 1 from pg_database where datname = '$1'" 2>/dev/null | tr -d ' ')" = "1" ]
}

worktree_identity() {
  # Hash the canonical checkout path so separate worktrees still get separate
  # databases without exposing local filesystem paths in PostgreSQL names.
  local repo_root=${1:-}
  [ -n "$repo_root" ] || repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)
  repo_root=$(cd "$repo_root" && pwd -P)
  printf '%s' "$repo_root" | shasum -a 256 | cut -c1-16
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
    # Include the worktree identity: BB worktrees all use the basename
    # "openbooks", so basename plus commit alone collides across agents.
    repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)
    repo_name=$(basename "$repo_root")
    head=$(git rev-parse --short HEAD 2>/dev/null || echo local)
    raw=${2:-${repo_name}_${head}_$(worktree_identity "$repo_root")}
    # printf, not echo (inside test_db_name): `tr -c` would turn echo's trailing
    # newline into an underscore and silently create a database nobody asked for.
    db=$(test_db_name "$raw")
    psql_super -c "drop database if exists ${db} with (force)" >/dev/null
    # OWNER is not inherited from the template: CREATE DATABASE assigns the
    # database to the role that RUNS it, and this runs as the superuser. Without
    # this clause every copy is superuser-owned, the runtime role has no CREATE
    # on it, and the first fixture to build a scratch schema dies with
    # "permission denied for database <db>" — naming the database, so it reads
    # like a missing GRANT rather than the wrong owner. The template itself is
    # already RUNTIME_ROLE-owned (bootstrap transfers it), which is exactly why
    # the omission is invisible until a copy is used.
    psql_super -c "create database ${db} template ${TEMPLATE} owner ${RUNTIME_ROLE}" >/dev/null
    # Prove the copy carries the schema the template advertised. A suite that
    # fails on a missing column should be able to blame the product, not us.
    want=$(template_meta fingerprint)
    got=$(psql_super -d "$db" -tAc "select fingerprint from openbooks_testdb_meta limit 1" 2>/dev/null | tr -d " ")
    if [ -z "$got" ] || [ "$got" != "$want" ]; then
      psql_super -c "drop database if exists ${db} with (force)" >/dev/null 2>&1 || true
      echo "testdb: the copy did not match the template it came from; refusing to hand it back." >&2
      exit 1
    fi
    # Stamp the copy with its own creation time: `gc` ages a database from this
    # stamp (a template's built_at says nothing about when the copy was made).
    psql_super -d "$db" -c "alter table openbooks_testdb_meta add column if not exists copied_at timestamptz;
      update openbooks_testdb_meta set copied_at = now();" >/dev/null
    # Stamp the ephemeral marker the fixtures check. Without it every scratch
    # fixture refuses ("scratch fixtures require OPENBOOKS_TEST_DB_MARKER"),
    # which fails a WHOLE suite in seconds and reads like a code regression —
    # three separate lanes hit it today. The marker is per-copy, so it cannot
    # be reused to point a runner at a database it was not handed.
    psql_super -c "comment on database ${db} is 'openbooks-ci-ephemeral-$(marker_nonce)'" >/dev/null
    release_lock
    echo "testdb: $db ready (copied from $TEMPLATE)" >&2
    print_env "$db"
    ;;

  env)
    [ $# -ge 2 ] || { echo "testdb: env needs a database name" >&2; exit 1; }
    # Resolve the name exactly as `new` and `drop` do: `env hr45` must print
    # the exports for ob_hr45, the database `new hr45` created — a raw name
    # printed a URL to a database that does not exist (3D000 at first use).
    print_env "$(test_db_name "$2")"
    ;;

  drop)
    require_docker
    dry_run=0
    if [ "${2:-}" = "--dry-run" ]; then dry_run=1; shift; fi
    [ $# -ge 2 ] || { echo "testdb: drop needs a database name" >&2; exit 1; }
    # test_db_name always yields ob_<name>, so the template, postgres, and
    # anything not created by `new` can never be the target of a typo here.
    db=$(test_db_name "$2")
    if ! db_exists "$db"; then
      echo "testdb: $db does not exist — nothing dropped (asked for '$2')" >&2
      exit 1
    fi
    if [ "$dry_run" = 1 ]; then
      echo "testdb: would drop $db (dry run; nothing dropped)" >&2
      exit 0
    fi
    psql_super -c "drop database ${db} with (force)" >/dev/null
    # Claim the drop only after the catalog no longer lists it.
    if db_exists "$db"; then
      echo "testdb: $db still exists after drop" >&2
      exit 1
    fi
    echo "testdb: dropped $db" >&2
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
    # POLICY (stated so the code can be checked against it): a test database is
    # disposable once it was COPIED more than --older-than ago (default 1 day)
    # AND holds no live connection. Age is read from the copy's own stamp
    # (openbooks_testdb_meta.copied_at, written by `new`); a copy without a
    # stamp has an unknown age and is skipped unless --include-unstamped. The
    # template is never a candidate. --dry-run prints the plan and drops
    # nothing — run it first; it is the only evidence the policy above matches
    # what would happen.
    #
    # History: the previous predicate used greatest(stats_reset, now() - 999 days)
    # and PostgreSQL's GREATEST ignores NULLs, so every idle database evaluated as
    # 999 days old and the "untouched for a day" comment described nothing.
    dry_run=0; older_than="1 day"; include_unstamped=0
    shift
    while [ $# -gt 0 ]; do
      case "$1" in
        --dry-run) dry_run=1 ;;
        --older-than) shift; [ $# -gt 0 ] || { echo "testdb: --older-than needs an interval (e.g. '1 day', '6 hours')" >&2; exit 1; }; older_than=$1 ;;
        --include-unstamped) include_unstamped=1 ;;
        *) echo "testdb: gc: unknown option '$1'" >&2; exit 1 ;;
      esac
      shift
    done
    # Validate the interval as PostgreSQL does, before any candidate is touched.
    psql_super -tAc "select interval '${older_than}'" >/dev/null 2>&1 || { echo "testdb: --older-than '${older_than}' is not a valid interval" >&2; exit 1; }
    mapfile -t idle < <(psql_super -tAc "
      select d.datname from pg_database d
       where d.datname like 'ob\\_%'
         and d.datname <> '${TEMPLATE}'
         and not exists (select 1 from pg_stat_activity a where a.datname = d.datname)
       order by d.datname")
    to_drop=(); skipped=0; kept=0
    for db in "${idle[@]}"; do
      [ -n "$db" ] || continue
      stamp=$(psql_super -d "$db" -tAc "select coalesce(to_char(copied_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), '') from openbooks_testdb_meta limit 1" 2>/dev/null | tr -d ' ' || true)
      if [ -z "$stamp" ]; then
        if [ "$include_unstamped" = 1 ]; then
          echo "testdb: $db — no copy stamp; included by --include-unstamped" >&2
          to_drop+=("$db")
        else
          echo "testdb: $db — no copy stamp (age unknown); skipped, pass --include-unstamped to collect it" >&2
          skipped=$((skipped + 1))
        fi
        continue
      fi
      old=$(psql_super -d "$db" -tAc "select (copied_at < now() - interval '${older_than}')::text from openbooks_testdb_meta limit 1" 2>/dev/null | tr -d ' ' || true)
      if [ "$old" = "true" ]; then
        echo "testdb: $db — copied ${stamp}Z, older than ${older_than}, idle" >&2
        to_drop+=("$db")
      else
        kept=$((kept + 1))
      fi
    done
    if [ ${#to_drop[@]} -eq 0 ]; then
      echo "testdb: nothing to collect (${kept} recent, ${skipped} unstamped skipped)" >&2
      exit 0
    fi
    if [ "$dry_run" = 1 ]; then
      echo "testdb: dry run — would drop ${#to_drop[@]} database(s): ${to_drop[*]} (${kept} recent kept, ${skipped} unstamped skipped); nothing dropped" >&2
      exit 0
    fi
    for db in "${to_drop[@]}"; do
      psql_super -c "drop database ${db} with (force)" >/dev/null
      if db_exists "$db"; then echo "testdb: $db still exists after drop" >&2; exit 1; fi
      echo "testdb: dropped stale $db" >&2
    done
    echo "testdb: collected ${#to_drop[@]} database(s) (${kept} recent kept, ${skipped} unstamped skipped)" >&2
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
