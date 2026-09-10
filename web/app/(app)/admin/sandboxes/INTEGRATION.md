# /admin/sandboxes ViewSpec integration handoff

Page: `/admin/sandboxes` — Environments admin (sandbox list + create form).
Owner files are `view.ts` (+ this file) and the `__viewspec` branch +
imports in `page.tsx`. No `sections.tsx`: the body is a single whole-page
client component, not spec-composed cells (see below).

Files created/edited (all inside `web/app/(app)/admin/sandboxes/`, the only
dir this page owns):

- `view.ts` — `loadSandboxes()` + `sandboxesSpec(data)`. The loader copies
  the native page's query, permission and derivation logic verbatim (the
  `admin.sandboxes.manage` gate, the home-production-org scoping of both
  queries via `authz.user.productionOrgId`, the periods query with its
  `order by fiscal_year desc, period_number desc limit 240`, the hardcoded
  `Environments` title/description and the back link to `/admin` with the
  `admin.hub` title label). The production-vs-inside-a-sandbox branch
  becomes two loader-computed presence flags (`insideSandbox` /
  `showManager`); the spec never asks which environment is active.
- `page.tsx` — viewspec branch added FIRST in the component body (plus the
  `searchParams` prop the branch needs); native branch unchanged.

## 1. WIDGET_REGISTRY entry (coordinator: add to `web/components/viewspec/widgets.tsx`)

One entry. Flat props — the spec passes `sandboxes` and `periods` as two
top-level props (NOT a single `manager` object):

```tsx
import { SandboxManager } from '../../app/(app)/admin/sandboxes/SandboxManager'

/* --- admin sandboxes ---------------------------------------------------------- */
// Whole-page widget, not `table` blocks: the native page renders one client
// component owning the create form (local useState per field, including the
// tier-gated as-of period select and the needsPeriod create guard), per-row
// mutations through BOUND SERVER ACTIONS (create/refresh/reset/delete/
// setSchedule/promote — no Authz or orgId may cross a spec boundary, so the
// actions stay inside the component exactly as on the native path),
// confirm/prompt dialogs, and org switching via enterOrg. Form state,
// effects, dialogs and capabilities are not spec vocabulary, so the
// component stays whole and the spec places it. The review-change-sets link,
// the empty state, the status/tier/masked badges, the storage/error/refresh
// lines and the per-row action buttons all render inside the component.
'sandbox-manager': (props) => (
  <SandboxManager
    sandboxes={
      props.sandboxes as ComponentProps<typeof SandboxManager>['sandboxes']
    }
    periods={
      props.periods as ComponentProps<typeof SandboxManager>['periods']
    }
  />
),
```

Needed import: `SandboxManager` as above. `ComponentProps` already exists
in that file. `SandboxManager` is a client component (`"use client"` at
its top); `widgets.tsx` already renders other client components
(`StatementMatrixTable`, `TrendChart`, …), so this needs no new boundary.

Prop shape (EXACT — the coordinator wires these verbatim):

- `sandboxes`: `SandboxRow[]` where `SandboxRow = { id: string;
  orgId: string; name: string; tier: string; masked: boolean;
  status: string; lastError: string | null; lastRefreshAt: string | null;
  refreshSchedule: string | null; storageRows: number; createdAt: string }`
  (the exported `SandboxRow` interface in `SandboxManager.tsx`;
  `lastRefreshAt`/`createdAt` arrive as ISO strings — see §3).
- `periods`: `PeriodOption[]` where `PeriodOption = { id: string;
  name: string }` (exported in `SandboxManager.tsx`).

## 2. What the coordinator must NOT create

No new slot is needed. This page needs no org id, user id, Authz or bound
action in the spec: `requirePermission('admin.sandboxes.manage')` runs in
the loader, `listSandboxes` takes the loader-resolved
`authz.user.productionOrgId` (never spec-supplied), and the server actions
stay inside `SandboxManager` exactly as on the native path — the same
arrangement as `admin backups` ("must NOT create": no slot when the loader
resolves everything and mutations travel through the component). No
`packages/viewspec` changes proposed: `pageHeader` (with `back`), the
`text` block, `widget` blocks and the `list` layout (native page uses
`ListPageLayout` with no `className` override) are all existing vocabulary.

