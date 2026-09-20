import type { DocArticle } from "../types";

export const payroll: DocArticle = {
  slug: "payroll",
  title: "Payroll",
  category: "projects",
  order: 6,
  summary:
    "Run payroll with installable country packs: statutory withholding engines for the jurisdictions you employ, pay schedules, withholding profiles, pay runs, union fringes, and GL posting.",
  updated: "2026-09-20",
  keywords: [
    "payroll",
    "pay run",
    "CPP",
    "EI",
    "QPP",
    "QPIP",
    "Revenu Québec",
    "remittance frequency",
    "income tax",
    "TD1",
    "T4127",
    "W-4",
    "Pub 15-T",
    "FICA",
    "Social Security",
    "Medicare",
    "FUTA",
    "SUI",
    "claim code",
    "vacation pay",
    "union",
    "fringes",
    "dues",
    "remittance",
    "net pay",
    "stub",
    "IRPEF",
    "INPS",
    "addizionale",
    "trattamento integrativo",
    "ZUS",
    "PIT",
    "kaigo",
    "IRPF",
    "situación familiar",
    "eSocial",
    "FGTS",
    "INSS",
    "PAYE",
    "NICs",
    "PRSI",
    "USC",
    "PAYG",
    "SG",
    "CPF",
    "MediSave",
    "IRAS",
    "Lohnsteuer",
    "Solidaritätszuschlag",
    "Sozialversicherung",
    "URSSAF",
    "CSG",
    "CRDS",
    "DSN",
    "PAS",
    "Loonbelasting",
    "Zvw",
  ],
  related: ["labor-costing", "overhead-costing"],
  body: `# Payroll

Payroll is an optional feature (Setup → Features → Payroll, off by default).
Statutory withholding is provided by installable country packs — install the
jurisdictions you employ in under Setup → Payroll → Country packs, and one
pay run can mix employees across them.

The Canada pack computes statutory deductions with the CRA T4127 formulas —
the same publication the CRA gives payroll software vendors — using constants
pinned to the edition in force on each pay date. The CRA publishes the guide
twice a year (January and July); each edition ships with OpenBooks as
versioned data, never as user-editable formulas, and every calculation stores
its full factor trace (A, K1 through K4, T1 through T4, and so on) on the pay
stub so any amount can be explained line by line.

The United States pack computes federal withholding with the IRS Publication
15-T percentage method for automated payroll systems, plus Social Security,
Medicare (including Additional Medicare), FUTA, and configurable state
unemployment insurance. State income-tax withholding covers 49 supported
states: 40 taxing engines plus the nine no-tax states (Alaska, Florida,
Nevada, New Hampshire, South Dakota, Tennessee, Texas, Washington, Wyoming).
DC and NM are refused pending official goldens rather than producing
incomplete stubs.

## What the Canada engine covers

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
- Quebec provincial income tax (TP-1015) is computed for Québec employment
  alongside QPP, QPIP, and the federal side with the Quebec abatement.
  Québec-source amounts remit to Revenu Québec on its own schedule — see
  Remitting source deductions below.

### Canada setup notes

The generic setup steps below name the concept; the Canada answers are:

- Remittance payables: CRA remittance payables for income tax, CPP, and EI,
  plus Revenu Québec payables for Québec employment.
- Pre-tax deductions: the T4127 factor treatment — pension is factor F, union
  dues are factor U1, and pre-1997 alimony is factor F2.
- Retirement match example: an RRSP match.
- Withholding certificates: TD1 claim codes 0 through 10 or exact claim
  amounts, as listed above.
- Opening balances: year-to-date pensionable and insurable earnings with
  CPP/CPP2/EI/QPIP contributions, so annual maxima stay exact.
- Working-dues fringes flow into the T4127 union-dues factor.

### Remitting for the Canada pack

CRA and Revenu Québec destinations remit on different timetables, and a
bill's due date always comes from its own destination's schedule:

- CRA bills follow the filing account's CRA remitter type (regular,
  quarterly, and the two accelerated thresholds), moved off weekends and
  CRA-recognized holidays to the next business day. Québec-only payrolls use
  the CRA's Québec holiday calendar.
- Revenu Québec bills (Québec income tax, QPP, and QPIP on Québec employment)
  follow the RQ schedule declared by the Canada pack — quarterly, monthly, or
  twice-monthly by average monthly remittance, transcribed from Revenu Québec
  Guide TP-1015.G and form TPZ-1015.R — never the CRA registration on the
  filing account. Deadlines move to the next business day on the Québec
  calendar.

Your RQ frequency is the one on your Revenu Québec notice: set it under Setup
→ Payroll (Revenu Québec remittance frequency). New employers remit monthly,
which is also the default until a frequency is set. Setup readiness warns
while the frequency is unconfirmed, and when last year's average monthly
remittance points at a different band. Every bill stamps the rule that dated
it, so a due date is always explainable.

## What the US engine covers

- Federal income tax with the Pub 15-T annual percentage method: 2020-or-later
  W-4s (filing status, the Step 2 multiple-jobs checkbox, Step 3 dependent
  credits, Step 4 other income, deductions, and extra withholding) and
  2019-or-earlier W-4s via withholding allowances.
- Social Security with the annual wage-base maximum, Medicare with the
  employee-only Additional Medicare tax over 200,000 dollars, and the
  employer matches.
- Supplemental wages (bonuses, retroactive pay) at the optional flat rate,
  with the mandatory higher rate past 1,000,000 dollars year to date.
- FUTA at a configurable effective rate (for credit-reduction states) and
  state unemployment insurance at the employer's own experience rate and each
  state's wage base, entered in Setup → Payroll → Accounts & posting.

## Setup

The steps below are the same for every jurisdiction; the statutory specifics
— which payables, which pre-tax treatments, which certificates, which
year-to-date bases — come from each installed pack. The pack sections above
(Canada, US) name the specifics for the packs they cover, alongside the setup
screens under Setup → Payroll → Country packs. Read the section for every
jurisdiction you employ alongside these steps.

1. **Accounts** — Setup → Payroll: wage expense, employer burden expense, net
   pay payable, the remittance payables each installed pack declares for its
   agencies, and vacation payable. Choose where time-driven wages debit: wage
   expense with project splits, or the labor clearing account when standard
   labor costing posts at time approval (the payroll actuals then wash the
   clearing balance and the existing true-up reconciles the variance).
2. **Components** — seed the standard component set, then add organization
   components (allowances, employer retirement match, garnishees). Deductions
   can be pre-tax under the treatment the employee's pack recognizes — the
   Canada pack expresses this with T4127 factors, listed in its section above.
3. **Schedules** — weekly, biweekly, semi-monthly, or monthly, anchored to any
   period end. Years with 27 or 53 pay days are supported explicitly.
4. **Employees** — each employee gets a payroll profile: schedule, country
   and province or state of employment, the withholding certificate or
   elections the employee's pack requires (TD1 claim codes in Canada, W-4
   elections in the US), exemptions, vacation percent (accrue or pay each
   period), and union membership. Wages are not entered here: payroll
   resolves the same effective-dated employee wage the costing engine uses,
   so job cost and pay never disagree.
5. **Opening balances** — adopting mid-year, enter each employee's
   year-to-date assessable bases and statutory contributions the pack's annual
   maxima depend on (in Canada: pensionable and insurable earnings with
   CPP/CPP2/EI/QPIP contributions), plus taxable income and tax withheld, so
   annual maxima and the pack's special payment calculations stay exact.

## Running a pay run

Create a run for a schedule (the next period is derived automatically),
calculate, review each stub with its statutory trace, and commit. Committing
claims the period's approved time entries, builds the balanced journal
projection, and hands the run to the standard document posting flow. Hourly
earnings come from approved time entries at the employee wage times the time
type multiplier; salaried employees pay the annual rate over the schedule's
periods.

## Remitting source deductions

Committing a pay run accrues withholding liabilities; getting the money to
the agency is a separate step under Payroll → Remittances. The cockpit groups
accrued amounts by destination vendor and payroll program account — one card
per destination, covering the statutory agency vendors the installed packs
declare and any union funds — and each group materializes as one draft vendor
bill debiting the liability accounts. The bill then rides the normal AP
review, post, and pay flow.

Each destination remits on its own timetable, and a bill's due date always
comes from its own destination's schedule; the pack sections above name the
timetable each pack declares.

## Union construction payroll

Define collective agreements (union, local, remittance vendor), their
classifications, and their fringes. Employee-paid fringes such as working
dues become deductions and automatically take the deductible-dues treatment
the employee's pack recognizes (the Canada pack maps them into the T4127
union-dues factor — see its section above). Employer-paid fringes (pension,
health, training funds) accrue per
hour worked or as a percent of gross, post to their own liability per fund,
and job-cost to the projects the hours were worked on. The monthly remittance
report totals hours and amounts per fund for any date range.
`,
};
