import type { DocArticle } from '../types'

export const fieldTickets: DocArticle = {
  slug: 'field-tickets',
  title: 'Field Tickets',
  category: 'projects',
  order: 4,
  summary:
    'Signed crew timesheets for T&M work: capture the whole crew’s hours plus equipment and materials once, get the customer’s signature, and build invoices from the signed tickets.',
  updated: '2026-07-27',
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
| Job | Effective-dated Field Ticket policy for the project |
| Customer | Effective-dated Field Ticket policy for the customer |
| Company | Effective-dated organization policy (product default: weekly, Sunday-start) |

The resolved period is copied to the ticket when it is created. Changing a
policy therefore affects future tickets without reinterpreting history.

## Lifecycle

**Draft** — the foreman builds the ticket: crew rows (employee × labor class)
with per-day regular/overtime/double hours, and sales-order-style lines for
equipment, consumables, and materials (rates prefill from the item and rate
books; stay editable). Labor money shows live preview rates. Every atomic time
entry belongs to exactly one project and may reference zero or one Field
Ticket. A weekly employee timesheet is a separate container and may contain
lines from several projects, entry sources, and Field Tickets.

**Pending approval** — only when the tenant has enabled an **on submit** Flow
for field tickets and that Flow creates an approval gate. The tenant chooses
the conditions, assignees, quorum, signatures, reminders, and escalation in
the visual Flows editor. OpenBooks does not install a default approver or
hardcode an approval threshold. When no Flow creates a gate, submission moves
straight to Approved.

**Approved** — the ticket's commercial review is complete. Item lines
materialize as a **posted project charge** so job cost and T&M billing see them.
The gate decision, project charge, provenance, status, and audit evidence
commit atomically; if a configured effect fails, the approval remains pending
and can be retried safely.

Field Ticket approval does **not** approve, reject, or repost its time entries.
Employee timesheet/payroll approval is an independent lifecycle with its own
controls and posting effects. This preserves one authoritative status for each
purpose and allows a ticket to contain lines that came from direct daily or
weekly time entry.

**Signed** — send the ticket to the customer: they get the ticket PDF and a
secure signing link (valid 14 days), draw their signature on any device, and
the ticket records who signed and when. Each request has a revocable,
single-use credential. Signature images are immutable File Cabinet evidence
stored through the configured database or S3-compatible object store; a signed
ticket refuses a second signature.

## Native data and audit controls

Field Tickets are a first-class OpenBooks aggregate: common commercial fields
live on the document, while period, foreman, submission, rejection, and charge
linkage live on the one-to-one native Field Ticket header. Signatures and
delivery requests have dedicated evidence tables. Tenant custom fields and
source-system provenance remain extensions; OpenBooks does not store its own
Field Ticket state in a tenant custom-field payload.

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
