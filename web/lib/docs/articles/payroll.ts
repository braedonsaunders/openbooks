import type { DocArticle } from "../types";

export const payroll: DocArticle = {
  slug: "payroll",
  title: "Canadian Payroll",
  category: "projects",
  order: 6,
  summary:
    "Run Canadian payroll: CRA T4127 statutory deductions, pay schedules, TD1 profiles, pay runs, union fringes, and GL posting.",
  updated: "2026-08-04",
  keywords: [
    "payroll",
    "pay run",
    "CPP",
    "EI",
    "QPP",
    "QPIP",
    "income tax",
    "TD1",
    "T4127",
    "claim code",
    "vacation pay",
    "union",
    "fringes",
    "dues",
    "remittance",
    "net pay",
    "stub",
  ],
  related: ["labor-costing", "overhead-costing"],
  body: `# Canadian Payroll

Payroll is an optional feature (Setup → Features → Payroll, off by default).
It computes Canadian statutory deductions with the CRA T4127 formulas — the
same publication the CRA gives payroll software vendors — using constants
pinned to the edition in force on each pay date. The CRA publishes the guide
twice a year (January and July); each edition ships with OpenBooks as
versioned data, never as user-editable formulas, and every calculation stores
its full factor trace (A, K1 through K4, T1 through T4, and so on) on the pay
stub so any amount can be explained line by line.

## What the engine covers

- Federal and provincial/territorial income tax for every jurisdiction,
  including the Ontario surtax, Ontario Health Premium, Ontario and BC tax
  reductions, Alberta K5P, Yukon employment amount, the dynamic federal basic
  personal amount, and the Quebec federal abatement.
- CPP and the second additional contribution (CPP2), QPP, EI (with the Quebec
  reduced rate), and QPIP, each with exact annual-maximum handling and
  employer shares.
- The bonus and retroactive-pay method for non-periodic payments, including
  the flat-rate rule for annual incomes of 5,000 dollars or less.
- TD1 claim codes 0 through 10 or exact claim amounts, additional requested
  tax, prescribed-zone deductions, and authorized deductions or credits.
- Quebec provincial income tax is administered by Revenu Quebec and is out of
  scope; QPP, QPIP, and the federal side of Quebec employment are handled.

## Setup

1. **Accounts** — Setup → Payroll: wage expense, employer burden expense, net
   pay payable, CRA remittance payables (income tax, CPP, EI), and vacation
   payable. Choose where time-driven wages debit: wage expense with project
   splits, or the labor clearing account when standard labor costing posts at
   time approval (the payroll actuals then wash the clearing balance and the
   existing true-up reconciles the variance).
2. **Components** — seed the standard component set, then add organization
   components (allowances, RRSP match, garnishees). Deductions can be pre-tax
   under the correct T4127 factor: pension (factor F), union dues (U1), or
   pre-1997 alimony (F2).
3. **Schedules** — weekly, biweekly, semi-monthly, or monthly, anchored to any
   period end. Years with 27 or 53 pay days are supported explicitly.
4. **Employees** — each employee gets a payroll profile: schedule, province of
   employment, TD1 claim codes, exemptions, vacation percent (accrue or pay
   each period), and union membership. Wages are not entered here: payroll
   resolves the same effective-dated employee wage the costing engine uses,
   so job cost and pay never disagree.
5. **Opening balances** — adopting mid-year, enter each employee's
   year-to-date pensionable and insurable earnings, CPP/CPP2/EI/QPIP
   contributions, taxable income, and tax withheld so annual maxima and the
   bonus method stay exact.

## Running a pay run

Create a run for a schedule (the next period is derived automatically),
calculate, review each stub with its statutory trace, and commit. Committing
claims the period's approved time entries, builds the balanced journal
projection, and hands the run to the standard document posting flow. Hourly
earnings come from approved time entries at the employee wage times the time
type multiplier; salaried employees pay the annual rate over the schedule's
periods.

## Union construction payroll

Define collective agreements (union, local, remittance vendor), their
classifications, and their fringes. Employee-paid fringes such as working
dues become deductions and automatically flow into the T4127 union-dues
factor. Employer-paid fringes (pension, health, training funds) accrue per
hour worked or as a percent of gross, post to their own liability per fund,
and job-cost to the projects the hours were worked on. The monthly remittance
report totals hours and amounts per fund for any date range.
`,
};
