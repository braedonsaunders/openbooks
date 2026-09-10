# INTEGRATION — `/admin/setup/[entity]` ViewSpec conversion

Page: `web/app/(app)/admin/setup/[entity]/page.tsx`.
Status: **converted, pending registry.** `view.ts`, `sections.tsx`, and the
`__viewspec` branch in `page.tsx` are written; the spec references the widget
names proposed below, which do not exist in `WIDGET_REGISTRY` yet. Until the
coordinator registers them, the `?__viewspec=1` path throws
`UnknownWidgetError` at render — the native branch is untouched and ships
(the description paragraph is shared back via `sections.tsx`: one
implementation).

No `packages/viewspec` language change is needed. Everything below is a
registry entry (whole-component passthrough, same pattern as
`account-drawer` / `party-drawer` / `related-txn-drawer`), plus
`sections.tsx` composites that already exist in this directory
(`SetupDescription` shared back into the native branch; `SetupCodeCell`,
`SetupBadgeLinkCell`, and the four slots consumed only through the registry).

## 1. Proposed `WIDGET_REGISTRY` entries (coordinator: `web/components/viewspec/widgets.tsx`)

```tsx
import { NewSetupButton, SetupDrawer } from '../../app/(app)/admin/setup/[entity]/SetupDrawer'
import { TaxReturnLibrary } from '../../app/(app)/admin/setup/[entity]/TaxReturnLibrary'
import {
  SetupBadgeLinkCell,
  SetupCloseSlot,
  SetupCodeCell,
  SetupCompanySlot,
  SetupDescription,
  SetupDrawerSlot,
  SetupFxSlot,
} from '../../app/(app)/admin/setup/[entity]/sections'

// Header description paragraph. The inline "Learn more" link (with its
// significant leading space) appears only when the entity declares a doc
// slug — a conditional pair inside one `<p>`, so a component. The native
// branch imports this back (single implementation); only the entry is new.
// `docHref` arrives as a loader-resolved field ref and is null without a slug.
'setup-description': (props) => (
  <SetupDescription
    description={str(props, 'description') ?? ''}
    docHref={(props.docHref as string | null) ?? null}
    learnMore={str(props, 'learnMore') ?? ''}
  />
),

// Header "New" button. Client component (router.push to `?row=new`, NOT a
// link — `link-button` cannot do this). `entityKey` + translated `label`
// arrive as loader-resolved props.
'new-setup-button': (props) => (
  <NewSetupButton entityKey={str(props, 'entityKey') ?? ''} label={str(props, 'label') ?? ''} />
),

// Tax-return-form library button + install drawer. Whole-component
// passthrough; all props are loader-resolved data (packs, installed codes,
// open flag, open/close hrefs).
'tax-return-library': (props) => (
  <TaxReturnLibrary
    packs={(props.packs as ComponentProps<typeof TaxReturnLibrary>['packs']) ?? []}
    installedCodes={(props.installedCodes as string[]) ?? []}
    open={props.open === true}
    openHref={str(props, 'openHref') ?? ''}
    closeHref={str(props, 'closeHref') ?? ''}
  />
),

// `code`-kind cells. The value rides in `<span className="font-mono
// text-xs">`; an empty value renders the loader-resolved dash text with NO
// wrapper (native renders a bare '—', so the `text` fallback span would be
// wrong markup). First-column variant wraps the span in the row-drawer link.
'setup-code-cell': (props) => (
  <SetupCodeCell
    text={str(props, 'text') ?? ''}
    shown={props.shown === true}
    href={str(props, 'href')}
  />
),

// Badge-kind first-column cells. Only one registry column needs this
// (`information-return-box-rules.formType`): a Badge inside the row link,
// which a `link` cell cannot render (text only, never a Badge).
'setup-badge-link-cell': (props) => (
  <SetupBadgeLinkCell
    label={str(props, 'label') ?? ''}
    variant={
      (str(props, 'variant') ?? 'default') as ComponentProps<typeof SetupBadgeLinkCell>['variant']
    }
    href={str(props, 'href') ?? ''}
  />
),

// The create/edit drawer with its nested sub-tabs (tax rates, return boxes,
// segment values incl. the built-in-dimension notice) and stacked child
// drawers. Slot re-derives authz server-side; the spec carries only the
// entity key and the current URL — no org id, no row payload, no JSX.
// The drawer renders nothing without `?row=` (the slot returns null), so no
// `when` flag is needed beyond `drawerOpen` belt-and-braces.
'setup-drawer': (props) => (
  <SetupDrawerSlot
    entityKey={str(props, 'entityKey') ?? ''}
    sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
  />
),