## 3. Loader normalization note (byte-equality)

The native path passes the `listSandboxes` rows through RSC
serialization, which emits driver `Date` objects as ISO strings before
`SandboxManager` calls `new Date(s.lastRefreshAt).toLocaleString()` and
renders `storageRows.toLocaleString()`. The loader normalizes
`lastRefreshAt`/`createdAt` to ISO strings up front so the spec path binds
the same presentation-ready values. `storageRows` stays a number (the
component formats it). `periodsRes.rows` pass through untouched (plain
`{ id, name }` strings on both paths).

The inside-a-sandbox notice (`You are currently inside a sandbox…`) is a
`text` block, not part of the widget: it renders on the native path
WITHOUT `SandboxManager`, so folding it into the widget would add/remove a
`<p>` the native render does not have on one branch. Class string
transcribed from the native paragraph
(`text-sm text-amber-700 dark:text-amber-400`): the `sm` size supplies
`text-sm` and the amber classes ride along as a literal `className`
appended after the tone (blocks.tsx renders
`cn(size, tone, className)`), because the tone ramp's `warning` step is
`text-amber-600`, not the native `amber-700`.

## 4. Proposed conformance registry entry (coordinator: add to `scripts/viewspec-conformance.mjs`)

The SIM tenant holds **0** sandbox rows today and the SIM org has **3**
accounting periods (`2026-03`, `2026-02`, `2026-01`), verified:

```js
{
  path: '/admin/sandboxes',
  // Whole-page client component: the create form + per-row cards render
  // inside SandboxManager. Two fixture rows (one ready/masked with no
  // error, one failed with a lastError + schedule) pin the badge,
  // storage/error/refresh-line and schedule-select branches; three SIM
  // periods already cover the tier select's as-of options.
  // GATES: requires `admin.sandboxes.manage` (the harness admin role holds
  // every catalogue key) and the harness session runs in production, so
  // the manager branch renders on both paths. The inside-sandbox notice
  // branch is NOT exercised in the harness tenant (no sandbox session
  // exists there); it compares by construction — both paths share the one
  // loader and the same two presence flags.
  variants: [''],
  expect: 'main div.space-y-3 div.p-4',
  minMatches: 2,
},
```

`minMatches: 2` counts the two seeded sandbox cards (each row is a
`Card className="p-4"` inside the `div.space-y-3` list container — the
create-form card is `p-4` too but lives outside `space-y-3`, and the
`Review change sets` outline button carries no `p-4`). Verified against
the fixture row counts below, not against today's empty tenant: with 0
rows both paths render `No environments yet.` and match zero cards. The
selector keys off the native component's own literal classes
(`space-y-3` list wrapper, `p-4` cards in `SandboxManager.tsx` lines 128
and 134), so it survives no restyle the component itself does not make.

## 5. Fixture SQL (coordinator folds into `scripts/viewspec-fixtures.sql`)

Idempotent: fixed ids, `ON CONFLICT DO NOTHING`, SIM org only (same
`v_org` pattern as the existing blocks). Claims the fresh id block
`…1501-1599` for BOTH the org rows and the sandbox rows (verified: zero
occurrences of `9000-0000000015` in `scripts/viewspec-fixtures.sql` AND in
every other page's `INTEGRATION.md` proposal — `…14xx` was first choice but
is claimed by the assistant-page proposal).

