import type { DocArticle } from '../types'

export const laborCosting: DocArticle = {
  slug: 'labor-costing',
  title: 'Labor Costing',
  category: 'projects',
  order: 3,
  summary:
    'What an hour of labor costs and how it reaches your jobs: effective-dated wages, estimate components that anticipate payroll, standard-cost posting, bill-out rate tiers, and the payroll true-up.',
  updated: '2026-07-21',
  keywords: ['labor', 'labour', 'wages', 'cost rate', 'bill rate', 'overtime', 'payroll', 'burden', 'per diem', 'variance', 'clearing', 'timesheets'],
  related: ['overhead-costing', 'item-rates', 'project-types'],
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

Everything below lives on one screen: **Setup → Workforce → Labor Costing**.

## Wage rates

Rates are effective-dated and resolve most-specific-wins:

| Scope | Wins when |
|---|---|
| **Employee** | A rate exists for the person on the work date |
| **Trade** | No employee rate; the employee's trade has one |
| **Org default** | Neither of the above |

Starting a new rate automatically closes the previous one the day before — no
overlaps, ever. Salaried staff use the *per year* basis; the hourly wage is
salary ÷ annual hours (2080 by default, configurable).

Wage data is confidential: project screens only ever show the blended
standard cost rate, never anyone's pay.

## Estimate components

Components stack on top of the wage to form the standard cost rate:

- **% of wage** — the typical statutory-burden estimate (Canadian shops often
  land near 12–15%; US construction 25–40%). Choose whether it scales with
  overtime.
- **$ per hour** — flat hourly adders.
- **$ per day** — per-diem style allowances, prorated by your hours-per-day.

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

Everything is inert until you configure it, and posting problems never block
an approval — entries stay re-postable.

## Bill-out rates

Billing is the rate-book system's job (see *Item Rate Books*): assign books
per customer or project, version them by date. For labor, each rate line can
carry **explicit per-time-type rates** (your reg/OT/DT card, per item, per
customer). When no explicit tier rate exists, the line's bill rate × the time
type's bill multiplier applies. Approval stamps the resolved rate on the
entry; invoicing uses it as before.

## The payroll true-up

Payroll runs in your payroll system; its accounting journal enters OpenBooks
as an ordinary journal — imported through **Data → Import** or entered
manually — debiting the **labor clearing** account (and the real statutory
burden accounts) that the standard postings credited.

The **Payroll reconciliation** card shows the wash for any period:

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
}
