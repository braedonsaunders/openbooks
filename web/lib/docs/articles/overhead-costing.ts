import type { DocArticle } from '../types'

export const overheadCosting: DocArticle = {
  slug: 'overhead-costing',
  title: 'Setting Up Overhead Costing',
  category: 'projects',
  order: 2,
  summary:
    'A step-by-step guide to allocating company overhead to projects: classify costs, review computed rates, publish the rate card, and apply a method to your project types.',
  updated: '2026-07-20',
  keywords: ['overhead', 'burden', 'rate card', 'cost pools', 'departments', 'fully burdened', 'margin', 'wizard', 'publish'],
  related: ['project-types'],
  body: `# Setting Up Overhead Costing

Overhead costing gives every project its share of the cost of running the
company — rent, insurance, admin salaries, IT — so a project's margin reflects
the **fully-burdened** cost of the work, not just its direct costs.

Two principles the system enforces:

- **Overhead never changes the company P&L.** Your indirect costs are already
  expensed in the GL, so nothing is double-counted. By default overhead is a
  report-only managerial figure; optionally, the **net-zero pair** application
  mode posts each project's share to the overhead account WITH the project tag
  and reverses the same amount without it — job-cost ledger views carry
  overhead while the account (and the P&L) nets to exactly zero.
- **Job costs never restate.** Projects are costed only from **published,
  effective-dated rates**. Each hour of labor uses the rate that was in effect
  on the day it was worked, so closed periods never change.

## The three pieces

| Piece | Where | Role |
|---|---|---|
| **Overhead Model** | Company Settings → Projects → Overhead Model | The *calculator*. Groups your overhead accounts into categories and computes each department's rate from actuals: overhead ÷ labor hours. |
| **Overhead Rates** | Company Settings → Projects → Overhead Rates | The *rate card*. The published, effective-dated $/hour (or % of labor) rates that projects are actually costed from. |
| **Project Types** | Company Settings → Projects → Project Types | The *policy*. Each type chooses an overhead method — rate card, flat $/hour, % of labor, or none. |

## Setup, step by step

1. **Classify your overhead costs.** On the Overhead Model's **Categories**
   tab, group your indirect expense accounts into categories (Facilities,
   Insurance, Admin…). Accounts you haven't classified appear under
   **Unassigned** — assign them so nothing is missed.
2. **Review the computed rates.** The **Matrix** tab shows each department's
   rate: its share of overhead divided by its labor hours. This is an
   analytical preview — it moves with your actuals and is never used to cost
   jobs directly.
3. **Run the Setup wizard.** It walks through the whole configuration in one
   pass: pick an approach (the **department rate card** is recommended),
   confirm the rates to publish (pre-filled from the computed values — adjust
   if you prefer round numbers), and choose which project types it applies to.
   Finishing publishes the rate card and updates the selected types, including
   their P&L layout.
4. **Check a project.** Open any project's **Financials** tab — an **Overhead**
   line now appears, included in total job cost and gross profit.

## Keeping rates current

Costs drift, so revisit periodically (quarterly is typical): compare the
computed rates against the published card, then use **Publish rates** to lock
in new values from a chosen effective date. Prior periods keep their original
rates; only work from the effective date forward uses the new ones.

To adjust a single department or add a historical rate, edit the rows directly
on the **Overhead Rates** card — each row is a department, a rate, and an
effective date range.

## Choosing a method

- **Department rate card** — per-department $/hour, effective-dated. The most
  accurate and auditable; recommended for field/shop businesses.
- **Flat $ per labor hour** — one company-wide hourly rate. Simple.
- **% of labor cost** — overhead as a markup on labor dollars. Common in
  professional services.
- **None** — for project types that shouldn't carry overhead (e.g. internal or
  warranty work).

The method is set per **project type**, so different classes of work can carry
overhead differently.
`,
}
