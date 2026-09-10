# /data/import ViewSpec integration handoff

Page: `web/app/(app)/data/import/` — owner files are `view.ts` (+ this
file) and the `__viewspec` branch + imports in `page.tsx`.
`ImportWizard.tsx` is untouched. No `sections.tsx`: the wizard already
lives in its own module, and both render paths share that one
implementation — there is no local component to move and no composite
cell to extract (the wizard's internal `StatTile`/`ErrorTable` stay
inside the wizard module).

Spec blocks used: `page` (`layout: 'bare'`) + one `widget`
(`import-wizard`, no props). This is the `pay-run-wizard` doctrine: the
wizard owns four freely-navigable steps, a file input, pasted-text
state, per-column mapping selects, and the parse / preview / commit /
sample-company fetch flows — all `useState` plus `fetch`, which the
spec has no vocabulary for — so it stays one shared client component
and the spec places it whole. `bare` because the wizard owns its own
`WizardLayout` shell; wrapping it in a second `ListPageLayout` would
nest the chrome and the DOM would no longer match byte for byte.

The loader reproduces the native server logic VERBATIM: `await
requirePermission('data.import')`, then nothing — the page renders no
server rows. The resource list and sample-company profiles both load
client-side inside the wizard, identically on both paths.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (already exists as a component):

```tsx
import { ImportWizard } from '../../app/(app)/data/import/ImportWizard'
```

Entry (exact prop shape: **no props** — the widget takes `{}` and the
shared `ImportWizard` takes no props; wire verbatim):

```tsx
/* --- data import ------------------------------------------------------------ */
/**
 * The four-step import wizard (source / mapping / preview / result). Every
 * control is client state plus a fetch flow a spec cannot name, so the
 * entry binds nothing: it renders the shared `ImportWizard` both branches
 * use. Same call the pay-run conversion made for `RunWizard`.
 */
'import-wizard': () => <ImportWizard />,
```

## 2. Conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/data/import',
  // A permission gate around one fully client-stateful wizard: no
  // server-rendered rows, so no query variants. The source step always
  // paints the paste box on first paint, before any fetch resolves.
  variants: [''],
  expect: 'main textarea',
  minMatches: 1,
},
```

No fixture block claimed — deliberately. The native page performs zero
DB queries (verified: `page.tsx` is `requirePermission` + `<ImportWizard
/>`; the wizard's data arrives through `/api/data/*` client fetches),
so there is no row count for fixtures to guarantee and nothing in
`scripts/viewspec-fixtures.sql` to collide with. Verified against the
live DB that the harness user can reach the page at all:
`viewspec@sim.test` exists in the sim tenant
(`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`) with `is_super_admin = t`, so
the `data.import` gate passes on both paths. The `expect` selector is
verified in source, not in rows: the `<textarea>` at
`ImportWizard.tsx:384` renders synchronously in the source step with no
fetch dependency.

## 3. Anything not expressed, and why

Nothing blocked. No new vocabulary needed: `layout: 'bare'` already
exists (platform hub, setup pages) and `widgetBlock` with `{}` props
already validates (`resolveWidgetProps` returns `{}` for empty props).
All `data.*` message keys stay inside the client component — the spec
introduces no `t('...')` of its own, so no key-existence risk.

One deliberate non-change: `page.tsx` previously took no `searchParams`
prop. The branch needs it to read `__viewspec`, so the component now
accepts the standard optional `searchParams` (same shape as the
import-history page) and the native branch is otherwise untouched.
