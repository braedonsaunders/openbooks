# /admin/setup/labor-costing ViewSpec integration handoff

Page: `web/app/(app)/admin/setup/labor-costing/` — owner files are
`view.ts` (+ this file) and the `__viewspec` branch + imports in
`page.tsx`. No `sections.tsx`: the only component is the existing
`LaborCostingWorkspace`, reused whole.

Spec shape: `bare` layout (the setup workspace renders its own shell —
same reason as the `[entity]` conversion), one `space-y-4` grid holding
the h2 header row, a `labor-costing-tabs` widget, and a
`labor-costing-workspace` widget. The header action cluster is a third
widget, `labor-costing-header-actions`. Three new widgets, all proposed
below.

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

New imports needed:

```tsx
import Link from 'next/link'
import { BookOpen, Sparkles } from 'lucide-react'
import { Button, cn } from '@openbooks/ui'
import { LaborCostingWorkspace } from '../../app/(app)/admin/setup/labor-costing/LaborCostingWorkspace'
```

Check the lucide-react/`@openbooks/ui` import lines first — `Link`,
`Button` and `cn` are already imported in the registry file; only add
what is missing. `BookOpen`/`Sparkles` must be diffed against any same
name already there: they do not exist in the registry today (verified by
grep — no `Sparkles`, `BookOpen` or `labor` hits), so no twin-component
risk.

```tsx
/**
 * Labor-costing header actions: wizard-launch outline button, docs ghost
 * button, and the overhead-model text link. NOT `link-button`: that entry
 * renders a bare `<Link>` child with no space after a single 14px map
 * icon and no `size="sm"`, while this cluster needs `<Sparkles size={14}
/>` + space and `<BookOpen size={14} />` + space inside `size="sm"`
 * outline/ghost buttons, plus a teal text link carrying a literal `→`.
 * Diffed; kept separate. One component behind one registry entry.
 */
'labor-costing-header-actions': (props) => (
  <div className="flex flex-wrap items-center gap-2">
    <Button asChild variant="outline" size="sm">
      <Link href={(str(props, 'guideHref') ?? '') as never}>
        <Sparkles size={14} aria-hidden /> {str(props, 'guideLabel') ?? ''}
      </Link>
    </Button>
    <Button asChild variant="ghost" size="sm">
      <Link href="/docs/labor-costing">
        <BookOpen size={14} aria-hidden /> {str(props, 'docsLabel') ?? ''}
      </Link>
    </Button>
    <Link
      href="/admin/setup/overhead"
      className="px-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
    >
      {str(props, 'overheadLabel') ?? ''} →
    </Link>
  </div>
),
/**
 * Labor-costing view tabs: underline links, active tab teal. NOT
 * `module-home-tabs`: that is a pill strip (`rounded-lg bg-slate-100`
 * container, `aria-current`, no underline); these tabs are `-mb-px
 * border-b-2` links with no `aria-current`. Diffed; kept separate.
 */
'labor-costing-tabs': (props) => {
  const tabs = (props.tabs as { href: string; label: string; active: boolean }[]) ?? []
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href as never}
          className={cn(
            '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
            tab.active
              ? 'border-teal-600 text-teal-700 dark:text-teal-300'
              : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-100',
          )}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  )
},
/**
 * The whole LaborCostingWorkspace client island: guided-status strip,
 * rate grid (search + scope/status chips, table, pager, empty row),
 * estimate components, posting switch, reconciliation loader, rate
 * drawer and setup wizard. Everything below the page header owns
 * `useState` (settings draft, rec range/result, drawer), so it arrives
 * whole — decomposing its filterable rate grid into a spec repeat would
 * render the unfiltered set and strand the search input from what it
 * filters. The LOADER makes every data decision (filters, counts,
 * options, coverage); the widget only renders.
 */
'labor-costing-workspace': (props) => (
  <LaborCostingWorkspace
    view={str(props, 'view') === 'components' || str(props, 'view') === 'posting' || str(props, 'view') === 'reconciliation' ? str(props, 'view') : 'rates'}
    settings={props.settings as ComponentProps<typeof LaborCostingWorkspace>['settings']}
    rates={(props.rates as ComponentProps<typeof LaborCostingWorkspace>['rates']) ?? []}
    selectedRate={(props.selectedRate as ComponentProps<typeof LaborCostingWorkspace>['selectedRate']) ?? null}
    creatingRate={props.creatingRate === true}
    guideOpen={props.guideOpen === true}
    currentParams={(props.currentParams as Record<string, string | string[] | undefined>) ?? {}}
    totalRates={Number(props.totalRates ?? 0)}
    ratePage={Number(props.ratePage ?? 1)}
    ratePerPage={Number(props.ratePerPage ?? 25)}
    trades={(props.trades as ComponentProps<typeof LaborCostingWorkspace>['trades']) ?? []}
    departments={(props.departments as ComponentProps<typeof LaborCostingWorkspace>['departments']) ?? []}
    subsidiaries={(props.subsidiaries as ComponentProps<typeof LaborCostingWorkspace>['subsidiaries']) ?? []}
    defaultSubsidiary={(props.defaultSubsidiary as ComponentProps<typeof LaborCostingWorkspace>['defaultSubsidiary']) ?? null}
    jobTitles={(props.jobTitles as string[]) ?? []}
    accounts={(props.accounts as ComponentProps<typeof LaborCostingWorkspace>['accounts']) ?? []}
    currencies={(props.currencies as string[]) ?? []}
    orgCurrency={str(props, 'orgCurrency') ?? ''}
    laborWip={(props.laborWip as string | null) ?? null}
    laborClearing={(props.laborClearing as string | null) ?? null}
    payrollVariance={(props.payrollVariance as string | null) ?? null}
    coverage={(props.coverage as ComponentProps<typeof LaborCostingWorkspace>['coverage']) ?? { employees: 0, covered: 0, hasOrgDefault: false }}
  />
),
```

