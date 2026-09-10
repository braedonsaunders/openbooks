# /admin/backups ViewSpec integration handoff

Page: `/admin/backups` — stored + scheduled backups (admin page with a
back-linked header and one client workspace: the schedule form, progress
polling and run table inside `BackupManager`).

Files created/edited (all inside `web/app/(app)/admin/backups/`, the only
dir this page owns):

- `view.ts` — `loadAdminBackups()` + `adminBackupsSpec(data)`. The loader
  copies the native page's query, permission and derivation logic verbatim
  (the `admin.backups.manage` gate, the policy/runs queries with the
  `org_id` filter, `order by created_at desc limit 50`, the
  `isoTimestamp` normalization including its throw on invalid input, the
  bigint→Number conversions, the 90-second worker-heartbeat window with
  its fail-closed catch). Title/description are the native page's
  hardcoded strings, byte for byte.
- `BackupManager.tsx` — factored the inline props object into an exported
  `BackupManagerProps` interface so the loader shares the one type. No
  render change: same fields, same optionality.
- `page.tsx` — viewspec branch added FIRST in the component body; native
  branch unchanged. No `sections.tsx`: the page needs no composite cell —
  the body is a single client component, not a spec table.

## WIDGET_REGISTRY entry needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

One entry. Flat props — the spec passes `policy`, `runs`, `s3Enabled`,
`workerOnline` as four top-level props (NOT a single `manager` object):

```tsx
import { BackupManager } from '../../app/(app)/admin/backups/BackupManager'

/* --- admin backups ---------------------------------------------------------- */
// Whole-page widget, not a `table` block: the native page renders one client
// component owning the schedule form (local useState per field), live
// progress polling (setInterval → router.refresh() while a run is in
// flight), and fetch mutations (save policy, run now, delete with
// window.confirm). Form state, effects and capabilities are not spec
// vocabulary, so the component stays whole and the spec places it.
// Null policy (no backup_policies row) renders the form defaults — the same
// `policy?.x ?? default` path the native component already takes.
'backup-manager': (props) => (
  <BackupManager
    policy={(props.policy as ComponentProps<typeof BackupManager>['policy']) ?? null}
    runs={(props.runs as ComponentProps<typeof BackupManager>['runs']) ?? []}
    s3Enabled={props.s3Enabled === true}
    workerOnline={props.workerOnline === true}
  />
),
```

Needed import: `BackupManager` as above. `ComponentProps` already exists
in that file. `BackupManager` is a client component (`"use client"` at
its top); `widgets.tsx` already renders other client components
(`StatementMatrixTable`, `TrendChart`, …), so this needs no new
boundary.

## What the coordinator must NOT create

