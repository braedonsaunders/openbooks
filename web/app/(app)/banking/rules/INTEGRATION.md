# INTEGRATION — `/banking/rules` ViewSpec conversion

Page: `web/app/(app)/banking/rules/page.tsx`.
Status: **converted, pending vocabulary.** `view.ts` and the `__viewspec`
branch in `page.tsx` are written; no `sections.tsx` (the page has no composite
cells — every cell lives inside the shared `EntityListView`). The spec
references three widget names proposed below, which do not exist in
`WIDGET_REGISTRY` yet. Until the coordinator registers them, the
`?__viewspec=1` path throws `UnknownWidgetError` at render — the native
branch is untouched and ships.

No `packages/viewspec` language change is needed. The one structural need is a
`formatValue` equivalent on the `entity-list-view` slot: the native page passes
a `formatValue` closure that renders the `criteria_summary` / `outcome_summary`
columns, and a spec can never carry a function.

## 1. Proposed `WIDGET_REGISTRY` entries (coordinator: `web/components/viewspec/widgets.tsx`)

```tsx
import { NewRuleButton, RunRulesButton, RuleDrawer } from '../../app/(app)/banking/rules/RuleDrawer'

// Header "new rule" button. Whole-component passthrough with no props — the
// component reads its own `banking.rules.newRule` key internally, exactly
// like `new-project`. Placed twice (header actions + empty-state action),
// matching the native page, which instantiates `<NewRuleButton />` twice.
'new-bank-rule': () => <NewRuleButton />,

// Header "run rules" button. The account picker options are loader-resolved
// (`reconAccountOpts`: active reconcilable accounts as `{ id, label }`),
// mirroring how the native page builds them before rendering.
'run-bank-rules': (props) => (
  <RunRulesButton
    accounts={(props.accounts as ComponentProps<typeof RunRulesButton>['accounts']) ?? []}
  />
),

// Rule flyout. Whole-component passthrough with the drawer's remount key,
// exactly like `project-drawer` (the drawer holds unsaved form state, so the
// key must survive — `key={rule.id}` in the native page; `'new'` for the
// create form, which has no id yet).
'bank-rule-drawer': (props) => {
  const drawer = props.drawer as (ComponentProps<typeof RuleDrawer> & { remountKey: string }) | null
  if (!drawer) return null
  const { remountKey, ...rest } = drawer
  return <RuleDrawer key={remountKey} {...rest} />
},
```

Needs imports: `NewRuleButton`, `RunRulesButton`, `RuleDrawer` from the
page's own `RuleDrawer.tsx` (a client file the registry already imports
client components from, e.g. the order drawers — same pattern).

## 2. Proposed `EntityListSlot` addition: `formatValue` for `bank_rule` (coordinator: `web/components/viewspec/entity-list-slot.tsx`)

The native page's `formatValue` maps two column keys to summaries. Both are
pure functions of the row JSON plus loader-resolved labels; the logic below
is copied VERBATIM from `page.tsx` lines 90–124 (only the translation calls
are evaluated — `getTranslations('banking')` — where the native page calls
`t(...)`, since a slot is a server component like the page):

```tsx
import { getTranslations } from 'next-intl/server'
import { summarizeGroup, type ConditionGroup, type FieldDef } from '../../lib/conditions'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Inside EntityListSlot, after getAuthz(), when recordType === 'bank_rule':
const t = await getTranslations('banking')
const summaryCatalog: FieldDef[] = [
  { key: 'description', label: t('rules.fields.description'), kind: 'text' },
  { key: 'payee', label: t('rules.fields.payee'), kind: 'text' },
  { key: 'anyText', label: t('rules.fields.anyText'), kind: 'text' },
  { key: 'reference', label: t('rules.fields.reference'), kind: 'text' },
  { key: 'amount', label: t('rules.fields.amount'), kind: 'number' },
  { key: 'flow', label: t('rules.fields.flow'), kind: 'flow', options: [{ value: 'in', label: t('rules.signIn') }, { value: 'out', label: t('rules.signOut') }] },
  { key: 'date', label: t('rules.fields.date'), kind: 'date' },
]
const operatorLabels = Object.fromEntries(
  ['contains', 'notContains', 'equals', 'startsWith', 'endsWith', 'isBlank', 'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'is', 'on', 'before', 'after', 'withinDays']
    .map((key) => [key, t(`rules.ops.${key}`)]),
)
const formatValue =
  recordType === 'bank_rule'
    ? (_row: unknown, columnKey: string, value: unknown) => {
        if (columnKey === 'criteria_summary') {
          if (!isRecord(value) || !isRecord(value.match) || !Array.isArray(value.match.rules)) {
            return t('rules.summary.anyLine')
          }
          return summarizeGroup(value.match as unknown as ConditionGroup, summaryCatalog, {
            and: t('rules.summary.and'),
            or: t('rules.summary.or'),
            operatorLabels,
          }) || t('rules.summary.anyLine')
        }
        if (columnKey === 'outcome_summary') {
          if (!isRecord(value)) return '—'
          if (value.action === 'exclude') return t('rules.summary.exclude')
          if (value.action !== 'categorize') return '—'
          const lines = Array.isArray(value.lines) ? value.lines : []
          const firstLine = isRecord(lines[0]) ? lines[0] : null
          const first = accountLabel.get(typeof firstLine?.accountId === 'string' ? firstLine.accountId : '') ?? '—'
          const extra = Math.max(0, lines.length - 1)
          return extra > 0
            ? t('rules.summary.categorizeSplit', { account: first, count: extra })
            : t('rules.summary.categorize', { account: first })
        }
        return undefined
      }
    : undefined
```

