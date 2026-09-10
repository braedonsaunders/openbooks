# /admin/setup/wizard ViewSpec integration handoff

Page: `web/app/(app)/admin/setup/wizard/` — owner files are `view.ts`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`. No
`sections.tsx`: the page defines no local components of its own (every
step — `WelcomeStep`, `CompanyStep`, `IndustryStep`, `ProfileStep`,
`RhythmStep`, `OperationsStep`, `PayrollStep`, `LaunchStep`,
`ReviewStep`, `ApplyingStep`, `DoneStep`, `ToggleRow`, `ReviewRow` —
renders INSIDE the `SetupWizard` island, none is referenced by the spec,
so nothing needed moving; the features `FeatureRow`/`Switch` and
bank-feeds `BankAvatar`/`StatusDot` precedent). `page.tsx` still imports
`SetupWizard` directly for the native branch; the spec path reuses it
whole through the widget below. Nothing is copied.

Spec shape: `bare` layout (the setup workspace renders its own shell
around every setup page — same reason as the features / bank-feeds /
crm conversions), a single `setup-wizard` widget. One new widget,
proposed below. No `grid`: the fixed full-screen scrim + centered card
chrome belongs to `WizardShell` itself (`page.tsx` renders the island
bare), so the spec must NOT place it too, or the page renders that
chrome twice (the bank-feeds `max-w-4xl` / features `space-y-8`
precedent).

Why whole-island (not decomposed): `SetupWizard` owns `useState` (the
step index, every form field, all twelve toggles + full-registry
`featureChoices`, busy/transitioning guards), derives per-step state
(conditional `payroll` step insertion, industry presets, review feature
list), fires `fetch` PUT/POST mutations against
`/api/admin/setup/wizard` (+ payroll-pack and sample-company
follow-ups), confirms via toast + `router.refresh()`, and animates every
transition with framer-motion. Decomposing its steps into spec blocks
would render inputs with no state flow and strand the per-step
validation/presets/review derivations from what they act on (the
features / bank-feeds / labor-costing lesson). The LOADER makes every
server-side data decision the native page made (both redirects, org
row, industry-switch probe, resolved feature state, `initial`
assembly); the widget only renders.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (the component already exists; verified by grep — no
`SetupWizard` hit exists in the registry today, so no twin-component
risk):

```tsx
import { SetupWizard } from '../../app/(app)/admin/setup/wizard/SetupWizard'
```

Entry:

```tsx
/**
 * Setup-wizard rerun page: the whole SetupWizard island — ten animated
 * steps (welcome → company → industry → profile → rhythm → operations →
 * [payroll] → launch → review → applying → done) inside the WizardShell
 * scrim/card/progress/footer chrome. NOT decomposable: every step owns
 * useState (fields, toggles, step index, busy guards), derives per-step
 * state (conditional payroll-step insertion, industry presets, review
 * list), fires fetch PUT/POST mutations with toast + router.refresh, and
 * animates via framer-motion. The LOADER makes every server-side data
 * decision (both redirects, org row, canSwitchIndustry probe, resolved
 * feature state, `initial` assembly); the widget only renders.
 *
 * EXACT prop shape: FIVE FLAT props — `open`, `industries`, `initial`,
 * `canSwitchIndustry`, `isRerun` — spread directly, exactly as the
 * native page passes them. There is no nested bag; do not wrap them in
 * one. (Same flat-spread division as the `features-workspace` /
 * `bank-feeds-workspace` precedent.)
 *
 * - `open`: `boolean` — the literal `true` (travels as loader data, the
 *   features `wizardHref` precedent, so the spec binds only
 *   already-resolved fields).
 * - `industries`: `IndustryDef[]` — the whole `INDUSTRIES` code
 *   registry in registry order (`key`, `icon`, `category`, `features`,
 *   `coa`, `controlAccounts`; all plain serializable data).
 * - `initial`: `{ name: string; legalName: string; country: string;
 *   baseCurrency: string; fiscalYearStartMonth: number;
 *   industry: string | null; workspaceProfile: { teamSize;
 *   complexity; bookStart; taxPosition; monthlyActivity; closeCadence };
 *   features: Record<ToggleKey, boolean> }` (exactly the 12 toggle
 *   keys: inventory, timeTracking, multiSubsidiary, multiCurrency,
 *   projects, subscriptionBilling, orders, crm, bankFeeds,
 *   onlinePayments, fixedAssets, payroll) + `allFeatures:
 *   Record<string, boolean>` (all 32 FEATURES registry keys in
 *   registry order, `enabled` resolved).
 * - `canSwitchIndustry`: `boolean` — the postings existence probe.
 * - `isRerun`: `boolean` — the literal `true`.
 *
 * The island's two OPTIONAL props (`suppressOnWizardRoute`, `onClose`)
 * are deliberately absent from the spec: the native page does not pass
 * them either, so spreading only the five bound keys reproduces
 * `undefined`/`undefined` exactly on both paths.
 */
