# /sync ViewSpec integration handoff

Page: `web/app/(app)/sync/` — Platform → Migrations & Mirror (tenant
connections to external accounting systems, one-click migration, daily
mirror, trial-balance verification, runs history).

Files created/edited (all inside `web/app/(app)/sync/`, the only dir this
page owns):

- `view.ts` — `loadSync()` + `syncSpec(data)`. The loader resolves the
  header copy (`sync.title`, `sync.description`, `admin.hub.title` — all
  already used by the native page) and the `/admin` back link. It runs NO
  permission gate, verbatim from `page.tsx`: the native component is a bare
  sync function with no server check, and the `admin.setup.manage` gate
  lives in the API handlers (`route.ts:41,121`), which both render paths
  hit identically through the client's own fetches.
- `page.tsx` — `__viewspec` branch added FIRST in the component body (exact
  brief idiom, `ModuleView … trusted` + proof-of-path meta); native branch
  unchanged. The component is now `async` and takes `searchParams` — that
  is the conversion, not a behaviour change: the native branch ignores the
  params exactly as before.
- No `sections.tsx`: the spec needs no composite cells (there is no spec
  table at all), and `PlatformClient` is imported directly from
  `./PlatformClient`, not copied — so both render paths already share one
  implementation and `PlatformClient.test.tsx` passes untouched.

Read `web/app/(app)/query/view.ts` + its INTEGRATION.md before touching
this spec: `/query` is the same degenerate case (fully client-side
workbench, zero server-rendered content, whole-island widget, empty data
type) and this conversion follows it deliberately. Also read
`web/app/(app)/admin/backups/view.ts`: same `PageHeader` + single-client-
component body, except backups threads server data through widget props
while sync threads none (see §1 for why).

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed:

```tsx
import { PlatformClient } from '../../app/(app)/sync/PlatformClient'
```

Entry (place near `backup-manager` / `query-console`, the other whole-
island client workbenches):

```tsx
/* --- platform sync ---------------------------------------------------------- */
/**
 * The whole Migrations & Mirror console, placed whole rather than
 * decomposed into blocks: the connections list, runs table (client-side
 * searchable + paginated PagedTable), add/edit drawer with per-field
 * useState, OAuth setup box, and every fetch/mutation (2.5s live-poll
 * while a run is in flight, run/test/toggle-mirror/schedule/deletion-
 * resolve/delete with busy flags, window.confirm for the destructive ones,
 * window.open for OAuth + QWC download) are client state, effects and
 * capabilities — none of which a spec can name. Same precedent as
 * `query-console` / `backup-manager` / `match-workspace`, which likewise
 * render loader-independent client islands directly with no props.
 */
'sync-console': () => <PlatformClient />,
```

Exact prop shape: **no props**. `PlatformClient` takes zero props
(`export function PlatformClient()` — `PlatformClient.tsx:187`); it
fetches `GET /api/platform/connections` on mount and reads its own
`sync.*` + `admin.hub.*` keys through `useTranslations`, exactly as the
native branch does.

Why not thread server data through props (the `backup-manager` shape):
there is no server data. Connections, runs, source-type manifests and
currencies all arrive over the client's fetch after mount; the loader
cannot precompute what does not exist until the user is authenticated in
the browser, and threading static header strings through widget props
would double every `sync.*` key and drift from the catalog on the first
copy edit. `SyncData` carries the four header strings because the
`page-header` block needs them; the widget itself carries nothing.

