# /projects/wip-billing ViewSpec integration handoff

Page: `web/app/(app)/projects/wip-billing/` — owner files are `view.ts` (+ this
file) and the `__viewspec` branch + imports in `page.tsx`. No `sections.tsx`:
the page needs no composite cells (see §4).

Spec widgets used: `pageHeader` block + `wip-billing-workspace` (proposed
below — does not exist in the registry yet).

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (already exists as a component):

```tsx
import { WipBillingWorkspace } from '../../app/(app)/projects/wip-billing/WipBillingWorkspace'
```

Entry:

```tsx
/* --- WIP & prebilling ----------------------------------------------------- */
/**
 * Whole: the workspace owns the create drawer, the detail drawer, per-line
 * edit/hold/release forms, and every transition/convert call. Decomposing it
 * would strand that client state from the actions it drives — the same reason
 * the banking match page places `match-workspace` whole. The loader hands
 * over exactly the props the native page passes; the entry spreads them onto
 * the same component, so the two paths render one implementation.
 *
 * EXACT prop shape (== WipBillingWorkspace props in
 * web/app/(app)/projects/wip-billing/WipBillingWorkspace.tsx; the coordinator
 * wires them verbatim):
 *   prebills:         PrebillListRow[]   // { id, worksheetNumber, projectId,
 *                                        //   projectName, customerName,
 *                                        //   periodStart, periodEnd, status,
 *                                        //   originalBillAmount,
 *                                        //   proposedBillAmount, costAmount,
 *                                        //   adjustmentAmount, billingRequestId,
 *                                        //   invoiceDocumentId, invoiceNumber,
 *                                        //   createdAt }
 *   projects:         ProjectOption[]    // { id, name, customerName,
 *                                        //   projectTypeName, lineBuilder }
 *   analytics:        WipAnalytics       // { aging: { current, days1to30,
 *                                        //   days31to60, days61to90, over90,
 *                                        //   held },
 *                                        //   realization: { original, billed,
 *                                        //   adjustment, percent },
 *                                        //   leakage: { writeDowns,
 *                                        //   heldOver90, total } }
 *   selected:         PrebillDetail | null  // PrebillListRow + { notes,
 *                                        //   submittedAt, approvedAt,
 *                                        //   convertedAt, voidedAt, voidReason,
 *                                        //   lines: PrebillLineRow[],
 *                                        //   events: [{ id, eventType,
 *                                        //   actorName, occurredAt, details }] }
 *   canManage:        boolean            // can(authz, 'projects.manage')
 *   canApprove:       boolean            // can(authz, 'ar.approve')
 *   canCreateInvoice: boolean            // can(authz, 'ar.create')
 */
'wip-billing-workspace': (props) => (
  <WipBillingWorkspace
    prebills={(props.prebills as ComponentProps<typeof WipBillingWorkspace>['prebills']) ?? []}
    projects={(props.projects as ComponentProps<typeof WipBillingWorkspace>['projects']) ?? []}
    analytics={props.analytics as ComponentProps<typeof WipBillingWorkspace>['analytics']}
    selected={(props.selected as ComponentProps<typeof WipBillingWorkspace>['selected']) ?? null}
    canManage={props.canManage === true}
    canApprove={props.canApprove === true}
    canCreateInvoice={props.canCreateInvoice === true}
  />
),
```

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

The simulator seeds no prebills, so §3 fixtures seed two worksheets (§3) with
rows the harness user can see: the harness user holds the admin role
(`subsidiary_restriction {"mode": "all"}`), so `allowedSubsidiaryIds` is null
and the lib's subsidiary guard is vacuous for both paths.

```js
{
  path: '/projects/wip-billing',
  // Whole-workspace page: the default render carries the seeded draft + review
  // worksheets (tiles, table rows); the drawer variant opens the draft
  // worksheet with its metrics, lines and audit trail.
  variants: [
    '',
    {
      query: '?prebill=00000000-0000-7000-9000-000000002101',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      // The detail drawer is portaled to <body>, so it has to be named
      // explicitly or the comparison never looks at it.
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 2,
},
```

