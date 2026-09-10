# /admin/setup/invoicing ViewSpec integration handoff

Page: `web/app/(app)/admin/setup/invoicing/` — owner files are `view.ts`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`. No
`sections.tsx`: the page's local components (`WorkflowRow`, `Metric`,
`PolicyCard`, `ControlLink`) all render INSIDE the
`InvoicingSettingsWorkspace` island — none is referenced by the spec — so
nothing needed moving. `page.tsx` still imports
`InvoicingSettingsWorkspace` directly for the native branch; the spec path
reuses it whole through the widget below. Nothing is copied.

Spec widgets used: `invoicing-setup-workspace` (proposed below — does not
exist in the registry yet). Everything the page renders (the workflow list
with badges/counts/actions, the project-policy card with metrics and footer
CTA, the invoice-controls grid) lives inside that one widget.

Spec shape: `bare` layout (the setup workspace layout renders its own shell
— sticky PageHeader + SetupNav rail — same reason as the `[entity]` /
crm / labor-costing / bank-feeds conversions), one
`invoicing-setup-workspace` widget with SEVEN FLAT props. One new widget,
proposed below.

Why whole-island (not decomposed): the surface is seven conditional pairs,
not presence. The subscription row pairs an Enabled/Disabled badge with an
optional "N active · M paused" count line and gates its "Open
subscriptions" button on the same flag; the project row gates its
"Configure project types" button; the metric tiles mute when the Projects
gate is off and pair that with a dormant-profiles warning paragraph; the
footer CTA swaps BOTH its href and its label on `projectsEnabled`, and adds
an "Open projects" button only when `projectsEnabled &&
applicationProjectTypes > 0`. A spec `table` block is wrong twice over:
variant 'app' renders different thead/td markup (the native list is a
hand-rolled `divide-y` div stack, not a table), and no block vocabulary
chooses between two branches. The LOADER makes every server-side data
decision the native page made (gate, two feature probes, both count
queries); the widget only renders.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (the component already exists):

```tsx
import { InvoicingSettingsWorkspace } from '../../app/(app)/admin/setup/invoicing/InvoicingSettingsWorkspace'
```

Check the import block first — the setup imports (`CrmSetupWorkspace`,
`BankFeedsClient`, `LaborCostingWorkspace`, …) are already there; only add
this line. No name clash: no `invoicing` hit exists in the registry today
(verified by grep).

```tsx
/* --- invoicing setup -------------------------------------------------------- */
/**
 * The whole page is one client island, passed whole like
 * `crm-setup-workspace` and `bank-feeds-workspace`: the workflow list
 * (status badges + optional count lines + gated action buttons), the
 * project-policy card (muting metric tiles, gated warning, dual-label
 * footer CTA) and the invoice-controls grid are seven conditional pairs,
 * not presence — and the native list is a hand-rolled `divide-y` div
 * stack, not a table either variant could carry. Every prop is
 * loader-resolved data (two feature probes, both count queries);
 * the entry only binds it.
 *
 * EXACT prop shape: SEVEN FLAT props — `subscriptionBillingEnabled`,
 * `activeSubscriptions`, `pausedSubscriptions`, `projectsEnabled`,
 * `activeProjectTypes`, `standardProjectTypes`, `applicationProjectTypes`
 * — spread directly, exactly as the native page passes them. There is no
 * nested `workspace` bag; do not wrap them in one. (Same flat-spread
 * division as the `bank-feeds-workspace` precedent.) view.ts types the
 * object against `Parameters<typeof InvoicingSettingsWorkspace>[0]`, so a
 * prop rename breaks the page build, not the render.
 */
'invoicing-setup-workspace': (props) => (
  <InvoicingSettingsWorkspace {...(props as unknown as ComponentProps<typeof InvoicingSettingsWorkspace>)} />
),
```

## 2. Slot proposals (none)

No slot is needed. Authz and the org id are consumed server-side by the
loader; only plain data (two booleans, five numbers) crosses the spec. All
links are static hrefs inside the shared component; no server action, no
capability, no drawer.

## 3. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/admin/setup/invoicing',
  // Whole-island setup page: the loader resolves the manage gate, the
  // subscriptionBilling + projects probes and both count queries;
  // InvoicingSettingsWorkspace renders the workflow list, the policy card
  // and the controls grid. The page reads NO search params (the
  // __viewspec flag is consumed by page.tsx, never by the loader), and
  // its buttons are useState-free Links — so there is exactly ONE page
  // state per dataset and one variant is full coverage. A second variant
  // would render byte-identical markup, which assertVariantsDiffer
  // rejects (the bank-feeds /query precedent).
  variants: [
    '',
  ],
  expect: 'main h2, main section h3',
  minMatches: 4,
},
```

