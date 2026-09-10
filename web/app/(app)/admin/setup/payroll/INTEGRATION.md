# INTEGRATION — `/admin/setup/payroll` ViewSpec conversion

Page: `web/app/(app)/admin/setup/payroll/page.tsx`
Loader/spec: `./view.ts` (`loadPayrollSetup`, `payrollSetupSpec`)
Shared chrome: `./sections.tsx` (tab slots + `PayrollSetupTabs`,
`PayrollSetupHeader`, `PayrollSetupBanner`, `launcherDataFor`)

This page is the setup workspace's odd sibling: it owns its own two-level
tab strip (house border-b group strip on top, ModuleHomeTabs pill row
beneath) and sixteen mutually exclusive bodies behind one `?tab=` param. The
spec places all sixteen behind presence flags (`onPacks`, `onAccounts`,
`onEntityTab`, …); exactly one survives per render — the accounts-page
precedent (`onList`/`onSearch`/`onHierarchy`) at its widest so far.

Deep links keep working because the loader reproduces the native resolution
VERBATIM: unregistered entity tabs drop out of `available` (never links at a
404), two-letter country codes alias to `accounts`, and anything unknown
falls back to `packs`. Label fallbacks (`Derived Earnings`, `Rule Preview`,
`Holidays`, `Holiday Calendar`, `Payday`, `Statutory Rates`) use `t.has`
exactly as the native page does — if the catalog ever gains `tabs.derived`
etc., both paths pick them up together.

## Widget registry entries to add (coordinator)

Five new widgets. All render existing components verbatim — no new markup
invented here. `setup-section` (already registered) covers the seven
registry-entity tabs; the spec names the entity by KEY only and the slot
re-derives org id, entry and manage gate from the session.

```tsx
import {
  PayrollSetupHeader,
  PayrollSetupBanner,
  PayrollSetupTabs,
  PacksTabSlot,
  AccountsTabSlot,
  PaydayTabSlot,
  RatesTabSlot,
  WorkSchedulesTabSlot,
  DerivedPreviewTabSlot,
  HolidaysTabSlot,
  HolidayCalendarTabSlot,
} from '../../app/(app)/admin/setup/payroll/sections'

// Page header: the native page owns an `<header>` (h1 + description +
// launcher button) that no PageHeader block can express, so the whole row is
// one shared component over loader-resolved strings plus the launcher
// payload. Both paths share the h1, the description, and the button chrome.
'payroll-setup-header': (props) => (
  <PayrollSetupHeader
    title={str(props, 'title') ?? ''}
    description={str(props, 'description') ?? ''}
    launcher={props.launcher as ComponentProps<typeof PayrollSetupHeader>['launcher']}
  />
),
// Launcher banner below the header. Presence (`missing > 0`) lives in the
// shared component — the same rule the empty state follows.
'payroll-setup-banner': (props) => (
  <PayrollSetupBanner launcher={props.launcher as ComponentProps<typeof PayrollSetupBanner>['launcher']} />
),
// Group strip + subtab pills. The active-vs-plain link PAIR (and aria-current
// set-vs-omitted) is a component, not a spec construct — every `active`
// boolean and label is loader-resolved data.
'payroll-setup-tabs': (props) => (
  <PayrollSetupTabs
    groups={(props.groups as ComponentProps<typeof PayrollSetupTabs>['groups']) ?? []}
    activeGroup={str(props, 'activeGroup') ?? ''}
    tabsAria={str(props, 'tabsAria') ?? ''}
    subTabs={(props.subTabs as ComponentProps<typeof PayrollSetupTabs>['subTabs']) ?? []}
  />
),
'payroll-packs-tab': () => <PacksTabSlot />,
'payroll-accounts-tab': () => <AccountsTabSlot />,
'payroll-payday-tab': () => <PaydayTabSlot />,
'payroll-rates-tab': () => <RatesTabSlot />,
'payroll-schedules-tab': () => <WorkSchedulesTabSlot />,
// Statutory holidays: the employer's elections, then the resolved calendar
// those elections produce. Same edit-then-confirm pairing as derived rules.
'payroll-holidays-tab': (props) => (
  <HolidaysTabSlot
    sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
    basePath={str(props, 'basePath') ?? '/admin/setup/payroll'}
  />
),
'payroll-holiday-calendar-tab': (props) => (
  <HolidayCalendarTabSlot sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}} />
),
```

Plus the two derived-rules bodies, whose entity keys are not (yet) spread
into `SETUP_ENTITIES` — same slot shape, keys resolved by the loader:

```tsx
import {
  DerivedPreviewTabSlot,
  DerivedTabSlot,
  EntityTabSlot,
} from '../../app/(app)/admin/setup/payroll/sections'

'payroll-derived-preview-tab': (props) => (
  <DerivedPreviewTabSlot sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}} />
),
// Not yet in the registry: same `setup-section` shape the coordinator
// already renders, key resolved by the loader. Prefer the registered
// descriptor the moment it exists.
'payroll-derived-tab': (props) => (
  <DerivedTabSlot
    sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
    basePath={str(props, 'basePath') ?? '/admin/setup/payroll'}
  />
),
```

No new vocabulary. The spec uses only existing blocks: `grid` (the native
`<div className="space-y-5">` shell, `layout: 'bare'` per the [entity]
precedent) and `widget`/`widget-block` with presence flags.