Row-count verification (read-only queries against
`openbooks_sim_viewspec`, SIM org `da472d3a-…`):

- `select count(*) from wip_prebills where org_id = <sim>` → `2` after §3
  (0 before — the simulator never creates worksheets).
- List table renders one `<tr>` per worksheet → 2 body rows on the default
  variant. (The detail-drawer lines table is portaled outside `<main>`; the
  drawer variant pins it via the `[data-drawer-layer]` scope instead.)
- Drawer id `…2101` is worksheet `WIP-VSPEC1`, status `draft`, in the SIM
  org — passes the org guard inside `loadPrebill`.

## 3. Proposed fixture SQL (for the coordinator — append inside the `do $$` block of `scripts/viewspec-fixtures.sql`)

**Claims block `…2101-2199`** (verified fresh: `grep -o` over the whole file
shows no `…21xx` id in use; nearest neighbors are `…2001-2022` AP capture
documents and `…2801-2803` field tickets).

**Also required: enable the gate.** `wipBilling` defaults OFF in
`engine/src/feature-registry.ts` (`defaultEnabled: false`,
`requiresAll: ['projects']`) and the SIM org's `settings->'features'` does
not set it, so the page 404s identically on both paths today — a match the
harness must not accept. Add `'wipBilling', true` to the `jsonb_build_object`
in the existing "feature switches" `update orgs … where id = v_org` block.