Two notes on the verbatim copy:

- `outcomeSummary` closes over `accountLabel`, a `Map` built from the
  offset-accounts picker (`accountOpts`). The slot must build the same map
  from the same query (active non-summary accounts, `number · name` labels)
  to resolve the first outcome line's `accountId`. That query is cheap and
  already runs in the drawer's loader path; alternatively the coordinator may
  prefer resolving the summary text in the LIST query — either way the copy
  above names the dependency explicitly.
- The `?? '—'` / `'—'` fallbacks and the `extra > 0` split branch are part of
  the byte contract: an outcome pointing at a deleted account renders `—`,
  and a two-line outcome renders `Categorize → <first> +1 more`.

Why the slot and not the loader: the summaries must render INSIDE the
list's cells (truncated `<span>` with `title`), which the spec never
decomposes — the list stays one host component. Precomputing per-row text in
the loader would duplicate the list query; the slot already owns the row.

## 3. Fixtures + conformance (coordinator: `scripts/viewspec-fixtures.sql`, `scripts/viewspec-conformance.mjs`)

The sim tenant holds **zero `bank_match_rules` rows** (verified read-only:
`select count(*) …` → 0), so the harness would refuse the page. Seed two
rules — one active, one inactive, so the active/inactive filter chips each
have something to select. **Fresh id block `…0801–…0802`** (verified against
`scripts/viewspec-fixtures.sql`: suffixes in use top out at `0912`; nothing
holds `08xx`, and the header reserves no `08xx` range — the `…0401-0499`
banking block covers statements/reconciliations only, and `…0501-0599`
banking transactions).

The first rule's outcome references the live SIM operating account
`a1f8e08f-a6ae-42ac-b2fd-d8008a92b14e` ("Operating Account", verified live),
so the `outcome_summary` account-label branch resolves to a real name rather
than the `—` fallback; the second rule is `exclude`, exercising the other
outcome branch. Criteria shapes mirror the API integration test's
`criteria()` helper (`{ version: 2, match: { combinator, rules } }`), which
is what `RuleDrawer` writes — but note the native `whenSummary` reads
`criteria.match.rules` (array) while the drawer writes
`{ version: 2, match: group }` where group ALSO has shape
`{ combinator, rules }`, so the seeded shape renders through the real path.

```sql
  -- ---- banking rules -------------------------------------------------------
  --
  -- The simulator never writes matching rules, so the list page is empty and
  -- the harness refuses it. Two rules, one active + one inactive (the
  -- active/inactive chips each need a selectable branch), exercising both
  -- outcome branches: categorize-against-a-live-account (the outcome label
  -- resolves to a real account name, not the em-dash fallback) and exclude.
  -- Fresh id block …0801-0802: nothing in this file holds 08xx (suffixes in
  -- use top out at 0912), and …
...[truncated 911 chars]
```

```js
{
  path: '/banking/rules',
  // Two fixture rules (one active, one inactive). The drawer variant names
  // the drawer layer (UrlDrawer flyout, portaled to <body>).
  variants: [
    '',
    // Inactive filter branch: exactly the one inactive fixture.
    '?active=false',
    // Deliberate empty result: asserts the empty branch (generic
    // common.empty.* copy + the New button as emptyAction), not row content.
    '?q=zzzznomatch',
    {
      query: '?rule=00000000-0000-7000-9000-000000000801',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 2,
},
```

`minMatches: 2` verified: exactly the two fixture rows (zero in sim today).
The harness user needs `banking.reconcile` — the page gates on
`requirePermission('banking.reconcile')`; if the harness user lacks it, BOTH
paths 403 identically and the entry still compares, but the coordinator
should confirm the permission (other banking pages presumably already
establish it).

## 4. Typecheck status

`cd web && node_modules/.bin/tsc --noEmit -p tsconfig.json`: exit 0, zero
errors. Clean for `banking/rules/` and the repo.

## 5. Could not express (and why)

1. The `EntityListView` shell itself — queries, saved-view resolution, filter
   chips, sortable columns, pagination — stays one host component placed by
   name, the projects-page answer to the same problem. No new block/cell
   vocabulary.
2. `formatValue` has no slot spelling today — §2 is the exact proposal. It is
   the ONLY `formatValue` user among all `EntityListView` pages (verified:
   `grep -rln formatValue web/app --include=page.tsx` names only this page),
   so the `recordType === 'bank_rule'` gate affects no other page.
3. `drawerOpen` in `BankingRulesData` is load-bearing documentation only. The
   native page renders the drawer element only when open; through the slot
   that falls out of `drawer: null`. The flag is kept so the loader's
   drawer-open decision stays greppable, matching the bills `drawerOpen`
   field.
4. The header actions wrapper `<div className="flex items-center gap-2">` is
   NOT a widget — it arrives via the header block's `actionsClassName`, which
   `blocks.tsx` renders as a plain div around the actions slot (same as the
   bills `headerActions` div).