// The three bespoke entity pages. Same slot arrangement: the spec places one
// widget block per key behind its loader-computed presence flag, each slot
// re-derives authz (and the fx feature gate) from the session. `canReopen`
// is a loader-resolved boolean, not a capability.
'setup-company': () => <SetupCompanySlot />,
'setup-close': (props) => (
  <SetupCloseSlot
    sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
    canReopen={props.canReopen === true}
  />
),
'setup-fx': () => <SetupFxSlot />,
```

Slot remount keys: none needed. The native drawers carry no `key` prop
(the party/account drawers do; `SetupDrawer` does not), so the registry must
NOT invent one.

## 2. Spec notes (`view.ts` as written)

- Layout `bare`: the setup workspace renders its own shell around every
  entity page. The spec owns its outer `<div className="space-y-4">` as a
  `grid` in body; `header` is empty.
- One spec serves all 49 registry entities. The loader resolves each column
  to `{key, kind, header}` and every cell to `{display, href, badgeVariant,
  codeShown}`; the spec builder maps descriptors to `Column` specs. The
  mapping is spec construction over loader data, not a spec-level
  conditional — the emitted PageSpec is pure data.
- Cell mapping mirrors the native `renderCell` exactly, including the
  `col.options` short-circuit applying to every kind EXCEPT `badge`
  (`option && col.kind !== 'badge'`), `badge-active` ignoring options, and
  `badge` variant `secondary` only for `builtin`. First-column cells always
  ride inside the row link, including badge/code kinds (via the two
  sections.tsx cells above).
- Header composition: `grid('flex items-start justify-between gap-3')` →
  `grid('min-w-0')` → `heading(2, …, 'text-lg font-semibold …')` +
  `setup-description` widget; actions `grid('flex items-center gap-2')` →
  `tax-return-library` (gated by `showLibrary`) + `new-setup-button`.
- Filter row: `grid('flex flex-wrap items-center gap-2')` → `search-input`
  + `show-inactives-toggle` (gated by `hasActiveToggle`, `basePath`
  `/admin/setup/<key>`).
- Table card: `grid('rounded-xl border …')` wrapping the `app`-variant table
  (the native page wraps `Table` in that div; the block renders no wrapper).
  `emptyRow` with `colSpan: data.columns.length`, class `MUTED`.
- Pagination: `bare: true` — the native pager sits directly in the `space-y-4`
  flow with no `mt-3` wrapper.
- Special keys: `isCompany` / `isPeriodClose` / `isFxProvider` /
  `isRegistryList` are four mutually exclusive loader flags (accounts
  precedent). Redirects (`tax-regimes` et al → depreciation tabs),
  `notFound()` (nested/rehomed/feature-gated), `periods.manage` and the
  `multiCurrency` gate all stay in the loader verbatim — the slots re-check
  `admin.setup.manage` host-side like every other widget.
- Permissions/visibility: `requirePermission('admin.setup.manage')` gates the
  loader; the list query, search, and show-inactive filter are copied
  verbatim, so counts describe exactly what is shown.

Message keys: all resolved in the loader via the same key strings the native
page uses (`entities.<key>.title/description`, `fields.<column>`,
`segmentValues.*`, `taxBoxes.*`, `taxRates.*`, `entities.tax-rates.title`,
`entities.tax-report-lines.title`, `entities.segment-values.title`, `new`,
`learnMore`, `empty`, `searchPlaceholder`, `statusActive`, `statusArchived`,
`yes`). No invented keys. Three caveats, all pre-existing native behaviour
kept verbatim: `number-sequences.allocatedThrough`,
`item-rate-book-assignments.dateBasis`, and
`information-return-box-rules.accountId` have no `fields.*` entry, so `t()`
falls back the same way it does natively (verified absent from
`web/messages/en/admin.json`; the native page renders the same fallback).

## 3. Proposed conformance registry entry (coordinator: `scripts/viewspec-conformance.mjs`)

DB state verified read-only against `openbooks_sim_viewspec` on
127.0.0.1:55439 (`app.bypass_rls='on'`), harness org `da472d3a-…`
(`viewspec@sim.test`). Usable branches in this org: `segment-definitions`
(5 builtin rows — exercises `text`, `code`, `badge`, `boolean`,
`badge-active` columns + show-inactives toggle), `currencies` (40 shared rows
— `code` first column, `number` column, no toggle), `number-sequences` (4
rows), `compliance-classes` (1 active row:
`01a088a8-7cf0-784f-92f7-10e196e31174`).

```js
{
  path: '/admin/setup/segment-definitions',
  // Widest column-kind coverage available in the sim org (text, code, badge,
  // boolean, badge-active) plus the show-inactives toggle. No-match search
  // asserts the in-table empty row.
  variants: [
    '',
    '?showInactive=true',
    { query: '?q=zzzznomatch', expect: 'table thead th', minMatches: 5 },
  ],
  expect: 'table tbody tr',
  minMatches: 5,
},
{
  path: '/admin/setup/currencies',
  // Shared (non-org-scoped) reference table keyed by text code: exercises the
  // code-first-column link cells and the number column, with no toggle.
  variants: [''],
  expect: 'table tbody tr',
  minMatches: 20,
},
{
  path: '/admin/setup/segment-definitions',
  // Builtin-dimension drawer: the native page renders the deep-link notice
  // (no editable list) inside the drawer, which portals to <body>.
  variants: [
    {
      query: '?row=<segment-definitions-id>&setupTab=segment-values',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 5,
},
```

Drawer/branch variants deliberately omitted until the harness org has fixture
rows: `tax-codes`, `tax-return-forms`, and `tax-report-lines` are all EMPTY
in the sim org (verified: 0 rows each), so no `?row=` id exists for the
drawer, the tax-rates/tax-boxes sub-tabs, or the library button. If the
coordinator seeds fixtures (fixed ids, as `scripts/viewspec-fixtures.sql`
does for other pages), add: `tax-codes?row=<id>`,
`tax-codes?row=<id>&setupTab=tax-rates`,
`tax-return-forms?row=<id>&setupTab=tax-return-boxes`, and
`tax-return-forms?library=true` — each with `scopes: ['main',
'[data-drawer-layer]']`. `subsidiaries` (1 row) and `information-return-box-rules`
(the only badge-kind first column) are also unusable without fixtures.

## 4. Could not express (and why)

Nothing structural — every gap closed with the slots above. Two residual
notes: (1) the main-list `SetupDrawer` renders through `SetupDrawerSlot`
rather than as `table`+`pagination` blocks, so drawer-sub-tab searches/pagers
are covered only via the portaled-drawer scopes, not as spec blocks; (2) the
`information-return-box-rules` badge-link first column is verified by code
survey only (registry declares it; the sim org has no `subcontractorCompliance`
fixture rows to render it — the entity IS feature-gated on in this org, so a
fixture row would also exercise the gate).
