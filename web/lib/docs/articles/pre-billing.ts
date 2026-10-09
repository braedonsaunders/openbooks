import type { DocArticle } from '../types'

export const preBilling: DocArticle = {
  slug: 'pre-billing',
  title: 'Pre-billing',
  category: 'projects',
  order: 5,
  summary:
    'Turn unbilled project work into reviewed invoice packages: bill runs, adjustments and holds, approval through Flows, optional customer review in the portal, and delivery with backup.',
  updated: '2026-10-07',
  keywords: ['pre-billing', 'prebill', 'billing review', 'bill run', 'WIP', 'write-down', 'write-up', 'customer approval', 'purchase order', 'invoice backup'],
  related: ['field-tickets', 'project-types', 'labor-pricing'],
  body: `# Pre-billing

Pre-billing is the review step between finished work and a customer invoice.
Unbilled time and cost on a project become a **prebill** — a worksheet that
shows exactly what will be invoiced, priced by the project type's policy. A
biller adjusts it, it is approved, the customer can review it, and only then
does it become an invoice, which is delivered with its backup.

Enable it in **Company Settings → Features → Pre-billing**. It is subordinate
to Projects and works with any project type whose invoicing bills time and
cost lines.

## The board

**Projects → Pre-billing** opens on a board whose columns are the stages work
moves through:

| Stage | Meaning |
| --- | --- |
| To prebill | Projects with approved, unbilled work no prebill has claimed |
| Draft | Prebills being prepared or reworked |
| In approval | Submitted prebills awaiting a decision in Inbox |
| Ready to invoice | Approved prebills |
| With customer | Prebills the customer is reviewing in the portal |
| Invoiced | Invoices to post or send |
| Sent | Delivered invoices with an open balance |
| Paid | Invoices whose balance is cleared |

Stages a company does not use stay hidden: **In approval** appears only when
an approval flow exists, and **With customer** only when the customer portal
is on. Switch to **Table** for one list filtered by stage.

## Bill runs

**Bill run** prepares a draft prebill for every selected project with unbilled
work through a cutoff date. Each project is prepared independently: a project
that cannot be prebilled — no work before the cutoff, an exhausted
not-to-exceed cap, a missing policy — is listed with its reason and never
blocks the others. **Prebill** on a single project card runs the same command
for that project.

## Reviewing a prebill

The prebill drawer shows the invoice as the customer will see it beside the
source work behind it. On a draft you can:

- change a line's amount — every write-up or write-down needs a reason and
  evidence, and the difference is reported as realization;
- hold a line, which keeps it out of this and later prebills until released.

## Approval

Approval runs through **Flows**. Author a flow on the *Pre-billing worksheet*
subject to route prebills to approvers by amount, write-downs, project type or
any other field. Each gate's self-approval setting determines whether the
preparer or submitter may decide it; the submitted policy stays fixed for
that approval. With no
flow, submitting a prebill approves it immediately. A rejection returns the
prebill to draft with the approver's reason.

**Reopen** returns an approved prebill to draft; it must be approved again.

## Customer review

With the customer portal on, **Send to customer** emails the customer a
sign-in link to the package. The customer sees the billable lines and total —
never cost or internal adjustments — and either:

- **accepts**, giving their name and optionally a purchase order number, which
  the invoice then references; or
- **requests changes**, noting each line that needs attention. The prebill
  returns to draft with those notes beside the lines.

An acceptance binds to a fingerprint of exactly what the customer was shown;
if the prebill changes, the customer must review the current version. To make
review mandatory, set **Customer review before invoicing** to *Required* on the
project type's invoicing settings; prebills prepared from then on cannot be
invoiced until the customer accepts.

## Invoicing and delivery

**Create invoice** turns an approved prebill into a draft customer invoice and
marks its source work billed, so nothing can be billed twice. Once the invoice
is posted, **Send invoice** emails it with its backup packet attached and the
card moves to **Sent**; it moves to **Paid** when its balance is cleared.
`,
}
