import type { DocArticle } from '../types'

export const fieldTickets: DocArticle = {
  slug: 'field-tickets',
  title: 'Field Tickets',
  category: 'projects',
  order: 4,
  summary:
    'Signed crew timesheets for T&M work: capture the whole crew’s hours plus equipment and materials once, get the customer’s signature, and build invoices from the signed tickets.',
  updated: '2026-07-21',
  keywords: ['field ticket', 'LEM', 'billable timesheet', 'T&M', 'signature', 'crew', 'foreman', 'work order', 'daily ticket'],
  related: ['labor-costing', 'item-rates', 'project-types'],
  body: `# Field Tickets

A field ticket (the industry's **LEM sheet** or billable timesheet) is the
document T&M contracting runs on: a foreman records the crew's hours and the
equipment, consumables, and materials used on a job for a shift, day, or week;
the customer's representative **signs it**; and invoices are assembled from the
signed tickets — every invoice line traceable to a signed artifact.

Enable it in **Company Settings → Features → Field Tickets** (off by default).
It is subordinate to the Projects parent gate and cannot operate when Projects
is disabled.

Choose the hour categories shown in the crew grid with **Show on field tickets**
on each record under **Setup → Workforce → Time Types**. This controls only the
ticket grid; hidden types remain available to timesheets, pricing, imports, and
labor costing. A typical tenant enables Regular, Overtime, and Double time.

## Ticket period

Shift, daily, or weekly — resolved most-specific-wins:

| Level | Where |
|---|---|
| Job | The project's field-ticket period setting |
| Customer | The customer's field-ticket period setting |
| Company | Setup → Features (default: weekly, Sunday-start) |

## Lifecycle

**Draft** — the foreman builds the ticket: crew rows (employee × labor class)
with per-day regular/overtime/double hours, and sales-order-style lines for
equipment, consumables, and materials (rates prefill from the item and rate
books; stay editable). Labor money shows live preview rates.

**Submitted** — locked for approval.

**Approved** — the moment everything becomes real, through the same machinery
as personal timesheets: hours become approved time entries (cost + bill rates
snapshot, standard labor posts to the job, overhead rides along as the
net-zero pair), and item lines materialize as a **posted project charge** so
job cost and T&M billing see them. Approved history never restates.

**Signed** — send the ticket to the customer: they get the ticket PDF and a
secure signing link (valid 14 days), draw their signature on any device, and
the ticket records who signed and when. A signed ticket refuses a second
signature.

## Invoicing

Nothing to re-key: the T&M billing engine sweeps a ticket's approved hours and
project-charge lines exactly like any other billable time and cost. When the
invoice's backup packet includes timesheets, every **signed ticket PDF** the
invoice billed is appended automatically — the substantiation T&M customers
require before paying.

## The customer-facing PDF

The ticket PDF is an org-authorable template (Admin → PDF Templates → Field
ticket). The default is a modern summary; the merge surface also carries the
full classic weekly grid — per-crew-row day columns split by
regular/overtime/double, day headers, per-tier rates — so a traditional
7-column signed timesheet layout can be reproduced exactly.
`,
}
