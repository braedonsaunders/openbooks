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

Overhead costing allocates indirect company costs to projects, including rent,
insurance, administrative salaries, and IT, so a project's margin reflects
the **fully-burdened** cost of the work rather than only its direct costs.

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

## Configuration components

| Piece | Where | Role |
|---|---|---|
| **Overhead Model** | Company Settings → Projects → Overhead Model | Groups overhead accounts into categories and calculates each department's rate from actual overhead and labor hours. |
| **Overhead Rates** | Company Settings → Projects → Overhead Rates | Stores the published, effective-dated hourly or labor-percentage rates used for project costing. |
| **Project Types** | Company Settings → Projects → Project Types | Selects the overhead method for each project type: rate card, flat hourly amount, percentage of labor, or none. |

## Setup, step by step

1. **Classify your overhead costs.** On the Overhead Model's **Categories**
   tab, group your indirect expense accounts into categories (Facilities,
   Insurance, Administration). Accounts that have not been classified appear
   under **Unassigned** and should be reviewed before rates are published.
2. **Review the computed rates.** The **Matrix** tab shows each department's
   rate: its share of overhead divided by its labor hours. This analytical
   preview recalculates from actuals and is not used directly for project costing.
3. **Run the Setup wizard.** Select the method, confirm the rates to publish,
   and choose the applicable project types. The **department rate card** is the
   recommended default. Rate values are prefilled from the computed amounts and
   can be adjusted according to policy.
   Finishing publishes the rate card and updates the selected types, including
   their P&L layout.
4. **Check a project.** Open any project's **Financials** tab — an **Overhead**
   line now appears, included in total job cost and gross profit.

## Keeping rates current

Review rates periodically according to the organization's accounting policy.
Compare the computed rates against the published card, then use **Publish rates** to publish
in new values from a chosen effective date. Prior periods keep their original
rates; only work from the effective date forward uses the new ones.

To adjust a single department or add a historical rate, edit the rows directly
on the **Overhead Rates** card — each row is a department, a rate, and an
effective date range.

## Choosing a method

- **Department rate card** — effective-dated hourly rates by department. This
  method preserves department-level costing detail and rate history.
- **Flat $ per labor hour** — one company-wide hourly rate, suitable when
  department-specific rates are not required.
- **% of labor cost** — overhead calculated as a percentage of labor cost.
- **None** — for project types that should not carry overhead, such as internal
  or warranty work.

The method is set per **project type**, so different classes of work can carry
overhead differently.
`,
}
