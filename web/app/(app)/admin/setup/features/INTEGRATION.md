# /admin/setup/features ViewSpec integration handoff

Page: `web/app/(app)/admin/setup/features/` — owner files are `view.ts`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`. No
`sections.tsx`: the page defines no local components of its own
(`FeatureRow`/`Switch` render INSIDE the `FeaturesWorkspace` island —
none is referenced by the spec — so nothing needed moving, the
bank-feeds `BankAvatar`/`StatusDot` precedent). `page.tsx` still imports
`FeaturesWorkspace` directly for the native branch; the spec path reuses
it whole through the widget below. Nothing is copied.

Spec shape: `bare` layout (the setup workspace renders its own shell —
same reason as the `[entity]` / labor-costing / payment-operations /
bank-feeds conversions), a single `features-workspace` widget. One new
widget, proposed below. No `grid`: the `space-y-8` wrapper belongs to
`FeaturesWorkspace` itself (`page.tsx` renders the island bare), so the
spec must NOT place it too, or the page renders that div twice (the
bank-feeds `max-w-4xl` precedent).

Why whole-island (not decomposed): `FeaturesWorkspace` owns `useState`
(switch state, pending key), fires `fetch` PUT mutations against
`/api/admin/setup/features`, confirms via `window.confirm`, and toasts +
`router.refresh()` on completion. Decomposing its grouped rows into a
spec repeat would render switches with no toggle flow and strand the
confirm/toast logic from what it acts on (the labor-costing /
bank-feeds lesson). The LOADER makes every server-side data decision
the native page made (gate, resolved state, enabled map, disable
probes); the widget only renders.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed:

```tsx
import { FeaturesWorkspace } from '../../app/(app)/admin/setup/features/FeaturesWorkspace'
```

Check the import block first; no `FeaturesWorkspace` or `features`
hit exists in the registry today (verified by grep — zero matches), so
no twin-component risk. `LucideIcon`, `Link`, `cn` and friends stay
inside the shared island file; the registry needs none of them.

```tsx
/**
 * Features setup switchboard: the whole FeaturesWorkspace island —
 * grouped per-category panels (icon · name · description · switch),
 * the setup-wizard link, the count-on labels, and the per-row
 * blocked/affects/recommends notes. NOT decomposable: everything below
 * the setup shell owns useState (switch state, pending key) and fires
 * fetch PUT mutations with window.confirm + toast + router.refresh.
 * The LOADER makes every server-side data decision (gate, resolved
 * state, enabled map, disable probes); the widget only renders.
 *
 * EXACT prop shape: THREE FLAT props — `features`, `disableStatus`,
 * `wizardHref` — spread directly, exactly as the native page passes
 * them. There is no nested `workspace` bag; do not wrap them in one.
 * (Same flat-spread division as the `bank-feeds-workspace` precedent.)
 *
 * - `features`: `{ key: string; category: string; parentKey?: string;
 *   requiresAll?: string[]; recommends?: string[]; enabled: boolean }[]`
 *   — all 32 FEATURES registry entries in registry order, `enabled`
 *   resolved (multiSubsidiary/multiCurrency data-dependent defaults
 *   included).
 * - `disableStatus`: `Record<string, { blocked: boolean;
 *   impacts: { labelKey: string; count: number }[] }>` — present ONLY
 *   for feature keys with a `FEATURE_DISABLE_CHECKS` probe AND enabled
 *   in this org (the loader filters by `f.enabled` first, verbatim).
 *   Absent key = freely togglable, by native contract.
 * - `wizardHref`: `string` — the `/admin/setup/wizard` literal.
 */
'features-workspace': (props) => (
  <FeaturesWorkspace {...(props as unknown as ComponentProps<typeof FeaturesWorkspace>)} />
),
```

## 2. Slot proposals (none)

No slot is needed. Authz and the org id are consumed server-side by
the loader; only plain data (feature rows, disable statuses, one href
literal) crosses the spec. No capability object, no server action.

## 3. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` (harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, harness super-admin
`viewspec@sim.test` — `is_super_admin = t`, so the
`requirePermission('admin.setup.manage')` gate passes; no feature gate
on this page, it IS the features page):

```js
{
  path: '/admin/setup/features',
  // Whole-island page with no query params: the switchboard renders all
  // 32 registry features in 4 category panels regardless of org state.
  // No second variant is proposed: the page reads no search params, so
  // no query string can render a different tree.
  variants: [{ query: '', expect: 'main button[role="switch"]', minMatches: 32 }],
  expect: 'main button[role="switch"]',
  minMatches: 32,
},
```

Row-count verification (read-only queries): the registry holds 32
feature keys (`grep -c "key: '"` on `engine/src/feature-registry.ts`
→ 32; `features.*` message keys match 1:1, verified by script — no
registry key lacks `title`/`description` copy). Every feature renders
exactly one `Switch` (`role="switch"`, one per `FeatureRow`), so 32
switches render on both paths regardless of org state. The harness
org's resolved state (stored flags + `multiSubsidiary → false` with 1
active non-elimination subsidiary verified, `multiCurrency → false`
with no fx touch verified) only changes WHICH switches are on, never
the count — so the count pins the full-row path, not an empty state.

GATES check: one server gate —
`requirePermission('admin.setup.manage')`. The harness user is
super-admin (verified), so the page renders 200 with the workspace. No
404 branch exists. No logged-out variant is proposed (the harness is
always authenticated; the login redirect is framework behavior, not
page content).

## 4. Fixture SQL (none)

No fixtures are proposed. The page's rows come from the 32-entry
`FEATURES` code registry, not from tenant tables — the full-row path
renders in every org with zero seeded rows. The disable-probe counts
(`postedPayRuns`, `foreignTxns`, …) only change per-row note text
(blocked lock vs. affects-note vs. none), never the row/switch count,
so no probe data needs seeding: the count assertion above holds with
the tenant's honest probe results. No id block is claimed here.

## 5. What the spec does NOT cover (nothing — full coverage)

- The `admin.setup.manage` gate, the resolved feature state (including
  the `multiSubsidiary` / `multiCurrency` data-dependent defaults),
  the `FEATURES.map` with `featureEnabled`, and the
  `featureDisableStatuses` probe over exactly the ENABLED keys are all
  loader work copied verbatim from `page.tsx` — including the comment
  on the disable probe.
- All copy (`setup.features.title/description/runWizard/countOn`,
  `features.<key>.title/description`, impact/confirm/error strings)
  resolves inside the shared island via its existing
  `useTranslations('admin')` hooks — verified the loader invents no
  message key (it calls no `t()` at all).
- `page.tsx` native branch is untouched below the `__viewspec` branch.
