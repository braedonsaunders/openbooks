# /admin/apps ViewSpec integration handoff

Page: `/admin/apps` — installed apps (admin list with search, status filter
chips, an app-variant table with an in-table spanning empty row, pagination
and the app flyout `?app=<key>`).

Files created (all inside `web/app/(app)/admin/apps/`, the only dir this page owns):

- `view.ts` — `loadAdminApps(sp)` + `adminAppsSpec(data)`. The loader copies
  the native page's query, permission and formatting logic verbatim (the
  `apps.manage` gate, the `apps` feature gate, status + search `where`,
  status counts, the `?app=` drawer lookup with its files/runs/published
  payload, `dateTime` formatting, `v`-prefixed versions, `installed` →
  `success` badge variant).
- `sections.tsx` — `AppKeyCell`, the `<code className="text-xs
  text-slate-500">` key cell. The native `page.tsx` imports it back, so both
  paths share one implementation; the spec places it as the `app-key-cell`
  widget.
- `page.tsx` — viewspec branch added FIRST in the component body; native
  branch unchanged apart from rendering the shared key cell.

## WIDGET_REGISTRY entries needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

```tsx
import { Library } from 'lucide-react'
import { Button } from '@openbooks/ui'
import Link from 'next/link'
import { AppsToolbar, AppDrawer } from '../../app/(app)/admin/apps/AppDrawer'
import { AppKeyCell } from '../../app/(app)/admin/apps/sections'

/* --- admin apps ------------------------------------------------------------ */
// Not `link-button` (solid, no icon) and not `docs-link-button` (BookOpen
// icon): the native header action is an outline small button with a 15px
// Library icon and a space before the label. Diffed, kept separate.
'apps-library-button': (props) => {
  const href = str(props, 'href')
  if (!href) return null
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={href as never}>
        <Library size={15} /> {str(props, 'label') ?? ''}
      </Link>
    </Button>
  )
},
'apps-toolbar': () => <AppsToolbar />,
'app-key-cell': (props) => (
  <AppKeyCell appKey={str(props, 'appKey') ?? ''} />
),
// The whole app flyout (overview form, file browser + editor, runs log) stays
// one widget: its body is three tabs of per-row client state (dirty flags,
// selected file, open dirs), which is a workspace, not a spec. The loader
// hands over the server inputs (app row, files, runs, isPublished) as data.
// Null drawer (drawer closed, or ?app= for an unknown key) renders nothing —
// the spec gates on `drawerOpen`, and the widget receiving null is belt and
// braces for direct registry use.
'app-drawer': (props) => {
  const drawer = props.drawer as ComponentProps<typeof AppDrawer> | null
  if (!drawer) return null
  return <AppDrawer {...drawer} />
},
```

Needed imports for the registry file (adjust to local style): `Library` from
`lucide-react` (check it is not already imported), `AppKeyCell`,
`AppsToolbar`, `AppDrawer` as above. `Button`, `Link`, `ComponentProps` and
`str` already exist in that file.

`'search-input'` and `'filter-chips'` already exist and need no change: the
native page uses both components with exactly the registry's contract
(`placeholder`; `basePath`/`currentParams`/`paramKey`/`label`/`options` —
no `allLabel`, `defaultValue` or `pageParamKey` on this page).

## What the coordinator must NOT create

No new slot is needed. This page needs no org id, user id, Authz or bound
action in the spec: the spec binds only the already-loaded rows, drawer data
and label strings. `AppsToolbar` and `AppDrawer` own their mutations through
fetch calls to `/api/apps/*`, exactly as on the native path — no spec prop
carries a capability.

## Proposed conformance entry (coordinator: add to `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/admin/apps',
  // Admin apps list: search + status chips, app-variant table with an
  // in-table empty row, bare pager, and the app flyout over an app key.
  // GATES: requires `apps.manage` (the harness admin has it) and the
  // `apps` feature (default-on; the sim org sets no override), so the
  // page renders 200 in the harness tenant once the fixture below lands.
  variants: [
    '',
    '?status=disabled',
    // Two fixture apps are installed (one with no active version, so the
    // version cell renders the "—" fallback), one is disabled — the chips
    // render both statuses with real counts and only the disabled row
    // matches this variant, so it CANNOT coincide with the default.
    {
      query: '?app=viewspec-demo',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 2,
},
```

Verified against the database (`openbooks_sim_viewspec`, harness user
`viewspec@sim.test`, org `da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, role
`admin`):

- `apps` rows for the sim org today: **0**, so the default variant currently
  renders only the in-table empty row (`table tbody tr` matches 1). The
  fixture below adds 3 rows (all on page one — per-page is 50), so
  `minMatches: 2` is conservative once fixtures land. THE FIXTURE IS
  PROPOSED ONLY (this page owns no other file); `minMatches` is verified
  against the fixture row counts, not against today's empty tenant —
  re-verify after the coordinator lands the fixture.
- `status=disabled` matches only the `viewspec-archived` row (1 row):
  genuinely different from the default (3 rows).
