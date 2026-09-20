import type { DocArticle } from '../types'

export const hrmProcesses: DocArticle = {
  slug: 'hrm-processes',
  title: 'Onboarding, Offboarding, and Transfer Checklists',
  category: 'administration',
  order: 11,
  summary:
    'Every employment start, end, and transfer drives a checklist with owners, due dates, and evidence. Completion is a recorded fact: open processes, overdue steps, and template setup.',
  updated: '2026-09-20',
  keywords: ['onboarding', 'offboarding', 'transfer', 'checklist', 'new hire', 'exit', 'department move', 'process template'],
  related: ['payroll', 'setup-company-group'],
  body: `# Onboarding, Offboarding, and Transfer Checklists

Every employment start, end, and transfer drives a checklist with owners, due dates, and evidence. Completion is a recorded fact, not a memory: the HR overview shows open checklists, overdue steps, and the next seven days, and the Processes tab carries each checklist to completion or cancellation.

Enable the module in Company Settings → Features → HRM. Employment records stay readable while HRM is off, but checklists exist only while it is on: with the feature off, no checklist opens, and with it on, every hire, termination, and department move owes one.

## How checklists open

An approved hire opens an onboarding checklist, an approved termination opens an offboarding checklist, and an approved department change opens a transfer checklist. The checklist opens inside the same transaction as the employment change, so a hire without its checklist cannot exist: if no template covers the employment, the change itself is refused and stays pending, naming the missing template.

A move across legal employers is a termination plus a rehire, never an edit, so it opens offboarding on the old employment and onboarding on the new one. A status change rides the hire's onboarding episode and opens nothing on its own. At most one open checklist of a kind exists per employment; finish or cancel the open one before opening another.

## Templates

Checklist configuration lives under Setup → Workforce → Process Templates, with the ordered steps beside it under Process Template Steps. Each template names its kind (onboarding, offboarding, or transfer) and an applies-to filter: an employer subsidiary, a department, both, or neither (all). When several templates cover one employment, the most specific wins; an exact tie is refused so nobody silently picks a checklist for you.

A checklist is a snapshot: opening copies the template's steps with concrete due dates, and later template edits never rewrite history. Retire a template with its active switch instead of deleting it — a template that opened checklists is retained as history and names the remedy when deletion is attempted.

Each step names its owner (the manager, HR, the employee, or one named person), a due offset in days relative to the effective date (negative for preparation work), whether it is required, and what evidence it takes: none, an acknowledgement, or a file attachment the completing actor may read.

## Working a checklist

The Processes tab segments checklists into open, overdue, completed, and cancelled. Each row shows the employee, the kind, the effective date, required-step progress, and the next due date. The drawer carries the steps with owners, due dates, and evidence, plus the working actions:

- Complete a step. Acknowledgement records who and when; attachment evidence needs a file the completing actor may read.
- Skip a step with a reason. Skipping a required step needs the employment management permission; optional steps take the manager or the owner.
- Complete the checklist once no required step is pending.
- Cancel the checklist with a reason. Cancelled and completed checklists stay recorded; they are never deleted.

The employee themself may complete only their own steps, and sees only the step — the first self-service touch, fenced to the single row.

## Reporting and assistance

The Process Checklists workforce report lists one row per checklist step with process and step status, owner, due date, and evidence. The assistant read tool answers checklist questions from the same canonical read service as the tab, so the numbers always agree.
`,
}
