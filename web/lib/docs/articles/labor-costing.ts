import type { DocArticle } from "../types";

export const laborCosting: DocArticle = {
  slug: "labor-costing",
  title: "Labor Costing",
  category: "projects",
  order: 3,
  summary:
    "What an hour of labor costs and how it reaches your jobs: effective-dated wages, estimate components that anticipate payroll, standard-cost posting, bill-out rate tiers, and the payroll true-up.",
  updated: "2026-07-21",
  keywords: [
    "labor",
    "labour",
    "wages",
    "currency",
    "foreign exchange",
    "cost rate",
    "bill rate",
    "overtime",
    "payroll",
    "burden",
    "per diem",
    "variance",
    "clearing",
    "timesheets",
  ],
  related: ["overhead-costing", "item-rates", "project-types"],
  body: `# Labor Costing

An hour of job labor carries three numbers with three different fates:

1. **The wage** — real money you pay the employee. It posts to the job as real
   GL cost, first at a standard rate that *anticipates* payroll, then anchored
   by payroll actuals.
2. **Estimated direct payroll burden** — employer statutory costs the wage
   causes (CPP, EI, WSIB, EHT and vacation pay in Canada; FICA, FUTA, SUTA and
   workers comp in the US). This is an *estimating input only*: it makes
   pre-payroll job cost realistic, and it **dissolves** when the payroll
   journal posts the real employer costs.
3. **Overhead** — the job's fair share of running the company. That is a
   separate, permanent layer configured in the **Overhead Model** — it is
   never part of the labor rate. See *Setting Up Overhead Costing*.

Company-wide fallbacks and posting configuration live at **Setup → Workforce
→ Labor Costing**. Each employee's confidential wage history lives on the
employee record under **Wage rates**.

The workspace always opens on the ordinary settings page. Choose **Setup
guide** when you want the optional guided flow for burden, wage fallback, and
posting choices; the guide opens in a drawer and never launches on its own.

## Wage rates

Rates are effective-dated and resolve most-specific-wins:

| Scope | Wins when |
|---|---|
| **Employee** | A rate exists for the person on the work date |
| **Job title** | No employee rate; the employee's job title has one |
| **Trade** | No higher-priority rate; the employee's trade has one |
| **Department** | No higher-priority rate; the employee's department has one |
| **Subsidiary** | No higher-priority rate; the employee's primary subsidiary has one |
| **Org default** | None of the above |

Starting a new rate automatically closes the previous one the day before — no
overlaps, ever. Salaried staff use the *per year* basis; the hourly wage is
salary ÷ annual hours (2080 by default, configurable).

Each rate keeps its own **Currency**. When the organization and its active
subsidiaries use more than one configured base currency, the rate drawer and
employee wage editor show a currency selector. A subsidiary-scoped rate
defaults to that subsidiary's base currency; employee rates default to the
employee's primary subsidiary currency. Single-currency organizations do not
see a redundant selector.

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

Wage data is confidential: project screens only ever show the blended
standard cost rate, never anyone's pay.

## Estimate components

Components stack on top of the wage to form the standard cost rate:

- **% of wage** — the typical statutory-burden estimate (Canadian shops often
  land near 12–15%; US construction 25–40%). Choose whether it scales with
  overtime.
- **Amount per hour** — flat hourly adders configured in the organization base
  currency and converted to the applicable subsidiary functional currency.
- **Amount per day** — per-diem style allowances configured in the organization
  base currency, converted to functional currency, and prorated by your
  hours-per-day.

The live example under the editor shows the resulting regular / overtime /
double-time rates as you type, so the math is never a mystery:

    cost/hr = wage × time-type multiplier + components

Time types (Setup → Workforce → Time Types) carry the cost and bill
multipliers (overtime ×1.5, double ×2 — yours to define).

## Posting standard cost to jobs

With posting **on** and the two accounts mapped, approving a timesheet:

1. Snapshots the resolved cost rate onto each entry (imported entries that
   already carry a rate are never touched).
2. Posts **DR labor WIP (by project) / CR labor clearing** at the standard
   rate.

Approvals containing more than one subsidiary produce separate balanced labor
journals per subsidiary and functional currency. Amounts are never combined
into a journal belonging to another legal entity or currency.

Everything is inert until you configure it, and posting problems never block
an approval — entries stay re-postable.

## Bill-out rates

Billing is the rate-book system's job (see *Item Rate Books*): assign books
per customer or project, version them by date. For labor, each rate line can
carry **explicit per-time-type rates** (your reg/OT/DT card, per item, per
customer). When no explicit tier rate exists, the line's bill rate × the time
type's bill multiplier applies. Approval stamps the resolved rate on the
entry; invoicing uses it as before.

The **Bill-out rate cards** tab is the labor-focused view of the shared rate
book engine. A card retains its currency and effective period, regular/
overtime/double-time prices for each labor item, customer and project
assignments, dimension scopes, general adjustments, and ordered negotiated
terms. Customer schedules may resolve by usage date or lock to the project's
start date.

Adjustments are deliberately general. A negotiated surcharge is a
**percentage adjustment** in the **Surcharge** category, not a special setting
or permanent field. Per-diem, travel, minimums, allowances, and future contract
rules use the same auditable model. Link an adjustment to an item when it only
applies to that service; leave the item blank for the whole card. Supported
calculation methods are percentage, fixed, hourly, daily, distance, time, and
informational text.

Choose **Create revision** in the card drawer to change adjustments. OpenBooks
copies the base item rates, scopes, and negotiated terms into a new version and
ends the prior version the day before the new effective date. Historical cards
remain read-only, so a later adjustment never rewrites time or invoices that
used the prior version.

## The payroll true-up

Payroll runs in your payroll system; its accounting journal enters OpenBooks
as an ordinary journal — imported through **Data → Import** or entered
manually — debiting the **labor clearing** account (and the real statutory
burden accounts) that the standard postings credited.

The **Payroll reconciliation** card shows the wash for any period and
subsidiary. Each subsidiary is reconciled and variance-posted in its own
functional currency; unlike currencies are never summed together:

- **Standard labor posted** — what approvals credited to clearing
- **Payroll actuals matched** — what payroll debited
- **Period variance** — the residue (standard − actual)
- **Clearing balance** — all-time; should trend to zero

One click posts the period's variance out of clearing to the **payroll
variance account** — re-runnable safely if payroll lands late (each re-post
reverses the prior one first).

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
(explicit), so margin is visible per tier before payroll ever runs.
`,
};