No new slot is needed. This page needs no org id, user id, Authz or bound
action in the spec: the loader resolves everything server-side and the
spec binds only flat data plus four already-loaded values. `s3Enabled`
is deployment config the page already reads (boolean from env), not a
capability; `workerOnline` is a loader-derived boolean; the session never
crosses the boundary — the same arrangement as `admin apps` (§"must NOT
create"). `BackupManager` owns its mutations through fetch calls to
`/api/admin/backups/*`, exactly as on the native path.

No `packages/viewspec` changes proposed. Header (`pageHeader` with
`back`), body (one widget block) and the `list` layout (native page uses
`ListPageLayout` with no `className` override) are all existing
vocabulary.

## Proposed conformance entry (coordinator: add to `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/admin/backups',
  // Stored + scheduled backups: back-linked header, one BackupManager
  // widget (schedule form + run table). No query params exist on this
  // page, so variants pin the branches that matter: the default seeded
  // list vs a logically distinct single-row selection.
  // GATES: requires `admin.backups.manage` (the harness admin role holds
  // every catalogue key, so the page renders 200 in the harness tenant
  // once the fixture below lands).
  variants: [
    '',
    // Two fixture runs are seeded; without a row-keyed route the second
    // form of coverage is the table-row selector over the seeded rows.
  ],
  expect: 'table tbody tr',
  minMatches: 2,
},
```

Verified against the database (`openbooks_sim_viewspec`, harness user
`viewspec@sim.test`, SIM org): `backup_runs` holds **0** rows and
`backup_policies` holds **0** rows today, so the default variant
currently renders the `noneYet` empty paragraph and matches zero rows.
The fixture below seeds 2 runs (+ 1 policy), so `minMatches: 2` is
exact once fixtures land — re-verify after the coordinator lands the
fixture. `minMatches` is verified against the fixture row counts, not
against today's empty tenant.

S3/worker branch note: the harness deployment has no S3 env set, so
`s3Enabled` is false on both paths and both renders show the
no-object-storage alert — the branch still compares. `workerOnline`
depends on a live Redis heartbeat (fail-closed to false on error in both
paths since the loader is shared verbatim); when no worker has reported
recently both sides show the worker-offline alert, when one has both
sides hide it. Either way the two renders agree because they share the
one loader.

## Fixture SQL (coordinator folds into `scripts/viewspec-fixtures.sql`)

Idempotent: fixed ids, `ON CONFLICT DO NOTHING`, SIM org only (same
`v_org` pattern as the existing blocks). Claims the fresh id block
`…1001-1099` (verified: zero occurrences of `9000-0000000010` in the
fixtures file; neighbors `…09xx` purchase orders and `…11xx` installed
apps are both taken).

Guard note: `backup_policies` has `org_id` as its PRIMARY KEY (one row
per org), so a second insert for the SIM org can never appear — but the
first insert must still guard on prior coordinator fixtures, not just
itself. The `NOT EXISTS` guard below makes the whole block idempotent
even if a future fixture seeds a SIM policy first (plain `ON CONFLICT
DO NOTHING` on the policy row would also skip safely, but then the runs
below would still insert and leave a policy+runs mix no one asserted —
the guard keeps the block all-or-nothing). `backup_runs` has no unique
key besides `id`, so fixed ids + `ON CONFLICT DO NOTHING` suffice there.
The `backup_runs_one_inflight_per_org` partial unique index allows only
one `queued`/`running` row per org: exactly one fixture run is inflight
(`running`), the other is `completed` — a second inflight row would
violate the index.

`sha256` CHECK requires `^[0-9a-f]{64}$` when non-null; the completed
run carries a 64-char hex digest. `purged_at`/`purge_reason` are null on
both rows so both render the `kept` retention cell and the completed row
renders its download/delete actions (the purged branch needs no extra
row: it is the same cell with a different string, and the `kept` string
is the one the harness asserts by byte equality on the seeded rows).

Timestamps are fixed (not `now()`) so the `createdAt` strings are stable
across harness runs. `created_at` desc ordering puts the running
(01:00) run first — exercising the `in progress…` action cell ahead of
the completed row's archive/manifest/delete links.

```sql
  -- ---- admin backups ----------------------------------------------------------
  -- The simulator never runs backups, so the page would compare two
  -- identical empty states. One policy (enabled, weekly) plus two runs:
  -- one completed (downloadable: archive/manifest/delete actions) and one
  -- running (exercises the in-progress cell + the live-polling branch).
  -- Guarded all-or-nothing: backup_policies is one-row-per-org (PK on
  -- org_id), so skip the block if the SIM org already has a policy.
  do $$
  begin
    if not exists (select 1 from backup_policies where org_id = v_org) then
      insert into backup_policies
        (org_id, enabled, frequency, hour_utc, day_of_week, day_of_month,
         max_keep, last_run_at, next_run_at)
      values
        (v_org, true, 'weekly', 2, 1, 1,
         7, timestamptz '2026-08-24 02:00:00+00', timestamptz '2026-08-31 02:00:00+00');

      insert into backup_runs
        (id, org_id, kind, status, file_name, byte_size, table_count,
         row_count, sha256, error, purged_at, purge_reason, created_at,
         completed_at)
      values
        ('00000000-0000-7000-9000-000000001001', v_org, 'scheduled', 'completed',
         'openbooks-2026-08-24.tar.zst', 1048576, 42,
         123456, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
         null, null, null, timestamptz '2026-08-24 02:00:00+00',
         timestamptz '2026-08-24 02:04:11+00'),
        ('00000000-0000-7000-9000-000000001002', v_org, 'manual', 'running',
         null, null, null,
         null, null, null, null, null, timestamptz '2026-08-30 01:00:00+00',
         null)
      on conflict (id) do nothing;
    end if;
  end $$;
```

## Could not express

Nothing structural. Judgment calls, all following the stated machinery
rules:

1. The entire body is one widget. The schedule form is per-field
   `useState` initialized from props, the runs table hand-rolls a plain
   `<table>` with its own classes (same doctrine as `admin-users-table`),
   and row actions are fetch mutations behind `window.confirm` — roughly
   half the component is client state, effects or capabilities. Splitting
   the static cards into spec blocks around a form widget would byte-split
   one component for no fidelity gain; it stays whole.
2. `formatBytes`/`formatWhen` stay inside `BackupManager`. They take
   loader-resolved ISO strings/numbers and use the browser locale
   (`toLocaleString`) — formatting in the component IS the native
   behavior, and moving it to the loader would change rendered output.
   Same reason the users table keeps its formatting client-side.
3. No drawer, no pager, no filters: the page has no query params (the
   runs list is a fixed `limit 50`, unpaginated), so `loadAdminBackups`
   takes no `sp` — same as `loadAdminHub`. The loader still receives no
   search params in the spec branch; `sp` is passed to `ModuleView`
   (required prop) but carries only `__viewspec`.
4. The `hasActiveRun` poll (`setInterval` → `router.refresh()`) is
   client behavior the harness's settled-DOM comparison tolerates: both
   paths mount the same component with the same props, so both poll (or
   both don't) identically.
```

