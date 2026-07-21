import type { DocArticle } from '../types'

export const laborRates: DocArticle = {
  slug: 'labor-rates',
  title: 'Labor Rates, Burden, and Billing',
  category: 'projects',
  order: 3,
  summary: 'Configure effective-dated labor cost, burden, billing, transfer, and planning rates with explainable approval snapshots.',
  updated: '2026-07-21',
  keywords: ['labor', 'labour', 'rate', 'union', 'construction', 'overtime', 'burden', 'billing', 'transfer price', 'standard cost', 'payroll'],
  related: ['item-rates', 'overhead-costing', 'project-types'],
  body: `# Labor Rates, Burden, and Billing

OpenBooks uses one effective-dated rate engine for employee cost, customer
billing, internal transfer pricing, and project planning. It keeps these values
separate because they answer different questions:

- **direct cost** estimates wages or compensation;
- **burden** adds employer taxes, benefits, insurance, pension, union costs,
  tooling, and overhead;
- **bill** is the customer-facing price;
- **transfer** is the price used between internal entities or teams; and
- **planning cost** and **planning bill** support forecasts without changing
  approved actuals.

Every approved time entry keeps the exact rate version, component amounts,
currency conversion, and explanation used. Later configuration changes never
rewrite that evidence.

---

## Use the guided setup

Open **Settings → Company Setup → Workforce → Labor Costing Guide**. The guide
walks through four decisions in order: install or select a starter rate book,
set the company accounting fallback, apply defaults to project types, and choose
how external payroll actuals reconcile. It does not hide configuration; a
starter creates the same editable records available in the detailed setup pages.

## Start from a template

Open **Settings → Company Setup → Workforce → Labor Rate Templates**. Choose a
starter that resembles your operating model:

- **Professional services** creates consultant, senior, and principal role rates.
- **Construction and union labor** creates apprentice, journey worker, and
  foreperson wages; 1.5× and 2× time types; payroll tax, health and welfare,
  pension, workers compensation, and cost-plus billing.
- **Field service and equipment operators** creates operator and technician
  rates, emergency callout premiums, field overhead, PPE and small-tool burden,
  and an internal transfer rate. Configure the equipment charge itself under
  **Items & Services → Item rates**.
- **Blended crew cost plus** creates a simple blended cost, target-margin bill
  rate, and separate planning rates.

Set the rate-book code, name, currency, and first effective date. Applying a
template creates ordinary tenant-owned records in **Draft** status. Nothing is
activated or posted automatically. Review and edit every generated value before
activation.

Use **Test a Labor Rate** to preview a real employee, project, time type,
department, location, work date, hours, and billable choice. The tester performs
no write: it shows the winning book/version and every rule, component, rate, and
explanation that approval would snapshot.

---

## Build the workforce dimensions

Use the Workforce section of Company Setup:

1. **Labor Classes** define roles, trades, grades, or crew positions.
2. **Employee Labor Classes** assign a class to an employee for an effective
   date range. Historical time continues to use the class valid on its work date.
3. **Employee Standard Cost** optionally stores effective-dated hourly or annual
   compensation. It is the direct-cost fallback when no matching direct-cost
   rule exists.
4. **Time Types** define independent cost and billing multipliers. For example,
   overtime may be **1.5** for both, while a nonbillable leave type can retain a
   cost multiplier and no billable default.
5. **Worker Comp Groups** and ordinary subsidiary, department, and location
   dimensions can further qualify a rate.

Overlapping active employee class or compensation ranges are rejected. This
prevents two equally valid histories from silently producing different costs.

---

## Create a rate-book version

Create the header in **Rate Books**, then create a **Rate Book Version**. Versions
begin as **Draft**. Add **Labor Rate Rules** and **Labor Burden Components** while
the version is draft; activate only after review. An active or retired version
and all its lines are immutable. Future changes belong in a new effective-dated
version.

Two active versions may not cover the same date for one book. Approval also
refuses ambiguous overlaps instead of choosing one silently.

### Rate rules

A rule selects a lane and a method:

| Lane | Common use |
| --- | --- |
| **Direct cost** | Base wage, standard employee cost, or trade rate |
| **Customer billing** | Fixed sell rate or price derived from burdened cost |
| **Internal transfer** | Cross-entity or cross-department charge |
| **Planning cost** | Forecast cost independent from actual standard cost |
| **Planning bill** | Forecast revenue rate |

**Fixed hourly rate** stores an amount. Billing, transfer, and planning rules may
instead use **At burdened cost**, **Markup on burdened cost**, or **Target margin
on burdened cost**. A 25% markup and a 25% margin are not the same: markup divides
profit by cost, while margin divides profit by price.

Optionally qualify a rule by employee, labor class, item, time type, subsidiary,
department, location, or worker compensation group. A blank dimension is a
wildcard. The highest priority wins; within one priority, the most specific rule
wins. Equal-priority, equal-specificity matches are blocked as ambiguous.

### Burden components

Components are applied in sequence and remain visible in the approval
explanation. Choose a fixed amount per hour or a percentage of:

- **base direct** before a time multiplier;
- **adjusted direct** after the multiplier; or
- **running subtotal**, which compounds after prior components.

This distinction matters for union premiums and statutory burdens. A pension
based only on straight-time wages should use base direct; a tax that applies to
overtime wages should use adjusted direct; an insurance levy on wages plus
benefits should use the running subtotal.

---

## Company, project, and item inheritance

Configuration resolves in deliberate layers:

1. an explicit book on the **Project**;
2. a targeted, effective-dated **Rate Book Assignment**;
3. the default book and policy on the **Project Type**; and
4. the default book and policy in **Company & Accounting**.

Within the selected book, employee, class, item/service, time type, subsidiary,
department, location, and worker-compensation dimensions select the winning
rule. This is why an item override does not change the project's commercial
agreement: it only specializes a rule inside the already selected book.

For a service, labor, or equipment-charge item, open its **Items & Services**
flyout and use **Labor and service rate overrides**. Choose an editable draft
version and add the item-specific cost, bill, transfer, or planning rule. A high
priority makes the override explicit and reviewable. Activation still happens
at the rate-book version level, preserving effective dating and approval.

## Assign the rate book

Use **Rate Book Assignments** to match a book by any combination of customer,
project, project task, subsidiary, department, and location, plus a priority and
effective range. A project-level override takes precedence. Otherwise the engine
chooses the highest-priority, most-specific matching assignment, then the
project-type default, and finally the single company default.

The project policy controls version timing:

- **Work date** uses the version effective on each time-entry date.
- **Locked** selects one version when project time is first approved.
- **Scheduled escalation** follows effective dates for planned increases.
- **Manual reprice** keeps a locked version until an authorized project change.

---

## Approval and accounting controls

Timesheet approval is one database transaction. OpenBooks resolves every
submitted entry, stores its rate and component explanation, posts project labor,
and changes the entries to **Approved** together. Missing cost, missing bill
price for billable work, missing FX, ambiguity, a closed period, or missing labor
control accounts rejects the whole approval; it never leaves approved but
uncosted time.

Configure **Labor WIP** and **Labor clearing** under **Company & Accounting →
Control accounts**. Project time posts by work date and subsidiary:

- debit **Labor WIP** by project for direct cost plus burden; and
- credit **Labor clearing** for the same amount.

Non-project time still receives its rate snapshot but does not post to project
WIP. Billing uses the separate snapshotted bill rate.

---

## Reconcile external payroll actuals

Open **External Payroll Costs** in Workforce Setup. OpenBooks does not calculate
payroll in this phase. The external payroll system remains responsible for gross
pay, deductions, taxes, liabilities, and cash. Integration uses two related but
separate imports:

1. Import the external payroll **journal** through **Data Import → Journal
   entries**. The governed journal path validates dimensions, balances exactly,
   respects open periods, and deduplicates the external reference.
2. Import employee-level employer-cost detail into an **External Payroll Cost
   Batch** using stable external line IDs and a saved source column mapping.
   Detail may identify **Gross pay**, **Employer tax**, **Benefit**, **Workers
   compensation**, or **Other**.

Choose **Validate** before allocation. In variance mode, validation requires a
posted source journal for the same subsidiary and proves that its debit to the
configured payroll-clearing account equals the imported employer-cost total.
This prevents the detail file and the books from drifting or being counted
twice. **Project costing only** mode skips this GL proof and never posts a
variance journal.

Choose **Reconcile** to allocate every component across the employee's approved
project and task time by hours, preserving project, task, department, and
location. Four-decimal largest-remainder allocation makes the rows equal the
source exactly, including negative adjustments. The batch compares actual cost
with the standard direct and burden amount posted at approval.

In **Variance to clearing** mode, the final action posts only the difference to
project WIP/cost and payroll clearing. It does not repost wages, employer taxes,
liabilities, or cash already present in the external journal. Draft lines freeze
at validation, allocations freeze at reconciliation, and posting is idempotent.

---

## Review checklist before activation

- Test regular, overtime, and double-time examples for each labor class.
- Confirm whether every burden uses base direct, adjusted direct, or subtotal.
- Compare markup and margin results with an independently calculated example.
- Test billable and nonbillable time.
- Test boundaries on every effective date and assignment date range.
- Test each transaction currency and confirm the required daily FX rate exists.
- Confirm labor control accounts and open periods before the first approval.
- Activate the version only after sign-off; create a new version for later changes.
`,
}
