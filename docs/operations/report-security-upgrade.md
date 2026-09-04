# Reporting integrity upgrade

This change closes the reporting authorization, fractional package pricing,
non-additive report total, test discovery, and test shutdown defects identified
in the September 2026 repository review.

## Authorization and retained evidence

Interactive report execution obtains its current principal and organization
from the shared authorization context. The compiler adds a server-owned
subsidiary predicate independently of user filters. Every report entity declares
its subsidiary policy; an empty allowlist produces no tenant transaction rows.
Organization-shared catalog records remain available according to that entity's
explicit policy. Role assignments from another organization cannot expand the
current organization's subsidiary access.

Each retained run now contains immutable authorization evidence: the original
report definition, initiating user, and subsidiary scope. Download authorization
checks today's permissions against that original definition and scope. Editing
a definition cannot relabel old payroll or broader-scope output as ordinary
report data.

Schedules require the report's data permission, preserve an execution principal,
and snapshot the definition and scope. Execution reloads active membership,
permissions and feature gates. Permission grants cannot widen an existing
schedule's scope; authorized schedule edits refresh its snapshot. Delivery
rechecks authorization immediately before sending, records failures durably,
and preserves existing accepted-message reconciliation behavior.

## Migration and rollout

Use the standard [upgrade runbook](upgrades.md). Pause report-producing workers,
apply bootstrap migrations, deploy the matching web and worker versions, then
resume workers after checking authorization and delivery behavior. The worker
must reach the web application's internal render endpoint using the configured
internal URL and token, including the new authorization-only request.

- `0086_report_authorization_evidence.sql` adds evidence columns and prevents
  changing a run's original authorization snapshot. Existing report bytes and
  schedules remain stored. Historical artifacts without evidence are denied;
  regenerate them under an authorized user. Existing schedules require an
  authorized edit before they can execute. Do not infer old scope from today's
  mutable report definition or backfill invented authorization evidence.
- `0087_charge_rate_fraction_evidence.sql` widens component display quantities
  to eight decimals and adds an exact numerator/denominator snapshot. It
  preserves historical money and legacy components with SQL NULL evidence.
  The governed query view is recreated transactionally with its existing
  projection, owner, options, grants and comments. Unexpected dependent views
  stop the migration without a cascading drop.

The migrations are forward-only. An older application restores the original
security defects and is not a supported application-only rollback. Follow the
recovery-set rollback procedure if the deployment must be reverted.

## Calculations and report presentation

Capped-ladder pricing carries the package fraction into money multiplication and
rounds once at ledger precision. For example, 0.0001 base units at 300 per
three-unit package produces 0.0100, a displayed component quantity of
0.00003333, and retained exact fraction 1/30000. Usage below the supported
component display precision is refused explicitly. Previously posted amounts
are not rewritten; correct affected business transactions through the existing
controlled correction workflow.

Distinct counts are non-additive. Grouped distinct counts remain available,
but section/grand totals and summary cards no longer sum overlapping
populations into a misleading distinct total.

True Cost analytical output is registered in the Reports hub and uses the
shared filter, paper, saved-view, export and schedule components. Its former
analytics URL redirects to the report. Interactive recovery/selling planning
and configuration remain available from their respective module/setup pages.

## Verification

Verification uses disposable PostgreSQL 16 databases and Node 24. The clean
lockfile install, workspace typechecks, production build, canonical test
partitions, runtime-role report regression, browser smoke tests and migration
replay checks cover this change. The canonical runner now includes TSX/MJS
files and escapes bracketed route names so Node actually executes them. It
captures fixture-owner completion before shutdown and sets failure status
before cleanup, preventing failed test runs from reporting success.

Recorded validation for this change:

| Check | Result |
| --- | --- |
| Canonical unit suite | 3,012 passed |
| Full database test population | 1,231 passed; both runtime-connection-dependent cases also passed separately |
| Focused report/UI/authorization contracts | 26 passed |
| Runtime-role report regression | Passed, including cross-organization role isolation |
| All 19 report entity scope predicates | Executed against PostgreSQL with restricted and empty scope |
| Browser smoke/accessibility suite | 10 passed |
| Manual production-build checks | Native report, planner, schedule drawer, CSV and PDF verified |
| Clean Node 24 lockfile install, workspace types, production build | Passed |
| Lint and type-debt ratchets | Zero lint errors, 734 warnings, 400 explicit-any nodes |
| Forward migration replay | View projection, owner, ACLs, options and comments preserved; malformed fraction evidence rejected |

The full database test run exposed a shutdown protocol error after all test
cases passed. The newline-framed close request now keeps its write side open
until the owner's asynchronous acknowledgement arrives. Both message-order
regressions and the real canonical owner lifecycle were checked after the fix.
The full-population receipt recorded 765 leases and 765 releases, four fixture
teardowns, zero active leases, and zero leak detections.

This remediation is not a claim that every ERP workflow, jurisdiction,
third-party integration or competitive feature has been independently certified.
The review's broader maintainability and product-maturity assessment still
applies; existing numerical analytics and large domain services need continued
focused engineering rather than an unverified wholesale rewrite.
