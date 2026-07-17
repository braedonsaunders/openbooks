# openbooks schema design

Derived from a full extraction of NetSuite account 8638714 (see
`../extraction/`): 336-account COA, 4,195 custom objects, 247 saved searches,
transaction usage across 8 fiscal years. The goal is not to clone NetSuite's
schema — it's to keep its good ideas, fix its accumulated debt, and promote
the things Rassaun (and every services contractor) had to bolt on into
first-class concepts.

## Principles

1. **Two strictly separated layers.** *Documents* (invoices, bills, payments,
   expense reports) are the business layer — workflow-driven and editable
   while their accounting scope is open. The *ledger* (journal entries/lines)
   is their controlled accounting projection, derived by posting rules.
   NetSuite's `transaction` / `transactionline` /
   `transactionaccountingline` triple-decker blurs these; openbooks never
   does. Every posted document produces exactly one journal entry. An
   authorized open-period edit re-materializes that entry in place and writes
   complete before/after evidence atomically; closed-period corrections use a
   controlled reopening or a linked reversal.
2. **The GL balances by construction.** A deferred constraint enforces
   Σ(signed amount) = 0 per journal entry at commit time. No app-layer-only
   invariants.
3. **Dimensions are uniform and free.** Subsidiary, department, **project**,
   location, class are nullable FK columns on every journal line — one
   mechanism, not four (NetSuite: subsidiary ≠ department ≠ class ≠ custom
   segment, each with different behavior and pricing). Project is promoted to
   a core dimension: the extraction shows it's the center of the business
   (job costing, WIP, Account×Project pivots) yet NetSuite makes it a paid
   afterthought.
4. **Feature flags never change the schema.** Disabled features hide UI;
   tables always exist and queries always work. (NetSuite: querying
   `classification` in an account without Classes returns "Record not found".)
5. **One party model.** NetSuite has customer/vendor/employee/partner as
   separate tables with duplicated address/bank/contact subrecords and a
   fake union view (`entity`). openbooks has `parties` with role rows —
   the same real-world company can be customer and vendor without duplicate
   records; addresses and bank accounts are normalized child tables shared
   by all roles.
6. **Application is first-class and universal.** The extraction shows 3,577
   invoices paid with *zero* CustPymt transactions — receipts arrive as
   journals applied to invoices. NetSuite half-supports this through an
   opaque link table. openbooks: `applications` links any crediting line to
   any debiting line, with the invariant that applied ≤ open on both sides,
   regardless of document type.
7. **Readable status, explicit state machines.** No `'B' = Paid In Full`.
   Document status is a text enum; approval state lives in the workflow
   tables, not mixed into document status.
8. **Everything is auditable.** `created_by/at`, `updated_by/at` everywhere;
   `audit_log` is append-only and captures field-level business changes plus
   complete document and GL snapshots for posted amendments and deletions.
9. **Extensible without schema migration.** Custom fields = registry +
   validated JSONB (`custom` column on extensible tables), same plugin-
   framework philosophy as beaconhs. Rassaun's 319 bolt-on fields become
   either promoted columns (below) or registry entries — never orphaned XML.
10. **Multi-org from day one** (`org_id` on every row, Postgres RLS), even
    though Rassaun is single-entity today. Consolidation and intercompany
    eliminations get schema support (`eliminate` flag survives from the COA).

## What the extraction promoted to first-class

| NetSuite bolt-on (custom field/record) | openbooks concept |
|---|---|
| `custbody` project refs, "Available for Cost Allocation", job searches | `project_id` dimension on journal lines + documents |
| Labor Burden record (dept, period, %) + payroll JE flags | `labor_burden_rates` + journal `origin` tag (`payroll`, `burden`) |
| Time Type + Cost Multiplier custcols | `time_types(cost_multiplier)` |
| Entity Bank Details (52-field custom record) + approval workflow | `party_bank_accounts` (normalized) + standard approval on change |
| T&M vs fixed-price billing flags, "Final Invoice" | `billing_method` + `is_final` on invoice documents |
| WSIB Rate Group / Employee Trade lists | `worker_comp_groups`, `trades` reference tables |
| Approval fields (waiting-on, rejection note, reviewed) | `approval_requests` / `approval_steps` engine |
| NOTC / Code of Supply GST-HST lists, Tax Report Mapper | `tax_codes` + `tax_report_lines` mapping |
| Payment method / EFT notification fields | `payment_runs` + `payment_instructions` |
| 67 credit-card GL accounts (one per card!) | `payment_cards` subledger under ONE liability account |