'setup-wizard': (props) => (
  <SetupWizard {...(props as unknown as ComponentProps<typeof SetupWizard>)} />
),
```

## 2. Slot proposals (none)

No slot is needed. Authz and the org id are consumed server-side by
the loader; only plain data (one boolean literal pair, the industry
registry, the assembled `initial`, one probe boolean) crosses the spec.
No capability object, no server action.

## 3. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified against `openbooks_sim_viewspec` (harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, harness super-admin
`viewspec@sim.test` — `is_super_admin = t`, so the
`admin.setup.manage` gate passes; no feature gate on this page):

```js
{
  path: '/admin/setup/wizard',
  // Whole-island page with no query params: both paths mount the same
  // island at stepIdx 0, so the welcome step (WizardShell chrome +
  // welcome title/description/feature boxes) renders identically
  // regardless of org state. No second variant is proposed: the page
  // reads no search params, so no query string can render a different
  // tree.
  variants: [{ query: '', expect: '[data-testid="setup-wizard"]', minMatches: 1 }],
  expect: '[data-testid="setup-wizard"]',
  minMatches: 1,
},
```

Render-shape verification (read-only queries + code):

- The harness org row exists: `SIM · Summit Ridge Construction`, USD,
  US, no stored industry, no stored workspace profile (all six profile
  fields fall through to loader defaults; `industry` is `NULL`). The
  `initial` assembly therefore exercises the `?? ''` / `?? null` /
  guarded-default branches, not just the stored-value path.
- `journal_lines` for the harness org = 1312 rows, so
  `canSwitchIndustry` resolves `false` here — the industry-lock branch,
  not the free-switch branch. Either way the welcome-step DOM (what the
  selector pins) is identical; the probe only affects later steps.
- `settings.features` has `payroll: true`, so the conditional `payroll`
  step IS inserted (`steps` has 11 entries) — but `steps[0]` is still
  `'welcome'` and `stepIdx` initializes to 0 on both paths, so the
  pinned render is the welcome step in every org state.
- Exactly one `[data-testid="setup-wizard"]` node exists per render:
  `SetupWizard` passes the literal `testId="setup-wizard"` to one
  `WizardShell`, whose root `motion.div` carries it. The selector is
  deliberately unscoped to `main` (the shell is a fixed overlay, not a
  portal, but the pin should not depend on shell ancestry).
- The `suppressOnWizardRoute` interplay is identical on both paths:
  the app layout's inline instance suppresses itself on this route
  while the page's instance renders — the spec path changes neither
  instance.

GATES check: two server gates — login redirect + `admin.setup.manage`
redirect (the `requirePermission` shape written inline with `getAuthz`
/ `can`). The harness user is super-admin (verified), so the page
renders 200 with the workspace. No 404 branch exists. No logged-out
variant is proposed (the harness is always authenticated; the login
redirect is framework behavior, not page content).

## 4. Fixture SQL (none)

No fixtures are proposed and no id block is claimed. The page's
content comes from the org row (present), the `INDUSTRIES` / `FEATURES`
code registries, and the `canSwitchIndustry` existence probe — never
from tenant tables that the simulator leaves empty. The pinned welcome
render needs zero seeded rows in any org state. (Block-freeness double
checked: `…1601-1799`, `…2201-2799`, `…3201-3799` are unused in
`scripts/viewspec-fixtures.sql`, but claiming one would only add a
silent `ON CONFLICT DO NOTHING` row the page never reads.)

## 5. What the spec does NOT cover (nothing — full coverage)

- Both redirects, the org row query, the `canSwitchIndustry` probe,
  the `resolvedFeatureState` load, and the full `initial` assembly
  (fiscal-year default, `?? null` industry, all six guarded
  workspace-profile fields, the 12-key toggles, the full-registry
  `allFeatures` map) are loader work copied verbatim from `page.tsx`.
- All copy (`admin.setup.wizard.*`, `admin.features.*`,
  `admin.industries.*`) resolves inside the shared island via its
  existing `useTranslations` hooks — verified the loader invents no
  message key (it calls no `t()` at all).
- All client behavior (step state, industry presets, PUT/POST
  mutations, payroll-pack + sample-company follow-ups, animations)
  ships inside the shared island, byte-identical on both paths.
- `page.tsx` native branch is untouched below the `__viewspec` branch.
