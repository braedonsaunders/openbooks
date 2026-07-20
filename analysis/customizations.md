# NetSuite customization analysis — what Rassaun bolted on

Distilled from the SDF extraction (600 unlocked objects). These are the
things NetSuite couldn't do natively for a services contractor — each is
either promoted to a first-class openbooks concept, kept as a custom-field
registry entry, or dropped as an implementation artifact. Schema decisions
are reflected in `../schema/DESIGN.md`.

## Transaction body fields (43) by domain

**Project/job tracking** — Available for Cost Allocation, Billed From
Project, Salesorder JSON (denormalization workaround). → `project_id`
dimension + document/line project columns.

**Labor & payroll** — Labor Burden Journal, Is Labor Burden JE, Payroll
Start/End Date, Payroll Journal flag, Timesheets JSON. → journal `origin`
enum (`payroll`, `labor_burden`) + `labor_burden_rates` + `time_entries`.

**Billing & invoicing** — Final Invoice, Reference No. of Original Invoice,
Invoice Backup Required/Type, Invoice Billed as T&M, Display Invoice As T&M,
Display Line Items on PDF, Hide Line Items (likely dead — verify which of
the two flags is live), Invoice Internal Notes, Include All Credits.
→ `billing_method`, `is_final_invoice`, `internal_notes`, print options in
document render settings.

**Purchases & payments** — Bill Allocated, SO Created From (→
`document_links`), Payment Method, Prepay + Prepay Date, Vendor Comments,
Expected Pay Date, Payment Hold Note. → promoted document columns
(`expected_pay_date`, `payment_hold_reason`) + `payment_runs`.

**Banking/EFT** — Entity Bank Details (textarea!), EFT Email Sent, Cash
Register flag. → `party_bank_accounts` + `payment_instructions`
(remittance email tracking).

**Approvals** — Reviewed, Waiting approval from, Needs Review, Rejection
Note, Hide Memo On Timesheet. → Flows engine (`flows`/`flow_runs`/`flow_gates`)
+ `time_entries.memo_is_private`.

**Compliance** — Tax Total, FA Number, Nature of Transaction Code (GST/HST),
Reimbursement Paid Out. → tax schema + fixed-asset provenance links.

## Line/column fields (11)

Employee, Timesheet Number, Time Type, Cost Multiplier, Is Billable, Line
Invoiced, Item Category, Project Task Placeholder, PM Review + Notes,
Statistical Value. → ALL promoted: `document_lines.employee_id /
time_entry_id / time_type_id / cost_multiplier / is_billable /
billed_by_line_id` + `project_tasks`.

## Entity fields (26)

**Employee/HR**: Phone Extension, Has Benefits, Billed Out Percentage
Expectation, Vacation Allotment, Vacation Approval Stages, WSIB Rate Group
(002/003/375/704/707/737/755 by trade), Employee Trade (19 values), NAICS
Code, Default Absence Payroll Item, Paymate Employee ID (legacy — Harmony
PayMate). → `employee_roles` + `trades` + `worker_comp_groups`.

**Customer/vendor**: Shortform (→ `parties.short_code`), Sales
Representative, Vendor Payment Method, EFT Payment Notification Email.
→ role tables.

**Project**: Project Notes, Foreman, PO Number/Issuer/File, Internal Billing
Project ID, Fiscal Year, FY Increment, Rate ID. → `projects` table.

**Compliance**: TSSA Number. **Legacy**: Legacy AdminApp ID (migration
artifact — keep as registry field during parallel-run, then drop).

## Custom records worth carrying (of 55)

- **Entity Bank Details** (52 fields, Electronic Bank Payments bundle
  companion) → normalized `party_bank_accounts` with approval gating.
- **Labor Burden** (dept, period, burden %) → `labor_burden_rates`.
- **Time Type** → `time_types`.
- **Nature of Transaction Codes** + **Tax Report Mapper** →
  `tax_report_lines`.
- Project Requirements / Milestones / Risks (NetSuite PS bundle) → app-layer
  project module later; schema has `project_tasks` now.
- ~30 records are implementation artifacts (cutover trackers, UAT, test
  cases, meeting notes) — do not migrate.

## Custom lists worth carrying (of 53)

WSIB Rate Group (8), Employee Trade (19), NAICS (6), Item Category (10 —
Absence/Consumables/Equipment/Labor/Services), Delivery Terms/Incoterms (17),
Code of Supply (11, GST/HST), Burden Categories (5), Burden Costing Type
(3-Year Average vs Live → `labor_burden_rates.method`).

## Workflows (18) — what the approval engine must reproduce

- Vendor Bill Approval (5 states, multi-level: initiator → manager →
  controller), Vendor Payment Approval (5), Expense Report Approval
  (2 variants, 5–8 states), Journal Entry Approval (4).
- Bank-details change approval (4 states) + payment-file approval (6) —
  fraud controls on the EFT chain.
- EFT payment email notification; auto-set Reviewed; auto-calc Tax Total;
  Return Authorization (4).
- Notable: a workflow exists solely to HIDE NetSuite's rev-rec UI.

## Roles (23)

Finance: AP Analyst, AR Analyst, Accounting Analyst, Accounting Manager,
Controller, CFO. Ops: Inventory Manager, Purchasing. Sales/projects: Sales,
Sales Manager, Project Manager, Resource Manager. General: Executive,
Employee Center ×2, Main Office ×2. System: Web Services Only, Project
Financials, Implementation Team. → seed set for openbooks RBAC.
