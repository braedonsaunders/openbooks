import type { DocArticle } from '../types'

export const projectTypes: DocArticle = {
  slug: 'project-types',
  title: 'Project Types',
  category: 'projects',
  order: 1,
  summary:
    'Configure how each class of project is costed, priced, invoiced, and backed up — the profitability, invoicing, and backup profiles behind every project.',
  updated: '2026-07-20',
  keywords: [
    'project type',
    'profitability',
    'invoicing',
    'backup',
    'overhead',
    'billing method',
    'fixed price',
    'time and materials',
    'cost plus',
    'not to exceed',
    'P&L',
    'markup',
    'NetSuite',
  ],
  body: `# Project Types

A **project type** is the configurable classification that drives a project's
profitability, invoicing, and backup behaviour. Instead of hardcoding "fixed
price vs. time & materials" everywhere, each project points at a project type,
and that type carries three profiles:

- **Profitability** — how each P&L measure is sourced or derived, plus the order
  of the P&L statement shown on a project's Financials tab.
- **Invoicing** — how invoice lines are built, which account they credit, and how
  revenue is recognized.
- **Backup** — whether an invoice needs a backup package and what it contains.

You manage project types under **Settings → Company Setup → Project
Types**. Four built-in types ship with world-class defaults you can use as-is or
duplicate and tune: **Time & Materials**, **Fixed Price**, **Cost-Plus**, and
**Not-to-Exceed**.

---

## General

The **General** tab holds the type's identity and defaults:

- **Name** and **Key** — the display name and a stable key. The key is generated
  from the name if you leave it blank; keep it stable once projects use the type.
- **Description** — shown to users when they pick a type on a project.
- **Billing method** — the legacy method (**time_and_materials**, **fixed_price**,
  **cost_plus**) this type maps to. It is kept for backwards compatibility; the
  profiles below are what actually drive behaviour.
- **Sort order** and **Status** — ordering in pickers and whether the type is
  selectable.

---

## Profitability profile

The Profitability tab defines how every number on a project's mini P&L is
computed. Each measure has a configurable **source**.

### Price and backlog

- **Total price method** — how the contract/selling price is determined:
  - **Contract Field** — the fixed contract value entered on the project.
  - **Billable Value** — the statistical value of all billable work (used for
    time & materials).
  - **Not To Exceed** — billable value capped at the contract value.
  - **Cost Plus** — cost times one plus the markup percent.
- **Could-be-invoiced formula** — the backlog definition:
  - **Price Minus Invoiced** — contract price less what has been invoiced.
  - **Unbilled Billable** — the value of billable work not yet invoiced.

### Cost sources

- **Actual cost source** — where posted cost comes from:
  - **Account Types** — sum posted GL to a set of account types (expense, COGS…).
  - **Account Group** — sum posted GL to a named account-group dimension (for
    example a **cost_pool** classification). Account groups are configured under
    **Company Setup → Account Groups**.
- **Labor cost source** — how labor cost is measured: **In Actual Cost** (already
  included in actual cost), **Time Rate** (hours times cost rate), **Payroll JE**
  (from posted payroll journals), or **Account Group**.
- **Overhead method** — each job's share of the cost of running the company. This
  is a STATISTICAL, managerial number on the project P&L — never a ledger posting
  (the real indirect costs are already expensed in the GL; posting overhead onto
  jobs too would double-count). Methods:
  - **None** — no overhead on this type.
  - **Percent Of Labor** — labor cost times a flat percentage.
  - **Per Labor Hour** — project hours times a flat dollar rate.
  - **Rate Engine** — per-department hourly rates applied to the project's
    labor, using the rate effective on each time entry's work date. Rates come
    only from the published, effective-dated rate card (**Company Settings →
    Projects → Overhead Rates**), so job costs are stable and closed periods
    never change. The **Overhead Model** workspace (Company Settings →
    Projects) computes each department's rate from actuals — overhead pool
    divided by labor hours — as an analytical preview; **Publish rates**
    locks those into the rate card, and the **Setup wizard** walks through
    method, rates, and which project types to apply in one pass.
  - **Account Group Actual** — legacy: sum project-tagged GL posted to an
    overhead account group.
- **Cost budget source** — **Wbs Estimates** (roll up the project's work-breakdown
  estimates) or **None**.
- **Committed cost from** — which open documents count as committed: **Purchase
  Order**, **Sales Order**, or both. The committed amount is the unbilled
  remainder of those documents.
- **Total cost components** — which base measures sum into **Total cost**
  (actual cost, committed cost, labor cost, overhead). Only select a component once,
  so you do not double-count — for example, do not add **Labor Cost** separately
  if labor is already inside **Actual Cost**.

### P&L statement layout

The **P&L statement layout** editor controls the exact rows shown on a project's
Financials tab, in order. Each line has:

- a **measure** (Invoiced to date, Total job price, Actual cost, Gross profit, …), and
- a **variant** — **Line** (a normal row), **Subtotal** (an emphasized running
  subtotal), or **Total** (the bottom-line figure).

Use the up/down controls to reorder, the remove control to delete a line, and
**Add line** to append one. A typical layout runs revenue rows, a price subtotal,
cost rows, a cost subtotal, budget rows, then a gross-profit total.

---

## Invoicing profile

The Invoicing tab controls how invoices are generated for projects of this type:

- **Allowed bases** and **Default basis** — which billing bases the request form
  offers (date range, draw amount, time selection, milestone) and which is
  preselected.
- **Line builder** — how invoice lines are constructed: **T&M Actual** (one line
  per unbilled billable entry), **Milestone**, **Draw**, or **Cost Plus**.
- **Revenue account** — which account invoice lines credit: the item's income
  account, an **unbilled receivable** (contract-asset) account, or a fixed
  account.
- **Recognition** — the revenue-recognition policy: **As Invoiced**, **Percent
  Complete (cost)**, or **Milestone**.

### Invoicing preference cascade

The type supplies the defaults, but a customer or an individual project can
override the overridable subset (default basis, backup required, backup format,
invoice template). Overrides resolve in this order, most specific wins:

~~~
project type  →  customer  →  project
~~~

So a type might default to time-selection billing with costed-timesheet backup,
a particular customer might require purchases-only backup, and one of that
customer's projects might override the default basis again. Set customer-level
preferences on the customer record; set project-level preferences on the project.

---

## Backup profile

The Backup tab controls the invoice backup package — the supporting pages
attached to an invoice:

- **Required** — whether an invoice for this type needs backup by default.
- **Default backup type** — the default package format (costed timesheets,
  timesheets + purchases, purchases only, purchases + shop time, quote only, none).
- **Allowed backup types** — the formats a user may choose from on the billing
  request. The request form is constrained to this set.

Because backup settings flow through the same cascade as invoicing, a customer or
project can require backup even when the type does not, or narrow the allowed
formats further.

---

## Reproducing a legacy costing model

Because every measure source is configurable, a project type can be tuned to
match an external system to the penny. The general approach:

1. Set **Invoiced to date** to count the same customer documents the legacy
   system counts.
2. Point **Actual cost** (and **Overhead**) at the account groups that mirror the
   legacy cost pools.
3. Choose the **Total price method** and **Could-be-invoiced formula** that match
   the legacy definitions.
4. Confirm the numbers against a sample of known projects before relying on them.

If you are migrating from a system that applies overhead as a per-labor-hour rate
by department, use the **Rate Engine** method with the **standard** rate source and
import (or enter) your historical rates on the Overhead Rates card — effective
dating means past periods keep their original rates to the penny.
`,
}