Selector note: the page body (inside the setup shell's `main`) carries one
`h2` ("Invoicing") and three `section > div > h3` headings ("Available
invoice workflows", "Project invoicing policy", "Invoice controls") — all
static copy rendered by the shared component on both paths, so
`minMatches: 4` pins the island without depending on gate/row state. The
`main` scope prefix excludes the setup shell's own header (the shell's
PageHeader title is "Company Settings", an `h1`, so it cannot inflate the
count — but the prefix keeps the pin on page content either way).

GATES check (per the /query lesson): ONE server gate, in the LOADER before
any query — `requirePermission('admin.setup.manage')` (throws, not a render
branch). Verified: the harness user `viewspec@sim.test`
(`01a08426-0962-74c7-a086-e1609c589dcb`) is `is_super_admin` in the SIM org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, so the gate passes. `subscriptionBilling`
/ `projects` are feature PROBES (loader data — Disabled badge vs dormant
warning), not redirects: both renders read the same flags, so every flag
combination compares identically. The `projects` default-on (`true`, unless
the org blob overrides) vs `subscriptionBilling` default-off split is what
§4's fixture closes — without it both count lines render zero and the
subscription row compares two identical empty badges.

Variant-coverage check: the page reads NO search params. Workflow buttons
("Manage feature gate", "Configure project types") and control links are
plain Links with no URL affordance for state. Exactly ONE page state per
dataset — one variant is full coverage.

Row-count verification (read-only queries, `app.bypass_rls='on'`, SIM org,
verified live 2026-09-10):

- `project_types` → 5 active (4 `standard`, 1 `application_for_payment`)
- `subscriptions` → 0 / 0 today; the §4 fixture adds 1 active + 1 paused,
  so the subscription row renders "1 active · 1 paused" on both paths
- harness org features blob HAS `projects: true`, LACKS `subscriptionBilling`
  (renders Disabled until §4's `'subscriptionBilling': true` merge)
- 5 active customer parties with `customer_roles` rows exist (used by the
  §4 subscription's customer picker path — the fixture reuses one)

No logged-out variant is proposed (the harness is always authenticated;
the login redirect is framework behavior, not page content — the
labor-costing/bank-feeds precedent).

## 4. Fixture SQL (for the coordinator — fold into `scripts/viewspec-fixtures.sql`)

Claims fresh block **…1401–1404** (verified unused: zero
`00000000-0000-7000-9000-0000000014*` ids in the file today, and no pending
`…14xx` claim in any shipped INTEGRATION.md — the `…12xx` block is taken by
bank feeds, `…13xx` by CRM prospects). Please also add `…1401-1404
invoicing setup (plan, customer, subscriptions)` to the allocation table at
the top of the file.

Two parts: (a) a `'subscriptionBilling': true` merge in the existing
"feature switches" block idiom (the `jsonb_build_object` list — the
bank-feeds precedent); WITHOUT it the row renders "Disabled" with no count
line on both paths and the comparison pins nothing but static copy; (b) the
block below, in the same `do $$` style as the rest of the file (it uses the
ambient `v_org`).

CHECK-safe by construction (verified against the live schema):
`subscription_plans.interval` ∈ weekly/monthly/quarterly/annually,
`subscriptions.status` ∈ active/paused/canceled, `quantity > 0`,
`start_on <= next_bill_on` — the fixture uses `monthly` / `active,paused`.

Guard note: plain `ON CONFLICT (id) DO NOTHING` is idempotent here. The
four tables carry no trigger and no EXCLUDE constraint (constraints are
pkey + plain CHECKs only), and the only UNIQUE besides pkey is on columns
this fixture does not collide on (plan/party keys are fixture-unique
`vs-*`). No second-run RAISE path exists (unlike the property-management
lease-charge precedent). Trial insert verified live against
`openbooks_sim_viewspec` on 2026-09-10 (returned `1|1` — then rolled back
by re-deleting the four fixture ids so the coordinator's apply is clean).

Side-effect audit (the fixture enables `subscriptionBilling` for the SIM
org — who else reads it?):

- `/collections` reads it as a PROBE (loader data: tab visibility +
  option queries), not a redirect — its INTEGRATION.md §notes already
  document the sim org has NEITHER subscription flag, and its pinned
  selectors (`main button, main h3, main td`, minMatches 8) count shell
  chrome that exists with or without the flag. After the merge its loader
  runs two more option queries (5 customers + income accounts) and shows
  the Subscriptions tab — both renders do it identically, so its
  comparison still passes; but the coordinator should re-check its
  minMatches (the tab adds buttons) before calling it green.
- `web/lib/features.ts` impact map (`subscriptionBilling` → blocked while
  active subscriptions exist) only affects the Features-page disable
  affordance — same data both paths.
- The simulator (`saas-autopilot.ts`) bills ACTIVE subscriptions — one
  more active subscription in the SIM tenant is one more invoice IF the
  simulator runs after apply. That is the honest cost of pinning the
  "N active" branch; the alternative (paused-only rows) leaves the
  active-count branch uncompared. Flagged, not hidden.
- `advancedSubscriptions` stays ABSENT — the paused row exercises only the
  base `status = 'paused'` count the loader queries, not the lifecycle
  engine.

```sql
  -- ---- invoicing setup --------------------------------------------------------
  --
  -- The simulator never sells subscriptions, so /admin/setup/invoicing renders
  -- "Disabled" with no count line on both paths. One plan, one customer and
  -- two subscriptions (1 active + 1 paused) so the subscription row renders
  -- "1 active · 1 paused" with the "Open subscriptions" action. The project
  -- side needs no fixture: the simulator already seeds 5 active project
  -- types (4 standard, 1 application_for_payment), pinning all three metric
  -- tiles and the "Open projects" footer action (projects defaults on).
  -- Claims fresh block …1401-1404 (verified unused).
  insert into parties (id, org_id, kind, display_name, email, is_active)
  values ('00000000-0000-7000-9000-000000001401', v_org, 'customer',
    'ViewSpec Subscriber', 'subscriber@viewspec.test', true)
  on conflict (id) do nothing;

  insert into customer_roles (org_id, party_id, is_active)
  values (v_org, '00000000-0000-7000-9000-000000001401', true)
  on conflict do nothing;

  insert into subscription_plans (id, org_id, name, amount, "interval", interval_count, is_active)
  values ('00000000-0000-7000-9000-000000001402', v_org, 'ViewSpec Plan', 100, 'monthly', 1, true)
  on conflict (id) do nothing;

  insert into subscriptions (id, org_id, customer_id, plan_id, status, start_on, next_bill_on)
  values ('00000000-0000-7000-90
...[truncated 911 chars]