- The `?app=viewspec-demo` drawer variant is portaled to `<body>`, hence the
  two scopes. The drawer title is the app name rendered by `UrlDrawer`; the
  `[data-drawer-layer]` selector matches its portal root. `isAppPublished`
  is false for this key (no `app_listings` row), exercising the unpublished
  branch; runs exist (one `ok`, one `error`), exercising both run badges.

## Fixture SQL (coordinator folds into `scripts/viewspec-fixtures.sql`)

Idempotent: fixed ids, `ON CONFLICT DO NOTHING`, SIM org only (same `v_org`
pattern as the existing blocks). Claims the fresh id block `…1101-1199`
(the allocation table's last claimed block is `…a000-…`; the entire
`…1101-…1299` range is unused — verified: zero occurrences of
`0000000011` or `0000000012` in the fixtures file):

```sql
  -- ---- admin apps ------------------------------------------------------------
  -- The simulator never installs apps, so the list page would compare two
  -- identical empty states. Three apps in the SIM org: two installed (one
  -- with an active version carrying two endpoints, one with NO active
  -- version so the version cell renders the "—" fallback) and one disabled,
  -- so the status chips carry real counts and ?status=disabled selects.
  insert into apps (id, org_id, key, name, description, status, granted_permissions)
  values
    ('00000000-0000-7000-9000-000000001101', v_org, 'viewspec-demo', 'ViewSpec demo app',
     'Harness app with an active version', 'installed', '["records.read"]'),
    ('00000000-0000-7000-9000-000000001102', v_org, 'viewspec-noversion', 'ViewSpec versionless app',
     'Harness app with no active version', 'installed', '[]'),
    ('00000000-0000-7000-9000-000000001103', v_org, 'viewspec-archived', 'ViewSpec archived app',
     'Harness disabled app', 'disabled', '[]')
  on conflict (id) do nothing;

  insert into app_versions (id, org_id, app_id, version, manifest, status)
  values
    ('00000000-0000-7000-9000-000000001111', v_org,
     '00000000-0000-7000-9000-000000001101', '1.2.0',
     '{"endpoints": [{"name": "hello", "file": "backend/hello.js", "method": "GET"}, {"name": "submit", "file": "backend/submit.js", "method": "POST"}]}',
     'active')
  on conflict (id) do nothing;

  -- versions reference their app both ways: link the active version id back.
  -- Deferred FKs (both directions are DEFERRABLE) allow the two inserts in
  -- either order; this update lands after both exist.
  update apps set active_version_id = '00000000-0000-7000-9000-000000001111'
   where id = '00000000-0000-7000-9000-000000001101'
     and active_version_id is null;

  insert into app_files (id, org_id, app_id, version_id, path, kind, content_type, content, is_binary, size)
  values
    ('00000000-0000-7000-9000-000000001121', v_org,
     '00000000-0000-7000-9000-000000001101', '00000000-0000-7000-9000-000000001111',
     'frontend/index.html', 'frontend', 'text/html', '<h1>demo</h1>', false, 15),
    ('00000000-0000-7000-9000-000000001122', v_org,
     '00000000-0000-7000-9000-000000001101', '00000000-0000-7000-9000-000000001111',
     'backend/hello.js', 'backend', 'text/javascript', 'export default async () => ({ ok: true })', false, 44)
  on conflict (id) do nothing;

  insert into app_runs (id, org_id, app_id, version_id, endpoint, status, units, logs, error_message, duration_ms, at)
  values
    ('00000000-0000-7000-9000-000000001131', v_org,
     '00000000-0000-7000-9000-000000001101', '00000000-0000-7000-9000-000000001111',
     'hello', 'ok', 1, '["started"]', null, 12, now() - interval '1 day'),
    ('00000000-0000-7000-9000-000000001132', v_org,
     '00000000-0000-7000-9000-000000001101', '00000000-0000-7000-9000-000000001111',
     'submit', 'error', 2, '["started"]', 'boom', 30, now() - interval '2 hours')
  on conflict (id) do nothing;
```

- `app_runs.version_id` is nullable, so pointing the runs at the active
  version is convenient, not required.
- No `app_listings` row: `isAppPublished('viewspec-demo')` is false, pinning
  the unpublished branch. No fixture exercises the published-badge branch —
  it needs a deployment-wide listing row, and the file/class contract says
  fixtures only ever seed the SIM org.

## Could not express

Nothing structural. Two judgment calls, both following the stated machinery
rules:

1. The name column sorts — but only `name` is sortable and it is already the
   fixed order (`ORDER BY a.name`, no direction toggle), so the spec places a
   plain header, not a `sorting` table: a sort control with one inert option
   would be chrome the native page does not have.
2. The `endpointCount`/`runCount` cells are `text` with `tabular-nums` on the
   column (the renderer attaches `tabular-nums` to `money`/`number` columns
   automatically; these are counts rendered as loader strings, and the native
   cells carry only `tabular-nums`, so the column `className` reproduces it
   exactly). A widget cell gets no `tabular-nums` automatically — which is
   why the key cell is a widget (it must NOT have it) sharing one
   implementation with the native path.
