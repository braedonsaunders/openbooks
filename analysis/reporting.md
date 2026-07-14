# Reporting requirements — distilled from 247 saved searches + 25 financial layouts

The saved searches are the de-facto spec for openbooks' reporting engine:
what the business actually asks its ERP, daily.

## Searches by record type

| Target | Count | Share |
|---|---|---|
| Custom records | 113 | 46% (mostly implementation-era; low migration value) |
| Transaction | 97 | 39% — the real workload |
| Time | 8 | |
| Employee | 7 | |
| Vendor | 5 | |
| Item / Account / Customer / Job | 12 | |
| Other | 5 | |

## The searches that matter (business-critical set)

Approval worklists: Vendor Bills Pending Approval (per approver: Kara),
Approved Vendor Bills Pending Review (Melissa), Expense Reports to Approve
(Kara/Monica), Payments to Approve (Kevin), Journal Entries lines review.
→ per-person worklists must be a single query over the approval engine, not
hand-built saved searches per employee.

Job costing / billing: AdminApp — Get Job Transactions, Get Timesheet Vendor
Bills (integration feeds for adminapp2), BIT Real Labor, BIT Payroll JE for
Labor Burden, BIT Post Time Validation, BIT Project Could be Invoiced
(billing-readiness check), BIT Opening Balance.

AR/AP operations: Invoices Pending to be Emailed (scheduled email trigger),
Expense Report Not Paid in Full, Age of Paid Invoices by Vendor, Overdue
Invoices day-16 reminder, Expense Report by Account for Corp Card.

## Patterns → engine requirements

1. **Dimensions actually sliced by**: Job/Project (dominant), GL account
   hierarchy, Entity (approver/vendor/employee), Cost type
   (labor/material/overhead), Period + aging buckets, Approval status.
2. **Grouping/summary**: by vendor, account, project, employee, transaction
   type — the engine needs group-by + summary rows natively.
3. **Scheduling/email**: several searches drive scheduled emails (invoice
   sending, approval reminders, DMT summaries). Reports need cron + email
   delivery + "feeds an integration" (adminapp2 consumed searches via API —
   openbooks reports must be API-addressable).
4. **Workbook evidence**: the primary SuiteAnalytics workbook is an
   Account (hierarchical rows) × ProjectTask (columns) pivot of accounting
   impact, filtered by entity — i.e., **Account × Project matrix with
   hierarchy roll-up is the flagship report**.

## Financial layouts (25)

9 custom balance-sheet variants + 16 custom income-statement variants (CA):
row structures are heavily customized — custom P&L groupings decoupled from
raw COA order. openbooks needs **statement layout definitions as data**
(row = account-set + formula rows + subtotals), not hardcoded statements.

## Must-have report types (v1 targets)

1. Approval worklists (role/person)
2. AR/AP aging with bucket config
3. Project profitability (job × cost type × period, estimate vs actual)
4. P&L / Balance Sheet with custom layout engine + dimension filters
5. Trial balance (the NetSuite parallel-run diff artifact)
6. Account × Project pivot with hierarchy roll-ups
7. Labor/time validation views (payroll prep)
8. Scheduled + emailed + API-consumable variants of all of the above
