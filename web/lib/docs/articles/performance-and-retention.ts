import type { DocArticle } from '../types'

export const performanceAndRetention: DocArticle = {
  slug: 'performance-and-retention',
  title: 'Performance Reviews, Goals, and Retention',
  category: 'administration',
  order: 12,
  summary:
    'Review cycles with self and manager assessments, calibration, sharing, and acknowledgement; per-employment goals with progress; exit records and turnover. Who sees each review, and how attrition is measured.',
  updated: '2026-09-20',
  keywords: ['performance review', 'calibration', 'goals', 'turnover', 'attrition', 'exit interview', 'retention', 'review cycle'],
  related: ['hrm-processes', 'payroll', 'setup-company-group'],
  body: `# Performance Reviews, Goals, and Retention

Employment records, positions, and checklists say who works where. Reviews say how people are doing, goals say where they are headed, and exit records say why they leave. The Performance tab runs the review cycle; the Retention panel measures attrition from the employment history the system already keeps.

Enable the module in Company Settings → Features → HRM. Reviews, goals, and exit records exist only while it is on.

## The review cycle

A cycle is the org's review run over a period: draft, open, calibrating, closed. Create it from the Performance tab with a template, a period, due dates, and a scope (an employer subsidiary, a department, both, or neither for all). Opening instantiates, in one transaction, a self review for every in-service employment in scope plus a manager review for each whose line manager resolves as of the period end. An employment with no manager gets the self review only, and the cycle records how many gaps it opened with.

The template is a snapshot: opening copies its sections and questions into the reviews, so later template edits never rewrite an open cycle. Configure templates under Setup → Workforce → Review Templates, with sections and questions beside them. A template with no required question cannot open a cycle; retire a template with its active switch instead of deleting it once it has opened cycles.

## Answering, calibrating, sharing, acknowledging

Only the reviewer submits their review: required answers must be present and every rating inside the template scale, or the submit names the question to fix. Calibration sets a second rating beside the author's — the original is never overwritten — with a reason, and only HR calibrates. Sharing hands a manager or peer review to its subject; while the cycle calibrates, sharing is refused so nothing leaks mid-round. The subject acknowledges a shared review. A submitted or calibrated review reopens with a reason; a shared review never reopens — correct it forward in a new cycle.

## Who sees a review

A review is visible to its subject only once shared, to the manager only through the reviews they author on their reports, and to HR through the grant. Nobody else sees it: an unreadable review answers as missing, so its existence cannot be probed. Managers with reports and no grant still get the Performance tab, showing only their reviews. Goals follow the same shape: the subject, their manager, or HR.

## Goals

Goals live on the employment with a title, due date, weight, and progress from 0 to 100. Recording progress appends its evidence; achieving completes to 100 with its own evidence row; missing or cancelling needs a note. The review drawer surfaces the cycle-period goals beside the answers.

## Retention

Record the exit for a terminated employment: the reason, whether leaving was voluntary, whether the loss is regrettable, whether you would rehire, the exit interview (held date with its interviewer — always a pair), and destination and notes. Recording is refused while the employment has no termination version: terminate first through an approved employment change, then record the exit. One record per employment; correct it with an update.

Turnover is terminations over average headcount per period and department, with the voluntary split, the regrettable share, and the median leaver tenure. Headcount legs reuse the canonical as-of read, so turnover callers hold the employment read grant beside the retention grant. Leavers without an exit record count as involuntary until recorded — the coverage figure names the gap instead of hiding it.

## Reporting and assistance

The Reviews, Goals, and Turnover workforce reports read the same governed rows as the tab: ratings distribution per cycle and department, goal progress, and leaver facts by termination month and department. The assistant read tools answer cycle and attrition questions from the same canonical read services, so the numbers always agree.
`,
}