```sql
  -- ---- admin sandboxes (…1501-1599; verified free in fixtures + proposals) ------
  -- The simulator never clones sandboxes, so the page would compare two
  -- identical empty states. Two rows: one ready/masked with no error (pins
  -- the success badge, the masked badge, the tier badge, the
  -- never-refreshed line), one failed/unmasked with a lastError and a
  -- daily schedule (pins the destructive badge, the error line, the
  -- refreshed line, the auto-refresh suffix). The harness session runs in
  -- production, so the manager branch renders on both paths.
  --
  -- Cross-page note: each sandbox needs its own org row (orgs.id FK). The
  -- fixture orgs are env_kind='sandbox' children of the SIM org via
  -- sandbox_of, so the platform-organizations page keeps comparing: its
  -- default sort is name asc and its entry asserts minMatches 2 on the
  -- first page, which the SIM production org + fixtures still satisfy.
  -- The SIM org's own sandboxCount becomes 2 on both renders (same
  -- loader), so that cell agrees too.
  declare
    v_sbx_org_a uuid := '00000000-0000-7000-9000-000000001501';
    v_sbx_org_b uuid := '00000000-0000-7000-9000-000000001502';
  begin
    insert into orgs (id, name, base_currency, country, env_kind, sandbox_of)
    values (v_sbx_org_a, 'ViewSpec Sandbox Alpha', 'USD', 'US', 'sandbox', v_org),
           (v_sbx_org_b, 'ViewSpec Sandbox Beta', 'USD', 'US', 'sandbox', v_org)
    on conflict (id) do nothing;

    insert into sandboxes
      (id, org_id, production_org_id, name, tier, masked, status,
       last_error, last_refresh_at, refresh_schedule, storage_rows, created_at)
    values ('00000000-0000-7000-9000-000000001511', v_sbx_org_a, v_org,
            'ViewSpec QA', 'masked', true, 'ready',
            null, null, null, 123456,
            '2026-02-10T15:00:00Z'),
           ('00000000-0000-7000-9000-000000001512', v_sbx_org_b, v_org,
            'ViewSpec UAT', 'full', false, 'failed',
            'Clone failed: disk full', '2026-02-09T09:30:00Z', 'daily', 789,
            '2026-02-08T12:00:00Z')
    on conflict (id) do nothing;
  end;
```

Guard notes:

- `sandboxes` has no unique key besides `id`, so fixed ids +
  `ON CONFLICT DO NOTHING` suffice; rows scope to the SIM org via
  `production_org_id = v_org`, so `listSandboxes` returns exactly these
  two in the harness tenant. `created_at desc` ordering puts the QA row
  (Feb 10) first.
- The sandbox `org_id` FK requires the org rows; they insert first in the
  same block. `as_of_period_id` stays null (no period FK involved).
  `storage_rows` is NOT NULL with no readable default reliance — both rows
  set it explicitly.
- Timestamps are FIXED (not `now()`) so `lastRefreshAt`/`createdAt`
  strings are stable across harness runs; the loader normalizes them to
  ISO (§3), and both renders share the one loader, so the
  `toLocaleString()` lines agree byte for byte.
- `refresh_schedule = 'daily'` on the failed row exercises the schedule
  `<Select value>` without tripping the
  `backup_runs_one_inflight_per_org`-style partial index — sandboxes has
  no such index.
- No other converted page reads `sandboxes` scoped by production org
  except `/platform/organizations` (aggregate `sandboxCount`, covered
  above); `api-keys`/`custom-fields`/`scripts` fixtures assert drawer
  scopes, unaffected.

## 6. Anything not expressed (and why)

- The `SandboxManager` internals (create-form state, tier-gated as-of
  select, `needsPeriod` guard, per-row buttons/dialogs/actions, Enter
  org-switch, change-sets link): client state, effects and bound server
  actions — not spec vocabulary. The component is shared whole between
  both paths (no `sections.tsx`, no second copy).
- The `PromoteButton` sub-component (prompt dialog + router push +
  error alert): same reason — lives inside `SandboxManager`.
- No new ViewSpec vocabulary needed. The only renderer-adjacent fact
  worth stating: the `text` block's `className` appends AFTER the tone
  class (blocks.tsx `cn(size, tone, className)`), which is what makes the
  amber-700 literal transcription exact rather than approximate.
```

```tsx
// page.tsx diff (already applied in this worktree):
import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadSandboxes, sandboxesSpec } from "./view";

export default async function SandboxesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadSandboxes()
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={sandboxesSpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  // …native branch unchanged below…
```
