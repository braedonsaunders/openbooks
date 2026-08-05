import type { DocArticle } from '../types'

export const fieldTickets: DocArticle = {
  slug: 'field-tickets',
  title: 'Field Tickets',
  category: 'projects',
  order: 4,
  summary:
    'Capture crew hours, equipment, and materials for time-and-materials work, obtain customer signatures, and generate invoices from approved field tickets.',
  updated: '2026-07-27',
  keywords: ['field ticket', 'LEM', 'billable timesheet', 'T&M', 'signature', 'crew', 'foreman', 'work order', 'daily ticket'],
  related: ['labor-costing', 'item-rates', 'project-types'],
  body: `# Field Tickets

A field ticket, also referred to as an **LEM sheet** or billable timesheet,
records crew hours and the equipment, consumables, and materials used on a job
for a shift, day, or week. A customer representative can sign the ticket, and
time-and-materials invoices retain traceability to the signed evidence.

Enable it in **Company Settings → Features → Field Tickets** (off by default).
It is subordinate to the Projects parent gate and cannot operate when Projects
is disabled.

Choose the hour categories shown in the crew grid with **Show on field tickets**
on each record under **Setup → Workforce → Time Types**. This controls only the
ticket grid; hidden types remain available to timesheets, pricing, imports, and
labor costing. A common configuration enables Regular, Overtime, and Double time.
Set each type's **Classification** explicitly; classification controls its
semantic column and remains independent from its cost and bill multipliers.

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
equipment, consumables, and materials. Rates default from item and rate books
and remain editable. Labor amounts display current preview rates. Every atomic time
entry belongs to exactly one project and may reference zero or one Field
Ticket. A weekly employee timesheet is a separate container and may contain
lines from several projects, entry sources, and Field Tickets.

**Pending approval** — only when the tenant has enabled an **on submit** Flow
for field tickets and that Flow creates an approval gate. The tenant chooses
the conditions, assignees, quorum, signatures, reminders, and escalation in
the visual Flows editor. OpenBooks does not install a default approver or
hardcode an approval threshold. When no Flow creates a gate, submission moves
directly to Approved.

**Approved** — the ticket's commercial review is complete. Item lines
materialize as a **posted project charge** so job cost and T&M billing see them.
At the same boundary, OpenBooks captures a versioned commercial labor snapshot:
the exact people, classes, dates, hour categories, hours, labels, rates, and
source provenance the approval released. The gate decision, snapshot, project
charge, provenance, status, and audit evidence commit atomically; if a
configured effect fails, the approval remains pending and can be retried safely.

Field Ticket approval does **not** approve, reject, or repost its time entries.
Employee timesheet/payroll approval is an independent lifecycle with its own
controls and posting effects. This preserves one authoritative status for each
purpose and allows a ticket to contain lines that came from direct daily or
weekly time entry. Later operational-time corrections therefore cannot silently
change a previously approved or signed customer artifact. A controlled
commercial amendment appends a new snapshot revision and retains the prior one.

**Signed** — send the ticket PDF and a secure signing link, valid for 14 days,
to the customer. The customer can sign from a supported device, and the ticket
records the signatory and timestamp. Each request has a revocable,
single-use credential. Signature images are immutable File Cabinet evidence
stored through the configured database or S3-compatible object store; a signed
ticket cannot accept a second signature.

## Native data and audit controls

Field Tickets are a native platform record: common commercial fields
live on the document, while period, foreman, submission, rejection, and charge
linkage live on the one-to-one native Field Ticket header. Signatures and
delivery requests have dedicated evidence tables. Approved labor snapshots and
their lines are append-only, tenant-scoped evidence; they never post labor,
approve time, or become a parallel payroll ledger. Tenant custom fields and
source-system provenance remain extensions; OpenBooks does not store its own
Field Ticket state in a tenant custom-field payload.

## Invoicing

The T&M billing engine imports a ticket's approved hours and project-charge
lines using the standard billable time-and-cost process. When the
invoice's backup packet includes timesheets, every **signed ticket PDF** the
invoice billed is appended automatically as supporting documentation.

## The customer-facing PDF

The ticket PDF uses an organization-authored template configured under **Admin →
PDF Templates → Field ticket**. The default template is a summary. Merge fields
also support a weekly grid with per-crew daily columns, regular, overtime, and
double-time categories, day headers, and tier-specific rates.
`,
}