```sql
  -- ---- WIP & prebilling (/projects/wip-billing) ------------------------------
  -- The simulator never creates worksheets, so the page would compare two
  -- identical empty states. Two worksheets on one live SIM project (resolved
  -- by name — the simulator regenerates ids on every reseed): a draft with
  -- two bill lines + one held line and an audit trail, and a review worksheet
  -- with one line, so the list table has rows and the detail drawer has
  -- metrics, lines and events. Block …2101-2199 (claimed fresh 2026-09-10;
  -- neighbors are …2001-2022 AP capture and …2801-2803 field tickets).
  -- Actor is the harness user viewspec@sim.test, resolved live by email.
  insert into wip_prebills
    (id, org_id, project_id, worksheet_number, period_start, period_end,
     status, notes, original_bill_amount, proposed_bill_amount, cost_amount,
     adjustment_amount, created_by, updated_by)
  select '00000000-0000-7000-9000-000000002101', v_org, p.id,
         'WIP-VSPEC1', date '2026-01-01', date '2026-01-31',
         'draft', 'ViewSpec conformance worksheet', 1250.0000, 1150.0000,
         800.0000, -100.0000, u.id, u.id
    from (select id from projects
           where org_id = v_org and name = 'Riverside Mall Facilities T&M'
           order by id limit 1) p,
         (select id from users where email = 'viewspec@sim.test'
           order by id limit 1) u
   where not exists (select 1 from wip_prebills
                      where id = '00000000-0000-7000-9000-000000002101');

  insert into wip_prebills
    (id, org_id, project_id, worksheet_number, period_start, period_end,
     status, notes, original_bill_amount, proposed_bill_amount, cost_amount,
     adjustment_amount, submitted_at, created_by, updated_by)
  select '00000000-0000-7000-9000-000000002102', v_org, p.id,
         'WIP-VSPEC2', date '2026-02-01', date '2026-02-28',
         'review', 'ViewSpec conformance worksheet (review)', 600.0000,
         600.0000, 400.0000, 0.0000, now() - interval '2 days', u.id, u.id
    from (select id from projects
           where org_id = v_org and name = 'Riverside Mall Facilities T&M'
           order by id limit 1) p,
         (select id from users where email = 'viewspec@sim.test'
           order by id limit 1) u
   where not exists (select 1 from wip_prebills
                      where id = '00000000-0000-7000-9000-000000002102');

  -- Lines carry no source FKs (time_entry_id / document_line_id left null —
  -- the FKs only constrain non-null values), so they render without touching
  -- ledger tables either path could disagree on.
  insert into wip_prebill_lines
    (id, org_id, prebill_id, project_id, line_number, source_type,
     source_date, description, quantity, unit, cost_amount,
     original_bill_amount, proposed_bill_amount, adjustment_amount,
     adjustment_reason, adjustment_evidence, disposition, pricing_snapshot)
  select '00000000-0000-7000-9000-000000002111', v_org,
         '00000000-0000-7000-9000-000000002101', p.id, 1, 'time_entry',
         date '2026-01-15', 'ViewSpec conformance line 1', 8.0000, 'hours',
         500.0000, 750.0000, 750.0000, 0.0000, null, '[]'::jsonb, 'bill',
         '{}'::jsonb
    from (select id from projects
           where org_id = v_org and name = 'Riverside Mall Facilities T&M'
           order by id limit 1) p
   where exists (select 1 from wip_prebills
                  where id = '00000000-0000-7000-9000-000000002101')
     and not exists (select 1 from wip_prebill_lines
                      where id = '00000000-0000-7000-9000-000000002111');

  insert into wip_prebill_lines
    (id, org_id, prebill_id, project_id, line_number, source_type,
     source_date, description, quantity, unit, cost_amount,
     original_bill_amount, proposed_bill_amount, adjustment_amount,
     adjustment_reason, adjustment_evidence, disposition, pricing_snapshot)
  select '00000000-0000-7000-9000-000000002112', v_org,
         '00000000-0000-7000-9000-000000002101', p.id, 2, 'document_line',
         date '2026-01-20', 'ViewSpec conformance line 2', 1.0000, 'each',
         300.0000, 500.0000, 400.0000, -100.0000, 'ViewSpec write-down',
         '["VSPEC-EV-1"]'::jsonb, 'bill', '{}'::jsonb
    from (select id from projects
           where org_id = v_org and name = 'Riverside Mall Facilities T&M'
           order by id limit 1) p
   where exists (select 1 from wip_prebills
                  where id = '00000000-0000-7000-9000-000000002101')
     and not exists (select 1 from wip_prebill_lines
                      where id = '00000000-0000-7000-9000-000000002112');

  insert into wip_prebill_lines
    (id, org_id, prebill_id, project_id, line_number, source_type,
     source_date, description, quantity, unit, cost_amount,
     original_bill_amount, proposed_bill_amount, adjustment_amount,
     adjustment_reason, adjustment_evidence, disposition, pricing_snapshot)
  select '00000000-0000-7000-9000-000000002113', v_org,
         '00000000-0000-7000-9000-000000002101', p.id, 3, 'document_line',
         date '2026-01-25', 'ViewSpec conformance held line', 1.0000, 'each',
         200.0000, 200.0000, 200.0000, 0.0000, null, '[]'::jsonb, 'hold',
         '{}'::jsonb
    from (select id from projects
           where org_id = v_org and name = 'Riverside Mall Facilities T&M'
           order by id limit 1) p
   where exists (select 1 from wip_prebills
                  where id = '00000000-0000-7000-9000-000000002101')
     and not exists (select 1 from wip_prebill_lines
                      where id = '00000000-0000-7000-9000-000000002113');

  insert into wip_prebill_lines
    (id, org_id, prebill_id, project_id, line_number, source_type,
     source_date, description, quantity, unit, cost_amount,
     original_bill_amount, proposed_bill_amount, adjustment_amount,
     adjustment_reason, adjustment_evidence, disposition, pricing_snapshot)
  select '00000000-0000-7000-9000-000000002114', v_org,
         '00000000-0000-7000-9000-000000002102', p.id, 1, 'time_entry',
         date '2026-02-10', 'ViewSpec conformance review line', 4.0000,
         'hours', 400.0000, 600.0000, 600.0000, 0.0000, null, '[]'::jsonb,
         'bill', '{}'::jsonb
    from (select id from projects
           where org_id = v_org and name = 'Riverside Mall Facilities T&M'
           order by id limit 1) p
   where exists (select 1 from wip_prebills
                  where id = '00000000-0000-7000-9000-000000002102')
     and not exists (select 1 from wip_prebill_lines
                      where id = '00000000-0000-7000-9000-000000002114');

  insert into wip_prebill_events (id, org_id, prebill_id, event_type, actor_id, details)
  select '00000000-0000-7000-9000-000000002121', v_org,
         '00000000-0000-7000-9000-000000002101', 'created', u.id,
         '{"sourceCount": 3}'::jsonb
    from (select id from users where email = 'viewspec@sim.test'
           order by id limit 1) u
   where exists (select 1 from wip_prebills
                  where id = '00000000-0000-7000-9000-000000002101')
     and not exists (select 1 from wip_prebill_events
                      where id = '00000000-0000-7000-9000-000000002121');

  insert into wip_prebill_events (id, org_id, prebill_id, event_type, actor_id, details)
  select '00000000-0000-7000-9000-000000002122', v_org,
         '00000000-0000-7000-9000-000000002101', 'line_updated', u.id,
         '{"reason": "ViewSpec write-down"}'::jsonb
    from (select id from users where email = 'viewspec@sim.test'
           order by id limit 1) u
   where exists (select 1 from wip_prebills
                  where id = '00000000-0000-7000-9000-000000002101')
     and not exists (select 1 from wip_prebill_events
                      where id = '00000000-0000-7000-9000-000000002122');
```

