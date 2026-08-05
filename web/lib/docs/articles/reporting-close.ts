import type { DocArticle } from '../types'

export const financialReports: DocArticle = {
  slug: 'financial-reports',
  title: 'Reports and Ledger Detail',
  category: 'reporting',
  order: 1,
  summary: 'Run financial statements, aging, registers, ledger detail, budget, order, and project reports.',
  updated: '2026-07-21',
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
  body: `# Reports and Ledger Detail

The **Reports** hub groups statutory statements, ledger reports,
subledger reports, budgets, orders, projects, and custom reports.

## Paper report workspace

Every report result opens on the same in-app paper surface: organization name,
report title, reporting period or description, summary figures when present,
and the report body. This includes statements, detail reports, drill-downs, and
reports created in the custom report builder and results from saved views. Wide
reports expand to the available canvas while retaining the same paper header
and document styling.

Report tables use the financial-statement presentation throughout: unboxed
rows, a single rule beneath column headings, document typography, right-aligned
tabular amounts, uppercase section labels, and accounting rules for subtotals
and totals. They do not use the shaded, bordered, hoverable tables used by
record lists elsewhere in the application.

The custom report builder uses this surface for its live preview, and **Run
now** displays the finished custom report on it. Filters and actions remain in
the page toolbar; printable report content remains on the paper.

Every standard and custom report uses the same compact toolbar as **Profit &
Loss**. Search, report modes, dates, dimensions, saved views, and export actions
stay inside that single non-wrapping row. On a narrow screen, scroll the toolbar
horizontally; controls never move into a separate second row.

Reports with collapsible account or customer sections add **Expand all** and
**Collapse all** to the toolbar's **Options** menu. These actions affect every
collapsible section currently displayed without changing the report filters.

## Drill into report values

Select any amount, count, quantity, percentage, or other numeric result to open
its supporting records in a drawer. The report remains visible underneath with
its filters, comparison columns, pagination, and scroll position intact. This
works consistently for standard financial statements, aging and register
reports, operational reports, custom reports, and saved views.

Select a transaction in the supporting-record drawer to open the transaction's
normal record flyout as a second layer. Close the record to return to supporting
records, then close supporting records to return to the unchanged report. The
record flyout applies the same role, organization, subsidiary, and form-layout
rules as opening the record from its owning module.

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
business record and its ledger entry together without navigating away from the
report.

## Other reporting areas

Budget reports compare actual and planned amounts. Order reports show non-posting
commercial commitments. **Project Profitability** groups customer subtotals with
each job underneath, combining project revenue, cost, margin, and approved hours.
Use the **Customer**, **From**, and **To** filters to isolate the exact customer
and accounting window under review. Every subtotal and job amount can be opened
in supporting detail without leaving the report.

## Save and export

Save frequently used report parameters as a reusable view. Export formats are
intended for distribution and analysis, but the in-app report and underlying
ledger remain the authoritative source. Record the exact filters and run date in
close evidence so another reviewer can reproduce the result.

## Scheduled delivery and evidence

An active custom-report schedule requires at least one validated recipient. The
cadence is interpreted in the selected IANA time zone. When an occurrence is
due, OpenBooks first commits a unique scheduled run and advances the schedule in
the same database transaction. The background queue is only a dispatcher: if it
is unavailable after that commit, the worker rebuilds it from the durable run
outbox instead of losing or duplicating the occurrence.

The worker applies the schedule's saved filter override, renders the report once,
and retains the exact PDF bytes, filename, size, and SHA-256 hash as immutable run
evidence. It then creates one delivery record per normalized recipient. Email
attempts use bounded exponential retries and record queue job ids, attempts,
provider message ids, suppression reasons, errors, and final sent times. Sandbox
organizations and tenants without configured email are recorded as **Suppressed**
rather than reported as successful sends.

In **Recent runs**, use **PDF evidence** to retrieve the exact rendered artifact.
The delivery column distinguishes sent, failed, and suppressed recipients; a
successfully rendered report is not presented as proof that every recipient
received it. Formulaic queue retries do not create new report runs or artifacts.

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
  related: ['financial-reports', 'switching-from-enterprise-systems', 'apps'],
  body: `# Analytics, Dashboards, and Saved Views

OpenBooks offers several reporting surfaces because financial statements,
operational monitoring, and reusable record searches solve different problems.

## Reports

Use **Reports** for governed statements, ledger detail, aging,
registers, budgets, orders, project profitability, and custom financial reports.
These reports should be the basis of formal close and external reporting.

## Analytics

Use **Analytics** for focused operating and risk views such as cash flow,
financial health, customer intelligence, spend velocity, utilization, vendor
performance, true cost, and anomaly monitoring. Each view should be read in the
context of its filters and configured thresholds.

## Dashboards

Use **Dashboards** to assemble organization-relevant cards and dashboards.
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
  updated: '2026-07-20',
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
approval requirements. **Close Monitor** can help surface readiness issues
before the formal run begins.

Typical preparation includes bank reconciliation, AR and AP reconciliation,
inventory and fixed-asset review, tax review, accruals, revenue recognition,
foreign exchange, intercompany, payroll, suspense accounts, and management
variance review.

## Run the checklist

Start the period from **Accounting → Period Close**. Complete tasks in dependency
order, attach evidence, resolve exceptions, and obtain required reviewer
sign-offs. The workspace records events and evidence for the close run.

Each incomplete checklist card includes **Take action**, which opens the
workspace where the underlying work is performed. Return to the close run and
**Revalidate** after posting, reconciling, or correcting records. A task is only
complete when its configured completion rule, evidence requirement, and review
gate are satisfied.

Do not mark a task complete merely because an export exists. Confirm the report
scope, explain differences, and retain the reconciliation or approval that proves
the result.

## Configure close approval

Close approval uses the same visual flow system as other governed records. Go to
**Administration → Flows**, filter to **Period close run**, and edit the enabled
flow. The default flow has one independent approval gate. A smaller organization
can keep that single gate; a larger organization can add sequential gates or an
**All must approve** gate with several assignees. Conditions can route month-end,
quarter-end, year-end, books, readiness scores, or exception counts differently.

The **Request approval** action evaluates every enabled matching close flow and
places its gates in **Approvals**. Approval fails closed when no gate is produced
or an assignee cannot be resolved. The run initiator cannot decide any close gate,
even if a flow gate is authored to permit self-approval. This separation is an
accounting invariant.

Every approval is tied to the validated ledger fingerprint. If ledger data changes
while review is pending or after final approval, open gates are cancelled, prior
sign-off is invalidated, and the run returns to review. Revalidate the close,
repeat affected work, and request a new approval round.

## Lock and publish

Module and accounting locks prevent new activity or amendments in the closed
scope. Approval and publication should occur only after the reporting package is
reproducible and named reviewers accept the result.

After the final configured gate approves, use **Lock period** to apply subledger
locks before the GL lock. The **Publish package** button remains visible on the
Publish stage throughout the run; it becomes available only after the period is
locked, so the required next step is always clear.

## Reopen carefully

Reopening is a controlled exception requiring the appropriate permission and
business reason. Identify every report, reconciliation, downstream period, and
stakeholder affected. Make the correction through the governed transaction path,
repeat affected close tasks, and close the scope again.

For a correction after statements were issued, a reversal and correcting entry
in an open period is often preferable because it preserves the original close.
Follow the organization's accounting policy.

The original journal remains part of every financial report after its lifecycle
status changes to **reversed**. Reports include it together with the linked
posted reversal; excluding the original would report the reversal as new
economic activity instead of a cancellation.
`,
}
