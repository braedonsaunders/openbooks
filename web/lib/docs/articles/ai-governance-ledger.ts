import type { DocArticle } from '../types'

export const aiGovernanceLedger: DocArticle = {
  slug: 'ai-governance-ledger',
  title: 'Assistant Reviews and Activity',
  category: 'administration',
  order: 13,
  summary:
    'Review declarations for registered assistance actions and their append-only native activity references, sources and human review outcomes.',
  updated: '2026-10-08',
  keywords: ['ai', 'governance', 'ledger', 'autonomy', 'capabilities', 'review', 'audit', 'draft'],
  related: ['assistant-chat', 'payroll-checks', 'payslip-explanations'],
  body: `# Assistant Reviews and Activity

AI in OpenBooks is tools and deterministic services, never free-text features. Every capability declares a code maximum for its action level. Native actions retain their permission, feature and lifecycle checks. Organization review declarations are validated against that maximum, but editing a declaration does not disable scans or change assistant authority: read-only explains from records, draft writes text a human inserts, propose surfaces findings a human decides, and nothing files, submits, approves or pays on its own.

There is no separate AI switch. The assistant itself is governed by the assistant.use permission and the model configuration, and each capability follows the module that owns its data: payslip explanations and payroll checks follow Payroll, timesheet checks follow Time tracking, Draft from evidence follows HRM and shows only for people who can use the assistant, and the natural-language Ask box on custom reports shows for people who can use the assistant — it hands off to the assistant, and report permissions still govern what it can build. Turning a module off hides its capability's tools, buttons and queues; its data and ledger history are preserved. The ledger itself is a platform feature and records every AI-assisted answer.

## Capabilities

Company Setup → Assistant action reviews lists the six capabilities with their autonomy select, reviewer, subject notice, last review and enabled state — a capability reads as enabled while its owning module is on. Declared review levels never exceed the code maximum; a higher declaration is refused with the ceiling named. These stored declarations record review intent; they are not another runtime permission gate. A capability whose module is off has its tools unregistered while its history is kept. Sync re-seeds the registry mirror after an upgrade without touching local edits.

Each capability carries a subject notice: the one line shown wherever its output appears, stating what the AI did and that a human decided. Notices are declared per capability and rendered everywhere the capability surfaces.

## The decisions log

Native services using this activity ledger append a row for the event: when, which capability, the subject, the cited sources, a one-line PII-free summary, and the outcome (shown, accepted, edited, rejected, expired). Prompts and full outputs are never stored — digests are digests of the answer, never the answer. Rows are append-only: updates and deletes are refused by the database, and corrections are new rows. The Activity tab shows one authorized page at a time, filters by action and outcome, and exports the current page to CSV. Subject permissions apply equally to rows, totals and exports.

## Reviews and settings

Company Setup → Workforce checks and drafting holds the existing organization policy. Its Checks, Drafting and Reviews sections replace one active record body. The review interval defaults to twelve months; action reviewers are assigned under Assistant action reviews. Overdue capabilities banner the ledger and nudge the setup admins' inbox until reviewed; recording a review stamps reviewer and time. The Checks section holds scan thresholds and baseline groups for deterministic payroll and timesheet checks; these checks do not call an AI provider or change payroll calculations. Drafting holds the organization’s language terms for human review. Admin → AI retains provider connection, model choices, encrypted credentials and document capture. Legacy provider-page policy drawer links lead to the actual Setup record without resetting stored settings.
`,
}
