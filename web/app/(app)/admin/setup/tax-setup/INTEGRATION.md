# INTEGRATION — `/admin/setup/tax-setup` ViewSpec conversion

Page: `web/app/(app)/admin/setup/tax-setup/page.tsx`.
Loader/spec: `./view.ts` (`loadTaxSetup`, `taxSetupSpec`)
Shared chrome: `./sections.tsx` (`TaxSetupHeader`, `TaxSetupGuideSlot`,
`StepLink`, `TaxSetupGuideProps`)
Client body: `./TaxSetupGuide.tsx` (`TaxSetupGuide`, now taking required
`step2`/`step3` slot nodes; `StepLink` moved to `./sections.tsx` verbatim)

This page is the tax-depreciation precedent applied to a page with no tabs:
a server loader plus ONE interactive client component through
whole-component slots. The guide owns search filtering, checkbox/select
state, expand/collapse, and the provision fetch flow (all useState a spec
cannot name), so the spec places two blocks — the shared header and the
guide slot — and nothing else. There are no presence flags: the whole page
always renders (the only gate is `requirePermission('admin.setup.manage')`,
which throws instead of branching).

The loader copies the native page VERBATIM: the `admin.setup.manage` gate,
the four parallel queries, and the `JURISDICTION:` prefixing that merges the
two installed-code sources (`tax_return_forms.code` + state-level
`tax_jurisdictions.code`) into one `installedCodes` array.

## Widget registry entries to add (coordinator)

Two new widgets. Both render existing components verbatim — no new markup
invented here.