A note on the `view` prop: it is NOT a spec conditional. The loader
whitelists `?view=` to one of the four tabs (default `rates`) and the
widget passes the resolved string through; the client branching inside
`LaborCostingWorkspace` is the same component both paths render. An
invalid `?view=` renders the rates tab on both paths, identically.

## 2. Slot proposals (none)

No slot is needed. Authz, org id, feature state and `today` are consumed
server-side by the loader; only plain data (strings, numbers, booleans,
rows, option lists) crosses the spec.

## 3. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` (harness org
`da472d3a-…`, harness super-admin `viewspec@sim.test`):

```js
{
  path: '/admin/setup/labor-costing',
  // Tabbed setup workspace placed whole: the `rates` tab renders the
  // guided-status strip and an empty rate grid (the tenant holds zero
  // labor_cost_rates); the `components` tab renders the estimate
  // component editor. Both branches differ from the default — no
  // identical-markup variant is proposed.
  variants: [
    '',
    { query: '?view=components', expect: 'main section h3', minMatches: 1 },
    {
      query: '?rate=new',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      // The drawer is portaled to <body>: without naming that root the
      // comparison never looks at it. Deterministic in-tenant: static
      // scope/currency/basis options, no rows required.
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'main section',
  minMatches: 1,
},
```

GATES check (per the /query lesson): two server gates —
`requirePermission('admin.setup.manage')` and
`requireProjectsFeature` (redirects to `/admin/setup/features` when the
projects feature is off). The harness user passes the permission via the
admin role, and projects is stored `true` on the harness org — both
verified — so the page renders 200 with the workspace. No 404 branch
exists. No logged-out variant is proposed (the harness is always
authenticated; the login redirect is framework behavior, not page
content).

Variant-coverage check (per the /compliance lesson): the tenant holds
zero `labor_cost_rates`, so `rateStatus`/`rateScope`/`q` filter variants
CANNOT differ from the default — all render the same empty grid — and no
such variant is proposed. `?view=components` is proposed because it
renders a genuinely different tree (the component editor section with
its own `h3`). `?view=posting` / `?view=reconciliation` are not proposed:
they add no row-count-bearing content the harness `expect` could pin
beyond what the default already proves, and each extra identical-select
variant weakens the entry. `?rate=new` / `?guide=setup` open drawers
whose tested surface is the workspace widget itself, already covered.

Row-count verification (read-only queries):
`labor_cost_rates` in the harness org → 0 rows (0 active-scopeless),
so the rates table renders its `emptyFiltered` row and no pager
(`totalRates > 0` false on both paths).

## 4. Fixture SQL (none)

No fixtures are proposed. Seeding rate rows would need allocation-block
ids for `labor_cost_rates` plus joined trades/departments/subsidiaries,
accounts and employee roles to render anything beyond an empty grid —
and the empty grid IS the tenant's honest state, asserted by the entry
above. If the coordinator wants a populated-grid variant later, that is
a fixture-design decision for the owning team, not a silent skip: no id
block is claimed here.

## 5. What the spec does NOT cover (nothing — full coverage)

- The eleven-way fetch, the rate filters (status/scope/search/
  subsidiary), the `?view=`/`?rateStatus=`/`?rateScope=` whitelists, the
  currency derivation and the guide-href merge are all loader work copied
  verbatim from `page.tsx` — including the `indeterminate` checkbox ref,
  the `previewRate` mirror and the wizard `onApplied` merge, which live
  inside the shared workspace component and run identically on both
  paths.
- Message keys used by the loader (`setup.laborCosting.title`,
  `setup.laborCosting.description`, `setup.laborCosting.tabs.*`,
  `setup.laborCosting.checklist.launchWizard`,
  `setup.laborCosting.docs`, `setup.entities.overhead-model.title`) are
  all already consumed by the native page — verified by grep; none
  invented. All other copy resolves inside the shared client components
  via their existing hooks.
- `page.tsx` native branch is untouched below the `__viewspec` branch.