Notes for the coordinator:

- `wip_prebill_lines.disposition` (`bill`/`hold`) is NOT NULL but has no
  check constraint in this DB — values above are the lib's own literals.
- `wip_prebill_events.actor_id` is NOT NULL, hence the live harness-user
  lookup (no invented user id).
- The `Riverside Mall Facilities T&M` project is active with a `tm_actual`
  invoicing profile (prebilling-eligible) in the current SIM seed; if a
  reseed renames it, pick any active project whose type's
  `invoicing_profile` passes `sourceLinePrebillingReason(...) == null`.
- `created_by`/`updated_by` are nullable; set to the harness user for
  provenance only.

## 4. What the spec does NOT cover (deliberate — whole-workspace placement)

- No `sections.tsx`: the page defines no local server-rendered component.
  `DetailMetric` and `PrebillLine` are client-state components (`useState`,
  fetch mutations) inside `WipBillingWorkspace`, which is placed whole — the
  two render paths share the one implementation by construction.
- Interactive behavior (create/transition/convert/hold/release calls, drawer
  open state, line edit inputs, toast messages) is client behavior, identical
  on both paths because it is the same component. The harness compares the
  settled DOM, which covers the rendered output of that state.
- The workflow-reason inline form (`workflowAction`), the create drawer's
  field state, and the per-line hold forms are `useState` initialized to
  closed/empty — identical initial DOM on both paths.
- The `selected.status === "approved"` locked alert, the invoice link button,
  and the empty-state branches (`noProjects` vs `noPrebills`, gated on
  `projects.length`) all derive from loader data (presence, not branching).
- `useBusinessToday` (period-end default) and `useMoney` (formatting) are
  client context providers that wrap both paths equally; the loader does not
  re-format money because the workspace formats at render from the exact
  decimal strings the lib returns.
- `t('trail.system')` / `new Date(occurredAt).toLocaleString()` in the audit
  trail render client-side from loader data; no loader formatting involved.
- Every `t('projects.wipBilling.…')` key the spec path renders already exists
  (the native page uses the same namespace); the loader adds only the two
  header literals, which the native `page.tsx` hardcodes.

## 5. Anything else the coordinator should know

- The fixture SQL above is PROPOSED ONLY — `scripts/viewspec-fixtures.sql`
  is coordinator-owned, so I did not edit it or apply it. My `minMatches`
  counts are verified against the CURRENT live DB shape (0 prebills today)
  plus the proposed rows: after the coordinator applies §3, the default
  variant has exactly 2 list-table body rows and the drawer variant has the
  `…2101` worksheet's drawer. **The coordinator must re-verify counts after
  applying the fixtures.**
- If the coordinator prefers not to seed, the page still converts (both
  paths render the same empty state), but per the fixture-file header the
  harness refuses rowless comparisons — the entry above assumes seeded rows.
- `loadPrebill` returns `createdAt`/`occurredAt` as Date objects under node-pg
  (timestamptz); the loader normalizes them to ISO strings so the spec data
  is plain serializable JSON. The rendered instants are unchanged — the native
  path passes the same values through to the same component.
