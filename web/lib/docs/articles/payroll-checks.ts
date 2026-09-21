import type { DocArticle } from '../types'

export const payrollChecks: DocArticle = {
  slug: 'payroll-checks',
  title: 'Payroll Checks',
  category: 'projects',
  order: 15,
  summary:
    'The deterministic pre-run anomaly queue: block, warn and info flags with their numbers, lifecycle transitions with reasons, and the finalize gate they enforce.',
  updated: '2026-09-21',
  keywords: ['payroll', 'anomaly', 'flags', 'checks', 'finalize', 'block', 'scan', 'timesheet'],
  related: ['payroll', 'payslip-explanations', 'ai-governance-ledger'],
  body: `# Payroll Checks

Payroll checks scan a pay period before the run finalizes and raise one flag per finding, each with its numbers: the amounts, the cohort baseline they were measured against, and the exact records behind them. Flags come in three severities. Block refuses the pay-run finalize while open. Warn records the risk and lets the run through once acknowledged. Info is FYI and never gates anything.

Enable the queue in Company Settings → Features → HRM → AI assistance → Payroll anomalies (timesheet flags ride the Time anomalies switch beside it). Turning the switch off hides the queue and unregisters the finalize gate; existing flags and their history are preserved.

## The queue

Payroll → Checks lists every flag for the selected period with severity, kind, status and explanation filters, plus tiles for blocking, warnings, acknowledged and the false-positive rate. Open a flag to see its numbers, its employment and period, and its lifecycle buttons: acknowledge (accepted risk, stays visible), resolve (fixed at the source, with the fix described), and false positive (the reading was wrong, with why). Every transition needs a reason — a blank reason is refused — and reasons are stored on the flag.

Rescanning a period is idempotent: already-open flags are reported, never duplicated, and false positives feed a suppression list so the next scan skips what a human already judged.

## The finalize gate

A run whose period overlaps an open block flag cannot finalize: the commit refuses with the blocking count and the path to the queue, and the run wizard's review step shows the same count with a link while the commit button stays off. Acknowledged warnings never block. With the switch off, the gate is not registered and finalizing behaves exactly as before.

Timesheet approvers see the same flags as chips on the weekly grid for weeks they overlap — informational only, approval itself is never blocked. Every scan, transition and finalize refusal appends to the AI governance ledger with the flag as its source.
`,
}
