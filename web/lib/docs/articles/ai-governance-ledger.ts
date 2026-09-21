import type { DocArticle } from '../types'

export const aiGovernanceLedger: DocArticle = {
  slug: 'ai-governance-ledger',
  title: 'AI Governance Ledger',
  category: 'administration',
  order: 13,
  summary:
    'What the AI may do on its own, what it may only draft, and the append-only record of every AI-assisted answer with its sources and outcome.',
  updated: '2026-09-21',
  keywords: ['ai', 'governance', 'ledger', 'autonomy', 'capabilities', 'review', 'audit', 'draft'],
  related: ['assistant-chat', 'payroll-checks', 'payslip-explanations'],
  body: `# AI Governance Ledger

AI in OpenBooks is tools and deterministic services, never free-text features. Every capability declares an autonomy ceiling, and the ceiling only moves down: read-only explains from records, draft writes text a human inserts, propose surfaces findings a human decides, and nothing files, submits, approves or pays on its own.

Enable the surface in Company Settings → Features → HRM → AI assistance, with one subordinate switch per capability: payslip explanations, payroll anomalies, time anomalies, evidence drafting, and natural-language reports. Turning a switch off hides its tools, buttons and queues; its data and ledger history are preserved.

## Capabilities

Admin → AI → Governance lists the six capabilities with their autonomy select, reviewer, subject notice, last review and enabled state. Lowering autonomy takes effect immediately; raising it is refused with the ceiling named. Disabling a capability unregisters its tools while keeping its history. Sync re-seeds the registry mirror after an upgrade without touching local edits.

Each capability carries a subject notice: the one line shown wherever its output appears, stating what the AI did and that a human decided. Notices are declared per capability and rendered everywhere the capability surfaces.

## The decisions log

Every AI-assisted answer appends exactly one row: when, which capability, the subject, the cited sources, a one-line PII-free summary, and the outcome (shown, accepted, edited, rejected, expired). Prompts and full outputs are never stored — digests are digests of the answer, never the answer. Rows are append-only: updates and deletes are refused by the database, and corrections are new rows. The log filters by capability and exports to CSV with the same columns on screen.

## Reviews and settings

Each capability declares a review cadence (Admin → AI → AI rails settings, default twelve months) and a reviewer. Overdue capabilities banner the ledger and nudge the setup admins' inbox until reviewed; recording a review stamps reviewer and time. The same settings page holds the scan thresholds, the baseline cohort, and the org-declared bias vocabulary the drafting check flags whole-word.
`,
}