That last row is the COA smell worth calling out: NetSuite's answer to
corporate cards was 67 GL accounts. openbooks models cards as a subledger
dimension (`payment_card_id` on lines) under a single "Corporate cards
payable" account — trial balance stays clean, per-card detail stays queryable.

## Layer map

```
reference   currencies, fx_rates, units
org         orgs, accounting_periods, fiscal_calendars, sequences
dimensions  departments, projects, locations, classes, (custom segments via registry)
coa         accounts (typed, hierarchical, summary/postable)
parties     parties, party_roles, addresses, contacts, party_bank_accounts
tax         tax_codes, tax_rates, tax_groups, tax_report_lines
documents   documents (header supertype), document_lines, applications,
            document_links (fulfillment/billing chains)
ledger      journal_entries, journal_lines  ← controlled-mutation kernel
approvals   approval_policies, approval_requests, approval_steps
extension   custom_field_defs, (JSONB `custom` on extensible tables), audit_log
```

## Kernel invariants (enforced in Postgres, not just app code)

- `journal_lines.amount` is **signed base-currency** (+debit / −credit);
  `SUM(amount) = 0` per entry via deferred constraint trigger.
- Foreign-currency lines carry `currency_code`, `fx_rate`, `txn_amount`;
  `amount = round(txn_amount × fx_rate)` checked.
- A journal entry is `draft → posted → (reversed)`. Posted writes are blocked
  by default. The guarded engine may re-materialize or delete an entry only
  while every affected scope is open and immutable audit evidence is written
  in the same transaction. Closed-period corrections use reopening or a new
  entry with `reverses_entry_id`.
- Line must reference a **postable, active** account (no posting to summary
  accounts — NetSuite allows posting to parents, which wrecks roll-ups).
- `period_id` derives from posting date and must be an **open** period for the
  posting module (per-module close: AR, AP, GL — a NetSuite idea worth keeping).
- Applications: `SUM(applied)` per target line ≤ line open amount, both sides
  same party unless cross-party flag (refund-to-third-party) is set.

## Scope: general-purpose, no account-shaped shortcuts

openbooks targets *the* world-class open-source accounting system, not a
Rassaun-shaped one. The extraction from a real account informs which flows
get the most UX polish first and validates the design against reality — it
never shrinks the schema. The full accounting surface ships in the initial
schema:

- **Inventory** (`inventory.ts`) — warehouse/bin stock locations, per-item
  costing profiles (FIFO / moving average / standard), cost layers with
  explicit consumption, lot & serial tracking, stock counts, landed costs.
  All valuation flows post through the same kernel.
- **Revenue recognition** (`revenue.ts`) — ASC 606 / IFRS 15 shaped:
  contracts → performance obligations (with SSP allocation) → recognition
  rules → period schedules that post `origin='revenue_recognition'` entries.
- **Fixed assets** (`assets.ts`) — asset register, per-book depreciation
  schedules, acquisition/depreciation/disposal/revaluation events, all
  posting through the kernel (replaces the locked FAM bundle).
- **Multi-book** (`core.ts`) — `accounting_books` is a real table (primary,
  tax, IFRS…); every journal entry belongs to a book; depreciation and rev
  rec schedules are book-aware from day one.
- **Banking** (`banking.ts`) — statement import, reconciliation sessions,
  statement-line ↔ journal-line matching, payment runs and EFT/ACH
  instruction generation.
- **Budgets & allocations** (`planning.ts`) — budget scenarios by
  account × period × dimensions; allocation rules (fixed percent,
  statistical-quantity, or proportional basis) that generate journals.
- **Time** (`time.ts`) — first-class time entries feeding job costing,
  billing (T&M chains), and payroll-import journals.
- **Multi-currency, fully** — spot/average/historical rate types for
  consolidation translation, FX gain/loss on settlement, CTA support.
- **Intercompany** — org pairs with due-to/due-from accounts;
  auto-balancing entries and elimination flags for consolidation.

One boundary is a product decision, not a shortcut: openbooks **imports**
payroll (journals + burden via `origin='payroll'`) rather than running
payroll calculation — payroll tax engines are a jurisdiction-specific
product of their own (as with every ERP incumbent, incl. NetSuite CA).
The schema holds everything payroll needs to land cleanly.

## Open questions (tracked, not blocking)

- Whether `expense_reports` warrant their own document subtype table or ride
  `documents` + lines with `kind='expense_report'` (current draft: the latter;
  8.4k lifetime usage says make the UX great, but schema-wise it's a bill
  from an employee party).
- Sequences: per-org per-document-type, gapless-optional (legal requirement
  varies by jurisdiction; CRA doesn't require gapless, so default fast
  sequences with an optional gapless mode).
