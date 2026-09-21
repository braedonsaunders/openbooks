import type { DocArticle } from '../types'

export const payslipExplanations: DocArticle = {
  slug: 'payslip-explanations',
  title: 'Payslip Explanations',
  category: 'projects',
  order: 14,
  summary:
    'How every payslip line traces to its payroll run, wage rate, benefit and leave inputs, with the previous-stub diff and the exact records behind each number.',
  updated: '2026-09-21',
  keywords: ['payslip', 'pay stub', 'explain', 'wages', 'deductions', 'diff', 'payroll'],
  related: ['payroll', 'self-service', 'payroll-checks'],
  body: `# Payslip Explanations

Every payslip line traces to the record that produced it. Open any payslip from Me → Pay and choose Explain: the drawer walks the gross, each earning, each deduction, and the employer cost, and every line names its treatment (which wage rate, which benefit election, which leave entry) plus the exact source record that opens on click.

The explanation is deterministic: it renders the same inputs the calculation read, from the same tables. Nothing is estimated and nothing is prose generated about your pay — if a line cannot be traced, the drawer says which record is missing instead of guessing.

## The previous-stub diff

Below the lines, the drawer compares this stub with your previous one and lists what changed: rate changes mid-period, new or removed lines, and amount movements with the old and new figures side by side. A change names both values, so a smaller net pay always resolves to its cause.

## Who can see what

You can explain your own payslips. Managers and payroll staff with the employment read grant can explain their people's stubs through the same trace. Explaining another person's pay without the grant is refused with the permission named — the drawer never renders a partial trace for someone you may not see.

The trace is read-only and never writes: it appends one line to the AI governance ledger recording that the explanation was shown, with the stub as its source.
`,
}