## Proposed conformance entry (coordinator)

The harness user (`viewspec@sim.test`, superadmin on the SIM org) passes
`payroll.manage` and the `payroll` feature is on, so the workspace renders.
The SIM org has no installed country packs (`{}` blob), 2 active pay
schedules (the `…1801-1899` fixture), 0 pay components, and empty filing /
union / entitlement / derived / holiday tables — so the default `packs` tab
renders both pack cards with empty-state coverage, and the entity tabs
render their `t('empty')` rows rather than data rows.

```js
{
  // Payroll setup workspace: two-level tabs, sixteen mutually exclusive
  // bodies. Variants pin the tab branches that matter — the default packs
  // tab, an entity tab with fixture rows, an empty entity tab, and the
  // server-computed preview/calendar tabs.
  path: '/admin/setup/payroll',
  variants: [
    // Packs: CA + US cards, coverage badges, install buttons.
    { query: '', expect: 'main h2, main h3', minMatches: 2 },
    // Schedules: the two fixture pay schedules as list rows.
    { query: '?tab=schedules', expect: 'table tbody tr', minMatches: 2 },
    // Components: empty pay_components table (headers survive, zero body).
    { query: '?tab=components', expect: 'table thead th', minMatches: 1 },
    // Accounts: settings workspace over the SIM chart of accounts.
    { query: '?tab=accounts', expect: 'main h3', minMatches: 1 },
    // Legacy alias: readiness slots link ?tab=ca — lands on accounts.
    { query: '?tab=ca', expect: 'main h3', minMatches: 1 },
    // Unknown tab falls back to packs.
    { query: '?tab=zzzznomatch', expect: 'main h2, main h3', minMatches: 2 },
  ],
  expect: 'main h2, main h3',
  minMatches: 2,
},
```

Row counts verified against the database (`app.bypass_rls` = `on`, SIM
org): active pay schedules 2 (`…1801`, `…1802`); pay_components 0;
entitlement_plans / union_agreements / payroll_holidays /
payroll_filing_accounts / entitlement_plan_limits /
entitlement_service_tiers 0; pay_derived_rules 0; pay_runs 3 (so the
derived-preview tab defaults its range to the last run's period). All
message keys used (`payroll.settingsPage.*`, `payroll.workSchedules.*` via
the work-schedules widget, `admin.setup.*` via the entity slot) already
exist in `web/messages/en/*.json` — verified by grep, none invented.

GATES check: the page's two gates are `payroll.manage` (superadmin holds
all) and feature `payroll` (on for SIM). The setup-workspace shell
(`layout.tsx`) gates on `admin.setup.manage` — also held. No 404 path in
this tenant.

## Fixture (already in the coordinator's hands — proposed SQL)

The `schedules` variant above needs pay-schedule rows; the SIM tenant has
none of its own. Proposed addition to `scripts/viewspec-fixtures.sql`.
Fresh block claimed: `…1801-1899` (payroll schedules) — verified free, no
`…18xx` id exists anywhere in the fixture file today. Fixed ids,
`ON CONFLICT DO NOTHING`, SIM-org only. The frequency values come from the
`pay-schedules` registry entity's own `frequency` options (matching what the
launcher passes to the wizard), not invented strings.

```sql
-- ---- payroll schedules ------------------------------------------------
-- Two active pay schedules so the ?tab=schedules variant renders list rows
-- (and the launcher's schedule picker is non-empty). Block …1801-1899,
-- claimed fresh — no …18xx id exists in this file.
insert into pay_schedules (id, org_id, name, frequency, is_active)
values ('00000000-0000-7000-9000-000000001801', v_org, 'Biweekly — ViewSpec', 'biweekly', true),
       ('00000000-0000-7000-9000-000000001802', v_org, 'Monthly — ViewSpec', 'monthly', true)
on conflict (id) do nothing;
```

Column names (`name`, `frequency`, `is_active`) match the launcher's own
query (`select id, name … where … is_active`) and the wizard's frequency
options; the coordinator owns `scripts/viewspec-fixtures.sql`, the block
above is the exact text to land. (Already applied to the conformance
database — the counts above were observed, not projected.)

## What could not be expressed

Nothing structural, but three things to watch when the harness runs:

- The sixteen tab bodies are eleven widget slots + seven `setup-section`
  placements, all gated by loader presence flags. If a future tab needs a
  genuinely new surface (a second independent list, a drawer), that surface
  needs its own slot — the flags compose, they do not nest.
- `PayrollSetupTabs` reuses `ModuleHomeTabs` for the pill row (the same
  component the module homes render, via the existing prop contract), but
  the group strip above it is bespoke `Link` markup in the shared component
  — there is no `tab-nav`-style registry widget for a two-level strip, and
  the active-vs-plain pair plus `aria-current` cannot be spec vocabulary.
- `StatutoryRatesSection` and `WorkSchedulesSection` are fully client-
  rendered (they fetch their own data through session-authed API routes);
  the spec passes nothing but presence. `DerivedRulePreviewSection` and
  `HolidayCalendarSection` are server-computed over `?rule/?from/?to` and
  `?jurisdiction/?year` — those params ride `sp` through the slot, exactly
  as the native page passes `searchParams`.