Why not decompose the connections list into `repeat` + `table` blocks:
every row is action-dense (connect/reconnect, download-QWC, test, mirror-
now, project-financials, attachments, preflight, run-migration,
pause/enable-mirror, schedule select, edit, delete) and every action is a
fetch mutation with busy/disabled state, toasts, and (for delete/deletion-
resolve) `window.confirm`. A spec cannot express fetches, busy flags, or
`confirm()`; a decomposed husk would match pixels exactly once — before
the client's fetch resolves — and then be a dead, buttonless picture next
to the live native console. The harness compares post-settle DOM including
client-fetched content, so the widget must BE the client.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/sync',
  // Fully client-side console: both paths serve the same PlatformClient
  // (imported directly, not copied), identical by construction. The default
  // variant pins the populated branches — connections heading + the two
  // fixture connection cards (netsuite + qbd) + the runs table with ≥2
  // fixture rows (table path, not just the empty note). The runs search
  // is client-side component state (invisible to the URL) and the
  // add/edit drawer opens by click, so no query string reaches a second
  // branch — one variant, like /docs.
  variants: [
    { query: '', expect: 'table tbody tr', minMatches: 2 },
  ],
  expect: 'table tbody tr',
  minMatches: 2,
},
```

GATES + DATA verification (read-only queries, 2026-09-10) — verify
against the page's GATES, not just row counts:

- Page gate: none. `page.tsx` is a bare sync function — no
  `requirePermission`, no feature flag, no `notFound()`. Both paths
  render the shell for any authenticated user.
- API gate (hit identically by both paths' client fetch):
  `guardPermission('admin.setup.manage')` (`route.ts:41`). Harness user
  `viewspec@sim.test` (`01a08426-0962-74c7-a086-e1609c589dcb`, org
  `da472d3a-98e5-4fa5-a6ee-2451e6d6970a` "SIM · Summit Ridge
  Construction") holds the `admin` role, whose permissions array contains
  `"admin.setup.manage"` (verified by direct SELECT). Gate passes.
- Live DB state (the reason §3 is REQUIRED — do NOT register this entry
  until the fixture is applied):
  - `connections` for the SIM org: **0 rows** (verified 2026-09-10).
    Without the fixture both paths render the "No connections yet" empty
    note — a byte-perfect match of two empty states that proves nothing
    about the card/action branches (the exact false-pass the fixtures
    file header warns about).
  - `sync_runs` for the SIM org: **0 rows** (verified 2026-09-10). The
    runs section (`data.runs.length > 0`) does not render at all, so
    `expect: 'table tbody tr'` FAILS on both paths today — correctly.
    After §3 it matches ≥2.
  - `currencies`: 40 rows — the `optionsSource: 'currencies'` select in
    the drawer resolves without fixture help.

Two harness mechanics this entry deliberately respects:

- `minMatches: 2` counts CLIENT-FETCHED rows: `renderSettled` waits for
  the selector count (bounded 15s poll), so the 2 fixture runs (inserted
  below with `started_at` in the past, `status = 'ok'`, no live-poll
  loop) are settled content, not timing noise. The selector names the
  runs `PagedTable` (`table tbody tr` — PagedTable renders a real
  `<table>`, `web/components/paged-table.tsx:108-119`), never the
  connection cards (plain divs, no stable row selector).
- Single variant: `assertVariantsDiffer` (conformance.mjs:1544) fails an
  entry whose ≥2 variants render byte-identical markup. A second query
  variant is vacuous here — the page takes no search params (the runs
  search is client-side component state, invisible to the URL), so any
  second variant would render identical markup BY CONSTRUCTION and trip
  the check. The empty-runs branch is intentionally NOT pinned as a
  variant for the same reason: with the fixture applied no URL reaches
  it.

## 3. Fixture SQL (for the coordinator — fold into `scripts/viewspec-fixtures.sql`)

Fresh block claim: **`…1201-1299`** (1 connection id + 3 run ids + 1
qbd-session id + 1 qbd-capture id; the 2nd connection reuses no id).
Verified free 2026-09-10: `grep -c "0000000012"` over the whole fixture
file returns **0**, and a whole-file grep for each id below
(`000000001201`, `000000001211`, `000000001212`, `000000001213`,
`000000001214`, `000000001215`) returns nothing — so no `ON CONFLICT DO
NOTHING` silent skip. Block `…1201-1299` appears nowhere in the
allocation table at the top of the file (nearest claims are `…1101-1199`
installed apps and `…1801-1899` payroll); add it there when folding in:

```
--   …1201-1299  platform sync connections and runs
```

```sql
  -- ---- platform sync connections + runs (/sync) ---------------------------
  --
  -- The simulator never connects an external accounting system, so the SIM
  -- org holds zero `connections` and zero `sync_runs` rows: /sync renders
  -- its "No connections yet" note and no runs table at all. One populated
  -- connection card (netsuite, token auth, mirror on) + one qbd connection
  -- (token auth, exercises the qbd heartbeat/capture/docs branch) + two
  -- finished runs (an `incremental` mirror run carrying
  -- mirror/openItems/periods stats for the result-summary path, and an
  -- `attachments` run for the attachments-summary path) give the harness
  -- the card branches AND ≥2 `table tbody tr` rows to compare. Both runs
  -- are `status = 'ok'` in the past: nothing is `running`, so the client's
  -- 2.5s live-poll loop stays off and the capture settles.
  --
  -- Cross-page impact: nil. `sync_runs` is read only by the platform API
  -- and the (currently unreferenced) `dashboardData` in web/lib/data.ts;
  -- `connections` only by the platform API + sync engine. No other
  -- converted page counts or lists either table.
  --
  -- Guarded all-or-nothing like the backup block: the UNIQUE key is
  -- (org_id, display_name), not the id — ON CONFLICT (id) alone would
  -- raise on a re-run that collides on name, so the guard owns
  -- idempotence. `posted_change_policy` stays 'review_required' (the
  -- CHECK requires authorized_by/at to be NULL in that case — the
  -- fixtures set neither). Secrets are a sealed-blob-shaped placeholder:
  -- never unsealed by the list path (`toClient` returns only
  -- `hasSecrets`), and the fixture sets no real credential.
  declare
    v_conn_ns uuid := '00000000-0000-7000-9000-000000001201';
  begin
    if not exists (select 1 from connections where org_id = v_org and display_name = 'ViewSpec NetSuite') then
      insert into connections
        (id, org_id, source, display_name, auth_kind, status, config,
         secrets, mirror_enabled, mirror_schedule, cursor, last_run_at,
         last_error, posted_change_policy)
      values
        -- Token-auth connection with mirror on: exercises the source +
        -- status + mirror badges, the lastRun/cursor line, the mirror-health
        -- line, and the netsuite-only project-financials/attachments
        -- actions + attachment-health line.
        (v_conn_ns, v_org, 'netsuite', 'ViewSpec NetSuite', 'token',
         'active', '{"account": "1234567", "baseCurrency": "USD"}',
         'sealed:viewspec-fixture', true, 'daily',
         timestamptz '2026-08-28 06:00:00+00',
         timestamptz '2026-08-28 06:04:11+00',
         null, 'review_required'),
        -- Second connection on the qbd branch: heartbeat + capture status
        -- + docs link (qbdStatus comes from qbd_sessions/qbd_captures,
        -- seeded below). No secrets: shows the unconfigured-status path.
        ('00000000-0000-7000-9000-000000001202', v_org, 'qbd',
         'ViewSpec QuickBooks Desktop', 'token', 'unconfigured',
         '{"historyStartDate": "2020-01-01", "region": "US", "baseCurrency": "USD"}',
         null, false, 'daily', null, null, null, 'review_required')
      on conflict (id) do nothing;

      insert into sync_runs
        (id, org_id, connection_id, source, kind, status, started_at,
         finished_at, synced_through, stats, progress, error_message,
         triggered_by)
      values
        ('00000000-0000-7000-9000-000000001211', v_org, v_conn_ns,
         'netsuite', 'incremental', 'ok',
         timestamptz '2026-08-28 06:00:00+00',
         timestamptz '2026-08-28 06:04:11+00',
         timestamptz '2026-08-28 06:00:00+00',
         '{"docsNew": 12, "docsAmended": 3, "docsUnchanged": 140,
           "tb": {"matches": 42, "accounts": 42},
           "openItems": {"checked": 18, "matches": 18},
           "periods": {"checked": 4, "matches": 4}}',
         '{}', null, 'schedule'),
        ('00000000-0000-7000-9000-000000001212', v_org, v_conn_ns,
         'netsuite', 'attachments', 'ok',
         timestamptz '2026-08-28 07:00:00+00',
         timestamptz '2026-08-28 07:02:33+00',
         timestamptz '2026-08-28 06:00:00+00',
         '{"sourceFiles": 9, "sourceLinks": 9, "createdFiles": 9}',
         '{}', null, 'manual')
      on conflict (id) do nothing;

      -- qbd heartbeat + latest capture for the second connection (the API
      -- takes max(last_seen_at) and the latest capture row).
      insert into qbd_sessions
        (id, org_id, connection_id, status, last_seen_at, expires_at)
      values
        ('00000000-0000-7000-9000-000000001214', v_org,
         '00000000-0000-7000-9000-000000001202', 'active',
         timestamptz '2026-08-29 12:00:00+00',
         timestamptz '2026-09-05 12:00:00+00')
      on conflict (id) do nothing;

      insert into qbd_captures
        (id, org_id, connection_id, status, captured_through, progress,
         expires_at, finished_at, created_at)
      values
        ('00000000-0000-7000-9000-000000001215', v_org,
         '00000000-0000-7000-9000-000000001202', 'complete',
         timestamptz '2026-08-29 11:00:00+00',
         '{"completed": 41, "total": 41}',
         timestamptz '2026-09-05 11:00:00+00',
         timestamptz '2026-08-29 11:04:02+00',
         timestamptz '2026-08-29 11:00:00+00')
      on conflict (id) do nothing;
    end if;
  end;
