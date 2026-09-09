#!/usr/bin/env bash
# Build, restart the preview server, and run ViewSpec conformance.
#
#   scripts/viewspec-verify.sh                 # all registered pages
#   scripts/viewspec-verify.sh /admin/api-keys # one page
#   SKIP_BUILD=1 scripts/viewspec-verify.sh    # re-run against the live server
#
set -euo pipefail

REPO="/Users/braedonsaunders/Documents/openbooks"
PORT="${VIEWSPEC_PORT:-4780}"
DB="${VIEWSPEC_DB:-postgres://openbooks_app:openbooks_app@127.0.0.1:55439/openbooks_sim_viewspec}"

cd "$REPO"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  (cd web && OPENBOOKS_DB_URL="$DB" NODE_OPTIONS=--max-old-space-size=8192 \
    node "$REPO/node_modules/next/dist/bin/next" build 2>&1 |
    { grep -E "Failed|Error:|error TS|✓ Compiled" || true; } | head -20)

  for _ in 1 2 3; do
    lsof -ti:"$PORT" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
    sleep 1
  done

  (cd web && OPENBOOKS_DB_URL="$DB" \
    SESSION_SECRET="$(grep '^SESSION_SECRET=' "$REPO/.env" | cut -d= -f2-)" \
    OPENBOOKS_DATA_KEY="$(grep '^OPENBOOKS_DATA_KEY=' "$REPO/.env" | cut -d= -f2-)" \
    nohup node "$REPO/node_modules/next/dist/bin/next" start -p "$PORT" \
    > "${TMPDIR:-/tmp}/ob$PORT.log" 2>&1 &)
  sleep 16
fi

cd "$REPO"
node scripts/viewspec-conformance.mjs "$@"
