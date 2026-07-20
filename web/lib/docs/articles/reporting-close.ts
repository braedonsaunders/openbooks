import type { DocArticle } from '../types'

export const financialReports: DocArticle = {
  slug: 'financial-reports',
  title: 'Financial Reports and Ledger Detail',
  category: 'reporting',
  order: 1,
  summary: 'Run financial statements, aging, registers, ledger detail, budget, order, and project reports.',
  updated: '2026-07-19',
  keywords: [
    'reports',
    'profit and loss',
    'balance sheet',
    'cash flow',
    'trial balance',
    'general ledger',
    'aging',
    'register',
  ],
  related: ['accounting-model', 'analytics-and-saved-views', 'period-close'],
  body: `# Financial Reports and Ledger Detail

The **Financial Reports** hub groups statutory statements, ledger reports,
subledger reports, budgets, orders, projects, and custom reports.

## Core statements

- **Profit & Loss** explains income and expense over a period.
- **Balance Sheet** shows assets, liabilities, and equity as of a date.
- **Cash Flow** explains movement in cash by activity.
- **Trial Balance** lists account debit and credit balances for the selected
  scope.

Use consistent book, subsidiary, date, currency, and dimension filters when
comparing reports. A difference caused by scope is not an accounting difference.

## Ledger and subledger reports

The **General Ledger** and **Journal** reports provide entry and line detail
behind account balances. Receivables and payables aging, registers, and partner
reports explain control-account balances by transaction and party.

Drill from a report to the source transaction where available. Investigate the
business record and its ledger entry together.

## Other reporting areas

Budget reports compare actual and planned amounts. Order reports show non-posting
commercial commitments. Project profitability combines project revenue, cost,
backlog, and configured profitability measures.

## Save and export

Save frequently used report parameters as a reusable view. Export formats are
intended for distribution and analysis, but the in-app report and underlying
ledger remain the authoritative source. Record the exact filters and run date in
close evidence so another reviewer can reproduce the result.

## Report review

Before issuing statements, reconcile the trial balance to subledgers, review
unexpected account signs and period movement, confirm retained earnings and
foreign-currency treatment, and preserve the final report package with approval
evidence.
`,
}

export const analyticsAndSavedViews: DocArticle = {
  slug: 'analytics-and-saved-views',
  title: 'Analytics, Dashboards, and Saved Views',
  category: 'reporting',
  order: 2,
  summary:
    'Choose between financial reports, operational analytics, dashboard cards, custom reports, and reusable record views.',
  updated: '2026-07-19',
  keywords: ['analytics', 'dashboard', 'insights', 'saved search', 'saved view', 'custom report', 'KPI', 'query'],
  related: ['financial-reports', 'coming-from-netsuite', 'apps'],
  body: `# Analytics, Dashboards, and Saved Views

OpenBooks offers several reporting surfaces because financial statements,
operational monitoring, and reusable record searches solve different problems.

## Financial Reports

Use **Financial Reports** for governed statements, ledger detail, aging,
registers, budgets, orders, project profitability, and custom financial reports.
These reports should be the basis of formal close and external reporting.

## Analytics

Use **Analytics** for focused operating and risk views such as cash flow,
financial health, customer intelligence, spend velocity, utilization, vendor
performance, true cost, and anomaly monitoring. Each view should be read in the
context of its filters and configured thresholds.

## Dashboard Builder

Use **Dashboard Builder** to assemble organization-relevant cards and dashboards.
Keep the number of headline metrics small enough to scan. A dashboard calls
attention to a condition; it does not replace the supporting report or ledger.

## Saved Views

Use **Saved Views** for reusable record selections and filters—the closest
concept to a saved record search. Give shared views clear names, document their
business purpose, and avoid creating several nearly identical definitions.

## Query and custom reporting

Authorized builders can create custom reports or use the SELECT-only query
surface for governed analysis. Query access reads the organization's real
PostgreSQL data through a restricted role. Validate custom calculations against
native reports before others rely on them.

## Choosing the right surface

Use a financial report to answer **what posted to the books**, a saved view to
answer **which records meet these conditions**, and analytics to answer **what
operating pattern deserves attention**.
`,
}

export const periodClose: DocArticle = {
  slug: 'period-close',
  title: 'Period Close',
  category: 'banking-close',
  order: 2,
  summary: 'Prepare, execute, approve, lock, publish, and—when governed—reopen an accounting period.',
  updated: '2026-07-19',
  keywords: [
    'period close',
    'month end',
    'close checklist',
    'lock',
    'reopen',
    'signoff',
    'evidence',
    'continuous close',
  ],
  related: ['banking-and-reconciliation', 'financial-reports', 'audit-log'],
  body: `# Period Close

Period close turns a set of completed reconciliations and reviews into a governed
accounting lock. It is not only a date switch.

## Prepare the close

Before starting, confirm the accounting book and period. Review the configured
close blueprint, task owners, dependencies, target date, reporting package, and
approval requirements. **Continuous Close** can help surface readiness issues
before the formal run begins.

Typical preparation includes bank reconciliation, AR and AP reconciliation,
inventory and fixed-asset review, tax review, accruals, revenue recognition,
foreign exchange, intercompany, payroll, suspense accounts, and management
variance review.

## Run the checklist

Start the period from **Accounting → Period Close**. Complete tasks in dependency
order, attach evidence, resolve exceptions, and obtain required reviewer
sign-offs. The workspace records events and evidence for the close run.

Do not mark a task complete merely because an export exists. Confirm the report
scope, explain differences, and retain the reconciliation or approval that proves
the result.

## Lock and publish

Module and accounting locks prevent new activity or amendments in the closed
scope. Approval and publication should occur only after the reporting package is
reproducible and named reviewers accept the result.

## Reopen carefully

Reopening is a controlled exception requiring the appropriate permission and
business reason. Identify every report, reconciliation, downstream period, and
stakeholder affected. Make the correction through the governed transaction path,
repeat affected close tasks, and close the scope again.

For a correction after statements were issued, a reversal and correcting entry
in an open period is often preferable because it preserves the original close.
Follow the organization's accounting policy.
`,
}
