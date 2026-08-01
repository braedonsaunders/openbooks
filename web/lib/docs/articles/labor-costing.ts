import type { DocArticle } from "../types";

export const laborCosting: DocArticle = {
  slug: "labor-costing",
  title: "Labor Costing",
  category: "projects",
  order: 3,
  summary:
    "Configure labor cost using effective-dated wages, payroll estimates, standard-cost posting, and payroll variance reconciliation.",
  updated: "2026-07-21",
  keywords: [
    "labor",
    "labour",
    "wages",
    "currency",
    "foreign exchange",
    "cost rate",
    "overtime",
    "payroll",
    "burden",
    "per diem",
    "variance",
    "clearing",
    "timesheets",
  ],
  related: ["overhead-costing", "labor-pricing", "project-types"],
  body: `# Labor Costing

Job labor cost consists of three components with distinct accounting treatment:

1. **The wage** — employee compensation. It posts to the job as general-ledger
   cost, initially at a standard rate and subsequently reconciled to payroll
   actuals.
2. **Estimated direct payroll burden** — employer statutory costs the wage
   causes (CPP, EI, WSIB, EHT and vacation pay in Canada; FICA, FUTA, SUTA and
   workers comp in the US). This is an *estimating input only* used to estimate
   pre-payroll job cost. Payroll journals replace the estimate with actual
   employer costs.
3. **Overhead** — the allocated share of indirect company costs. This is a
   separate, permanent layer configured in the **Overhead Model** and is
   never part of the labor rate. See *Setting Up Overhead Costing*.

Company-wide fallbacks and posting configuration live at **Setup → Workforce
→ Labor Costing**. Each employee's confidential wage history lives on the
employee record under **Wage rates**.

The workspace opens on the settings page. Choose **Setup guide** to use the
optional guided flow for burden, wage fallback, and posting choices. The guide
opens in a drawer only when selected.

## Wage rates

Rates are effective-dated and resolve most-specific-wins:

| Scope | Applies when |
|---|---|
| **Employee** | A rate exists for the person on the work date |
| **Job title** | No employee rate; the employee's job title has one |
| **Trade** | No higher-priority rate; the employee's trade has one |
| **Department** | No higher-priority rate; the employee's department has one |
| **Subsidiary** | No higher-priority rate; the employee's primary subsidiary has one |
| **Org default** | None of the above |

Starting a new rate automatically closes the previous one on the preceding day,
which prevents overlapping effective periods. Salaried staff use the *per year*
basis; the hourly wage is salary ÷ annual hours (2080 by default, configurable).

Each rate keeps its own **Currency**. When the organization and its active
subsidiaries use more than one configured base currency, the rate drawer and
employee wage editor show a currency selector. A subsidiary-scoped rate
defaults to that subsidiary's base currency; employee rates default to the
employee's primary subsidiary currency. Single-currency organizations do not
display the selector.

At approval, a wage is converted to the project's subsidiary functional
currency using the latest **spot FX rate on or before the work date**. Entries
without a project fall back to the employee's subsidiary, then the organization.
Approval stops if no applicable rate exists; OpenBooks never silently treats
unlike currencies as equal. The time entry retains the source hourly wage,
wage currency, FX rate, resolved wage-rate ID, functional currency, and
resulting cost rate, so the posting remains auditable after rates change.

Use search plus the **Scope** and **Status** filters to narrow the company-wide
wage-rate table. Choose **Add rate** to create a fallback in a drawer, or select
any row to edit its amount, basis, notes, or end date. Deleting an incorrect
rate is also contained in that rate's drawer. The table is paginated, and its
filters remain in the URL so refreshes and shared links preserve the view.

To add a person's wage or raise, open **Operations → Employees**, select the
employee, and open **Wage rates**. The table keeps the complete effective-dated
history; the current row is highlighted. You can end the current rate today or
delete an incorrect rate. Access requires the **Manage setup** permission.

Wage data is confidential. Project screens display the blended standard cost
rate and do not expose individual compensation.

## Estimate components

Components stack on top of the wage to form the standard cost rate:

- **% of wage** — a statutory-burden estimate based on the organization's
  applicable payroll obligations. Choose whether it scales with overtime.
- **Amount per hour** — flat hourly adders configured in the organization base
  currency and converted to the applicable subsidiary functional currency.
- **Amount per day** — per-diem style allowances configured in the organization
  base currency, converted to functional currency, and prorated by your
  hours-per-day.

The live example under the editor calculates regular, overtime, and double-time
rates from the following formula:

    cost/hr = wage × time-type multiplier + components

Time types (Setup → Workforce → Time Types) carry the cost and bill
multipliers, such as overtime ×1.5 and double time ×2. These values are
configurable.

## Posting standard cost to jobs

With posting **on** and the two accounts mapped, approving a timesheet:

1. Snapshots the resolved cost rate onto each entry (imported entries that
   already carry a rate are never touched).
2. Posts **DR labor WIP (by project) / CR labor clearing** at the standard
   rate.

Approvals containing more than one subsidiary produce separate balanced labor
journals per subsidiary and functional currency. Amounts are never combined
into a journal belonging to another legal entity or currency.

Posting remains inactive until the required accounts and options are configured.
A posting failure does not block timesheet approval; affected entries remain
eligible for a subsequent posting attempt.

Selling rates now live in the separate **Administration → Labor Pricing**
workspace. See *Labor Pricing* for multi-currency rate cards, overtime tiers,
markups, applicability, and negotiated terms.

## The payroll true-up

Payroll runs in your payroll system; its accounting journal enters OpenBooks
as an ordinary journal — imported through **Data → Import** or entered
manually — debiting the **labor clearing** account (and the real statutory
burden accounts) that the standard postings credited.

The **Payroll reconciliation** card shows the clearing-account reconciliation
for any period and subsidiary. Each subsidiary is reconciled and variance-posted in its own
functional currency; unlike currencies are never summed together:

- **Standard labor posted** — what approvals credited to clearing
- **Payroll actuals matched** — what payroll debited
- **Period variance** — standard cost less payroll actuals
- **Clearing balance** — all-time; should trend to zero

The **Post variance** action transfers the period variance from clearing to the
**payroll variance account**. Repeating the action reverses the prior variance
entry before posting the replacement.

## Worked example

Electrician, $38/hr wage, 14% burden estimate (scales with OT), $60/day per
diem, 8-hour days:

| | Regular | Overtime ×1.5 | Double ×2 |
|---|---|---|---|
| Wage | 38.00 | 57.00 | 76.00 |
| Burden 14% | 5.32 | 7.98 | 10.64 |
| Per diem 60/8 | 7.50 | 7.50 | 7.50 |
| **Cost rate** | **50.82** | **72.48** | **94.14** |

Bill-out from the customer's rate card: $102 regular, $130 overtime
(explicit), so margin is available by tier before payroll processing.
`,
};