```tsx
import {
  TaxSetupGuideSlot,
  TaxSetupHeader,
} from '../../app/(app)/admin/setup/tax-setup/sections'

// Page header. The native page owns a plain `<header>` (h1 + subtitle),
// not the PageHeader component, so the whole header is one shared component
// over loader-resolved strings. The native branch imports it back (single
// implementation).
'tax-setup-header': (props) => (
  <TaxSetupHeader
    title={str(props, 'title') ?? ''}
    subtitle={str(props, 'subtitle') ?? ''}
  />
),
// Guide body. Whole-component passthrough over ONE object prop: `guide` is
// exactly `Parameters<typeof TaxSetupGuideSlot>[0]['guide']`
// (`TaxSetupGuideProps`: `{ countries, installedCodes, step2Title,
// step2Description, step2Stat, step2Href, step2Cta, step3Title,
// step3Description, step3Stat, step3Href, step3Cta }`).
// `countries` is the raw `SupportedCountry[]` from
// `supportedTaxCountries()` — display names stay client-side
// (`countryOptions(locale)` inside the component: browser-locale
// formatting), the search filter runs client-side (per-keystroke useState,
// not a `?q=` param), and the step-2/step-3 links render from the
// loader-formatted strings via the moved `StepLink` (single
// implementation, also imported back by the native branch). No Authz, no org
// id, no actions.
'tax-setup-guide': (props) => (
  <TaxSetupGuideSlot
    guide={props.guide as ComponentProps<typeof TaxSetupGuideSlot>['guide']}
  />
),
```

EXACT prop shapes (the coordinator wires them verbatim):

- `tax-setup-header`: `{ title: string, subtitle: string }` — flat string
  props, no `when`.
- `tax-setup-guide`: `{ guide: TaxSetupGuideProps }` — ONE object prop, no
  `when`. `TaxSetupGuideProps` fields:
  - `countries: SupportedCountry[]` — each `{ country: string, name: string,
    countryPack: string | null, countryStatus: 'ready' | 'subdivisions' |
    'in_development', subs: { packCode: string, region: string, name: string,
    coverage: 'detailed_pack' | 'country_tax_setup' | 'jurisdiction_setup'
    }[] }`.
  - `installedCodes: string[]` — return-form codes plus `JURISDICTION:<code>`
    entries for state-level jurisdictions.
  - `jurisdictionCount: number`, `registrationCount: number` — raw counts
    (kept for parity with the native prop surface; the rendered stats are
    the preformatted strings below).
  - `step2Title, step2Description, step2Stat, step2Href, step2Cta: string`
    (step 2 = jurisdictions; `step2Href` is always
    `'/admin/setup/tax-jurisdictions'`).
  - `step3Title, step3Description, step3Stat, step3Href, step3Cta: string`
    (step 3 = nexus; `step3Href` is always
    `'/admin/setup/tax-registrations'`).

Slot remount keys: none needed. Neither `TaxSetupGuide` nor the header
carries a `key` prop natively, so the registry must NOT invent one.

## Spec notes (`view.ts` as written)

- Layout `bare`: the setup workspace renders its own shell around every
  entity page. The spec owns the native outer
  `<div className="mx-auto max-w-5xl space-y-6 p-1">` as a `grid` in body;
  `header` is empty — the payroll/[entity] precedent.
- No presence flags: the guide always renders and both step links live
  INSIDE the guide component (via the `step2`/`step3` slot nodes built from
  the loader-formatted strings). A spec `when` that is always true would be
  a lie about the page's branching, so there is none.
- The header is NOT `page-header`: the native h1 carries
  `text-xl font-semibold …`, not the PageHeader component, so it lives in
  the shared `TaxSetupHeader` chrome.
- Message keys: all resolved in the loader via the same key strings the
  native page uses (`title`, `subtitle`, `step2.title`,
  `step2.description`, `step2.stat`, `step2.cta`, `step3.*`). No invented
  keys. All other copy (`step1.*`, `searchPlaceholder`, `provisionHint`,
  `provisioning`, `provisionSelected`, `provisionSuccess`, `installed`, …)
  renders inside the client component, which reads the catalog itself.
- Money/dates: the loader formats nothing except the two step-stat strings
  (ICU plurals, exactly as the native page evaluates them). Country display
  names, the search filter, pack-status labels, and the provision toast all
  stay client-side (browser locale + useState — the client-format trap, so
  the loader passes raw records/counts).
- `sp` is unused (the page takes no search params); the loader takes and
  voids it to keep the `load<Name>(sp)` signature.

## Proposed fixture block (coordinator: `scripts/viewspec-fixtures.sql`)

DB state verified read-only against `openbooks_sim_viewspec` on
127.0.0.1:55439 (`app.bypass_rls='on'`), harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a` (`viewspec@sim.test`): **2 active
return forms** (`CA_GST34`, `US_941` — the `…6801/…6802` fixtures), **0
tax_jurisdictions, 0 tax_registrations**. So today the guide renders with
`jurisdictionCount = 0`, `registrationCount = 0`, `installedCodes =
['CA_GST34', 'US_941']` (matching the CA country pack code and hence marking
Canada's card installed), and both step stats in their zero-plural form.

The page needs a per-org branch the empty tenant cannot show: a
state-level jurisdiction (exercises the `JURISDICTION:` installed-code path
and the nonzero step-2 stat) plus a nexus registration (nonzero step-3
stat). Claimed block `…0014–…0017`: grep over the whole fixture file shows
no `000000000014`, `…0015`, `…0016`, or `…0017` anywhere (neighboring blocks
`…0011` payroll / `…0021` AP-capture are clear of this range), so no
ON CONFLICT silent skip.

```sql
  -- Tax-setup guide: one state-level jurisdiction + one nexus registration
  -- for the /admin/setup/tax-setup conversion. Exercises the JURISDICTION:
  -- installed-code path (California's card renders installed) and the
  -- nonzero step-2 / step-3 stats. Id …0014–…0017 are unclaimed (verified by
  -- grep over the whole file).
  insert into tax_jurisdictions
    (id, org_id, code, name, country, region, level, tax_type, is_active)
  values
    ('00000000-0000-7000-9000-000000000014', v_org, 'US-CA', 'California',
     'US', 'CA', 'state', 'sales_use', true)
  on conflict (id) do nothing;

  insert into tax_registrations
    (id, org_id, jurisdiction_id, registration_number, filing_frequency,
     return_form_code, is_active)
  values
    ('00000000-0000-7000-9000-000000000015', v_org,
     '00000000-0000-7000-9000-000000000014', 'CA-SELLERS-PERMIT-VIEWSPEC',
     'quarterly', 'US_CA_CDTFA401', true)
  on conflict (id) do nothing;
```

Column check against `schema/src/tax.ts`: `tax_jurisdictions` needs
`code, name, country, region, level ('state'), tax_type ('sales_use')`;
`tax_registrations` needs `jurisdiction_id, filing_frequency
('quarterly')`; both ride `auditColumns` defaults. The registration points
at California's real detailed return pack (`US_CA_CDTFA401`), not an
invented code. Note the `…6801/…6802` return-form fixtures carry
is_active=true, so with the block applied the guide sees installedCodes
`['CA_GST34', 'US_941', 'JURISDICTION:US-CA']`.

(Only two of the four claimed ids are used; `…0016/…0017` stay reserved for
this page's future variants. Unused ids in a claimed block cost nothing and
keep the next claim adjacent.)

## Proposed conformance registry entry (coordinator: `scripts/viewspec-conformance.mjs`)

Guide-shape facts verified against source (no live renderer available in
this worktree — no `node_modules` — so the counts below are static,
code-derived, and each derivation is shown):

- 16 country cards: `COUNTRY_TAX_PACKS` holds exactly 16 packs (counted in
  `engine/src/country-tax-packs/index.ts`), one per country (AE, AU, CA,
  DE, ES, FR, GB, IE, IN, IT, JP, NL, NZ, SG, US, ZA — every `country:`
  literal in the pack dir falls inside that set, verified by script), and
  `supportedTaxCountries()` emits one entry per pack plus one per
  non-pack `TAX_RETURN_PACKS` jurisdiction. No `TAX_RETURN_PACKS` entry can
  add a 17th country: `TAX_RETURN_PACKS` is `COUNTRY_TAX_PACKS.flatMap(pack
  => pack.returnPacks)`, so every return pack's `jurisdiction.country` is
  one of the 16 (verified: no foreign-country ref anywhere in the pack
  dir). 16 cards → 16 `<li>` in the country grid.
- US card: 51 subs (`state("AL"…) … state("WY"…)`, 51 `state("XX",`
  calls in `us.ts`) — but collapsed by default, so they contribute no
  visible `<li>` until expanded.
- CA card: 10 subs (5 explicit + 5 `hst(…)` entries: NB, NL, NS, ON, PE).
  Collapsed by default.
- Static `<li>` census per render: 16 country cards + 1 no-results `<li>`
  only when filtered to zero (absent by default) + sub `<li>`s only when a
  card is expanded (none by default). Steps 2 and 3 are `<div>` cards, not
  list items. So the default render holds exactly **16 `main li`**.
- Step-2/step-3 links: `main a[href="/admin/setup/tax-jurisdictions"]` and
  `main a[href="/admin/setup/tax-registrations"]`, 1 each.
- Provision button: `main button` matches the provision CTA plus every
  country/expander toggle — not a stable count, so not used.

```js
{
  path: '/admin/setup/tax-setup',
  // Guided workspace: header + 16 country cards + 2 step-link cards.
  // No query params exist on this page; the search filter is client-side
  // useState, so a single default variant covers the render. After the
  // …0014/…0015 fixture block: step-2 stat reads "1 jurisdiction", step-3
  // "1 registration", and the California sub-row renders installed.
  variants: [
    '',
  ],
  expect: 'main li',
  minMatches: 16,
},
```

## Anything not expressed (and why)

- The whole guide body (search, select/expand state, provision POST +
  toasts, per-card installed/selected badges, sub-rows, empty no-results
  row): a client component behind the `tax-setup-guide` slot, exactly as
  the tax-depreciation overview is. ViewSpec has no interactive-widget
  vocabulary for checkbox state, keystroke filtering, or fetch flows, and
  the brief's rule ("a cell that is more than one element is a component")
  keeps the 60-line card markup where it is.
- Step 2/3 link rows: they render inside the guide from loader-resolved
  strings via the single `StepLink` implementation — not as spec `link`
  blocks — because their position (after the step-1 card, inside the
  guide's `space-y-5` root) is owned by the client component's DOM.
- No new ViewSpec vocabulary needed. No shared-file edits made here; the
  two `WIDGET_REGISTRY` entries and the conformance entry above are for the
  coordinator.
```