```

Why these two sources: `netsuite` (token) exercises the status/mirror
badges, the mirror + attachment health lines, and the netsuite-gated
project-financials/attachments buttons; `qbd` (token) exercises the
heartbeat/capture/docs branch and the `downloadQwc` action. The three
`oauth2` sources (qbo/xero/dynamics) render the connect/reconnect branch
only when `status !== 'active'` — covered structurally by the qbd
`unconfigured` row's absence of OAuth buttons only insofar as both paths
share the component; no third connection is needed because all three
branches are the same component code served identically to both paths.

Why no `source_deletion_resolutions` / unresolved-deletions row: the
amber deletions box renders from `stats->'deletedAtSource'` on the
latest mirror run MINUS resolved keys. Seeding one would pin the box on
both paths (same component, still identical) — but the retain/void
buttons behind it POST mutations, and a fixture that invites the
harness to click would resolve the fixture's own deletion and make the
second run's markup differ from the first. Read-only fixtures only.

## 4. Anything that could not be expressed (and why)

Nothing structural. Two deliberate non-goals, both shared with the
`/query` precedent:

1. **No `sections.tsx`.** The brief asks for one only when the spec
   needs composite cells (or a local component both paths share). This
   spec needs no cells, and `PlatformClient` is imported directly — not
   moved, not copied — so there is no second implementation to drift.
   Creating an empty re-export file would add an import hop for no
   buyer.
2. **No permission / visibility logic in the loader.** There is none on
   the page: the native component checks nothing server-side, and the
   API's `admin.setup.manage` gate plus its org-scoped queries (including
   the visibility-filtered counts the brief calls out — runs are
   `where org_id = …`, connections via `listConnections(orgId)`) execute
   identically for both render paths because both paths mount the same
   component that makes the same fetches. A loader-side gate would be a
   behaviour change (403/redirect where the native page renders + shows
   its own toast), not a conversion.

## 5. New ViewSpec vocabulary needed

None. `page`, `page-header` (with `back`), `widget`, `frame`
(`page-container` — already registered), `grid` (unused here) cover it;
`sync-console` is a registry entry, not a language change.
