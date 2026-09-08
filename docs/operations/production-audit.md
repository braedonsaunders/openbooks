# Production audit — continuing review

This is the repository-wide review requested by the owner. It covers security,
financial integrity, lifecycle behavior, maintainability, feature depth and
operability. It is not a certification or a claim that every source line has
been manually reviewed. A passing suite is evidence for its exercised cases.

The earlier report/payment corrections are recorded in the adjacent operational
notes. They do not close this audit. The current baseline is `9e7282d0`.

## Inventory and complexity

The tracked TypeScript, JavaScript and SQL inventory contains 2,875 files and
707,119 physical lines, including 169,439 test lines and generated migrations.
There are 398 API route files and 177 page files. The inventory script parsed
production TypeScript/JavaScript and recorded 24,918 function-like nodes,
including callbacks. These are size measures, not proof of implementation depth.

A branch-count triage (if/loop/case/catch/conditional and boolean-coalescing
operators, excluding nested functions) identifies these review concentrations:

| Location | Function | Lines | Decision nodes |
|---|---|---:|---:|
| `web/app/api/admin/setup/[entity]/route.ts` | validateEntityIntegrity | 485 | 257 |
| `web/app/(app)/parties/PartyDrawer.tsx` | PartyDrawer | 1,250 | 186 |
| `web/lib/billing.ts` | billing transaction callback | 724 | 161 |
| `web/app/api/assets/[id]/route.ts` | PATCH | 330 | 137 |
| `web/lib/cash/core.ts` | categoryWeekly | 506 | 127 |
| `web/lib/analytics/spend-velocity-data.ts` | spendVelocityData | 619 | 110 |

Large functions are review priorities, not automatically defects. Refactoring
must preserve transaction boundaries and shared policy. The recurring defect
pattern is policy divergence between entry points: resolving Authz is not enough
when downstream code ignores its subsidiary scope. Source-pattern tests alone
have not prevented that divergence.

## Domain coverage

“Traced” means the listed entry point and relevant downstream implementation
were inspected; it does not mean every workflow in that domain was audited.

| Domain | Current evidence | Further work |
|---|---|---|
| Identity and sessions | API-key scope intersects current owner permissions; MFA routes require sessions/origin and reauthentication; shared RLS context inspected | Full session revocation, recovery, OIDC and impersonation adversarial journeys |
| Extensions and REST | App bridge carries user permission intersection and subsidiary scope; raw SQL refuses restricted scope | Trace each bridge/tool operation, script effects and token revocation |
| GL and period close | Consolidation API and rate/ownership/elimination services traced; revaluation carries subsidiary scope | Reopen/close segregation of duties, consolidation input/write population and concurrency |
| Tax and statutory reporting | Provision list/detail/compute/post, return render/export, filing creation/export/finalization and nexus compared | Authorization parity across all transports; independent jurisdiction acceptance |
| Revenue and subscriptions | Recognition passes scope to project sync and posting; basic versus advanced subscription boundaries compared | Amendment/replay/renewal scope, billing atomicity and historical contracts |
| Inventory | Action dispatcher carries scope and idempotency; prior FIFO regression and costing suites passed | Advanced actions, lots/serials, transfers, landed cost and returns under contention |
| Assets | Depreciation API, asset edit boundary and financial-input validation inspected | Date validation, disposal/remeasurement and schedule changes across books |
| Projects and time | Project-charge APIs validate entity/feature scope; timesheet approval pins employee and delegates atomic financial effects | End-to-end charge/time/billing corrections, SOV, WIP, retainage and subcontracts |
| Payroll | Remittance aggregate guard and run scope reviewed; existing statutory and posting suites | Filing/provider acceptance, all setup and pay-run lifecycle boundaries |
| AP/AR and banking | Earlier payment visibility, allocation, concurrency and bank-file lineage regressions; current suites | Remaining delivery/settlement failure windows and full procurement/order journeys |
| CRM | Forecast calculation and its API/page/cockpit callers traced | Scope parity across records, activities, quotes and related documents; sales-team workflows |
| Property management | Workspace filters property-derived children; bulk billing refuses restricted callers | Deposit/CAM/lease transitions and concurrent effective-dated edits |
| Reports and analytics | Prior runtime permission, artifact lineage and scope regressions | Remaining dashboard drilldowns, exports and statistical calculations |
| Files and audit | Existing private-folder, attachment, purge and audit-rollback tests; backup boundary inspected | Full app/report/file privilege composition and restore coverage |
| Migrations and operations | Forced-RLS/runtime role controls and backup queue failure compensation inspected; prior clean bootstrap/build evidence | Real restore/failover/object-storage exercises, load and rollout evidence |
| UI and feature depth | Shared registries exist; large drawers and bespoke analytical tables remain maintenance concentrations | Critical business journeys, accessibility, locale coverage and shared-component consistency |

## Confirmed findings and corrections

- **Consolidation:** the organization-wide derive/ownership/elimination commands
  discard the caller's subsidiary scope. Their services read and affect the
  whole subsidiary tree. A scoped close operator needs an explicit denial at
  this boundary; filtering only an elimination target would be insufficient.
- **Tax provisions:** detail reads project entity workpapers, but the list and
  its server page expose consolidated totals. Creation replaces an org-wide
  draft without an equivalent scope gate. Posting checks only the root entity,
  although the current engine posts and reverses entries in every entity.
- **Tax returns/filings:** return calculation/export and filing creation/export
  expose complete organizational positions, while finalization already refuses
  restricted callers. Earlier transports must enforce the same boundary.
- **Advanced subscriptions:** workspace reads, activation and amendment omit
  the customer-derived scope enforced by the basic subscription routes. The
  cotermination anchor is a second record boundary too.
- **Entity-only tax inputs:** the measured-entity selection omitted entities
  whose only inputs were nested permanent or temporary differences. Such an
  entity disappeared from the provision instead of contributing its tax charge.
- **Subscription amendment windows:** changing/removing a component on its first
  effective day creates an inverted inclusive date window and an unhandled SQL
  constraint failure. Refuse this explicitly before mutating contract history.
- **Report localization:** the weekly-timesheet catalog entry was a string in
  all seven locales, while consumers require label/description fields. Browser
  rendering logged missing messages despite the old catalog test passing. The
  entries now match the shared shape, and the test checks both usable fields.
- **SFTP host identity:** the installed dependency can emit malformed Ed25519
  keys when its DER conversion strips leading public-key zeros. Generated keys
  are now parsed before persistence, with bounded regeneration and explicit
  failure. Deterministic tests cover invalid output and exhaustion.
- **CRM record boundaries:** account and opportunity lists had scope filters,
  but direct reads/edits and quote conversion could bypass them. Linked documents
  and activity relationships could expose hidden records. Shared scope predicates
  now cover list, drawer, API, relationship, and mutation paths; writes recheck
  scope under their record lock. Activities inherit every related record boundary.
- **CRM forecasts:** the actuals query reads all posted customer invoices in
  the selected owner/team period without subsidiary authorization. Its API,
  retained snapshots, page and customer cockpit require consistent handling.
- **Asset depreciation:** an explicitly malformed date silently becomes today's
  date, allowing a financial posting command to execute for a different period
  from the caller's request. Invalid dates must be refused; only omission may
  select the default business date.

The regression suite is `web/lib/domain-boundaries.integration.test.ts`. It uses
real PostgreSQL records, constrained runtime connections and role permissions;
only session identity and server translation loading are substituted. All 18
cases fail against the baseline implementations and pass with these corrections.
Cases include unrestricted success, restricted success, zero visibility, scope
revocation on replay, retained snapshots, related records and date validation.

Concrete before/after examples:

- A scoped forecast included 1,000 of invoices when only 100 belonged to the
  visible subsidiary. It now returns 100; unrestricted access still returns 1,000.
- The tax list returned a consolidated expense of 60 while its scoped detail
  returned 20. Both now return 20 to that reader; unrestricted access retains 60.
- A subsidiary with only nested manual tax adjustments was omitted entirely.
  Its 40 tax charge now participates in the consolidated total of 60.
- A hidden advanced subscription could be activated through the API. The request
  now returns 404; an authorized activation and idempotent amendment still succeed.
- Malformed depreciation dates returned 200 after substituting today's date.
  They now return 422; valid dates and intentional omission remain supported.

## Verification and operational limits

The isolated organization restore drill passed both cases after a fresh
bootstrap. It exported, removed and restored disposable tenant records, checked
posted-ledger balance and encrypted credential integrity, and refused invalid
archive inputs and outbound cross-organization references. This verifies the
organization archive mechanism, not deployment failover or object-storage recovery.

Final local verification passed:

- 3,020 unit tests; the tightened locale-catalog checks also passed after the
  browser-discovered translation correction.
- 1,270 database tests, including all 18 new boundary cases; zero failures,
  cancellations or skips. Fixture receipt: 806 leases/releases/resets, four
  bootstraps/teardowns/schema verifications and zero leaks.
- Workspace typechecks, production build and all 11 browser tests. The final
  browser run no longer emitted the missing weekly-timesheet catalog messages.
- Both isolated backup/restore cases, and deterministic SFTP host-key tests.
- Lint warning ceiling, repository-artifact and product-neutrality checks;
  explicit-any remains at 399.

The prior baseline also completed GitHub CI successfully. These local results
apply to this correction batch; its new GitHub run is separate evidence.
No production data or deployment was changed. No migrations or protected sync,
posting, entry-number or swarm-release files were edited.

The remaining coverage column above is still open. In particular, live provider
acceptance, full object-storage recovery, production-scale performance, session
recovery adversarial journeys and complete business journeys have not been proved
by this pass. The absence of an observed defect in those areas is not a pass.

## Feature depth and competitiveness

The earlier review established meaningful GL/AP/AR, multi-entity/currency,
projects/construction, inventory/assets, revenue, payroll, tax workpapers,
property management and extension infrastructure. This breadth is worth
preserving. It does not establish parity with established enterprise ERP suites.

The repository still declares full manufacturing/MRP, broad HCM, native mobile
and offline workflows, and universal certified filing as outside implemented
coverage. Published conformance cases explicitly distinguish supported behavior
from semantic or partial coverage. Installation, migration, closed-period
reconciliation, recovery, large-ledger performance and acceptance by external
providers remain essential competitive evidence. Adding navigation entries or
counting passing tests does not substitute for those outcomes.

An unrestricted production-readiness claim remains unsupported while confirmed
control defects or unverified critical operational journeys remain open.

The competitive comparison was refreshed against primary vendor documentation
on September 5, 2026. These are documented vendor capabilities, not independent
acceptance results. The primary-source bibliography is retained in the audit
evidence packet outside the vendor-neutral product repository:

| Benchmark | External capability | OpenBooks evidence and remaining bar |
|---|---|---|
| Multi-entity financial control | Consolidation, intercompany workflows, currency handling and role-based access. | Native equivalents exist, with targeted authorization, exact-money and reconciliation regressions recorded here. Repeated boundary defects show that module breadth alone does not establish consistent control. |
| Auditability and customization | Audit trails, access logs, workflow and customization are part of the documented platform. | OpenBooks has shared audit/extension machinery; the asset-editor fixes and open custom-field-definition findings demonstrate remaining entry-point gaps. Every material write must produce reliable evidence. |
| Production planning | Supply plans use demand, lead times and planning rules to recommend purchases and work orders. | The [repository's declared scope](../../README.md) explicitly excludes a full manufacturing/MRP suite beyond light assembly builds. This remains a capability gap, not something repaired by inventory bug fixes. |
| Scale and operability | The planning documentation itself recommends testing larger datasets and identifies workload-dependent limits. | OpenBooks needs measured workload limits, restore/failover results and representative large-ledger journeys. A clean build or test count does not provide that evidence. |


## Lifecycle review — continuation from 404697ee

This pass follows period-close operations across their HTTP, page, shared
application/MCP, assistant and cockpit entry points, then traces project invoice
rounding, subscription effective windows, and inventory transfer shipment/receipt.

Confirmed corrections:

- **Close authorization reflects actual effects.** A run's `scope.subsidiaryIds`
  targets locks; its readiness checks, fingerprint, retained evidence, reporting
  package and reopen invalidation are organization-wide. Previously, HTTP actions
  discarded caller scope and application/cockpit readers treated the target list
  as proof of isolated evidence. Those operations now require unrestricted
  organization visibility. Restricted list readers omit the run. Direct
  subsidiary lock changes remain available for an authorized entity, with global
  or hidden-entity changes refused. The setup page and assistant summaries enforce
  the same distinction. Published binders remain immutable, but downloads use
  `private, no-store` so subsequent requests recheck current access. The period
  list's journal count also respects its selected accounting book.
- **Project invoice currency precision.** The generator used a fixed two-decimal
  rounding quantum for every currency. It now reads the authoritative currency
  exponent, uses shared bigint rounding, and refuses unsupported precision.
  Positive and negative JPY draws of 100.5000 become 101.0000 and -101.0000;
  CAD retains two-decimal behavior. Rates retain their existing calculation
  precision; payable lines and document totals agree.
- **Subscription contract windows.** Replacing a bounded earlier component
  previously inserted an open-ended row, colliding with the already scheduled
  component. The replacement inherits the old end date. New open-ended additions
  cannot overlap existing or future components. Nonexistent calendar dates,
  missing required dates and unknown amendment types now produce domain errors
  before SQL writes. Accepted amendments retain before/after evidence and
  idempotent replay.
- **Transfer lifecycle and transit identity.** Shipment and receipt could precede
  their prerequisite dates. A default transit location was also selected again
  at receipt, potentially consuming a different stock position. Dates are now
  validated and ordered under the transfer lock. Shipment persists its actual
  transit location. Older unpinned shipments recover their location from immutable
  paired movements, refusing missing or ambiguous evidence. Receipt retains this
  recovered identity; no historical movement is rewritten.

New live-database regressions are in
`web/lib/close-lifecycle-authz.integration.test.ts`,
`web/lib/billing-currency.integration.test.ts`,
`engine/src/subscription-amendment-windows.integration.test.ts`, and
`engine/src/inventory-transfer-lifecycle.integration.test.ts`.
The initial baseline reproduction failed ten close/currency cases (CAD control
passed), all four subscription cases and all three transfer cases. The expanded
close tests also exercise the application adapter, assistant, cockpit and setup
page, unrestricted access and permission revocation. All targeted cases pass with
the corrections; verification logs are retained in thread storage.

A genuine subsidiary-scoped close package remains an explicit capability gap:
its diagnostic population, fingerprints, evidence, reporting and reopen effects
must all become entity-scoped together. This security correction does not claim
that the existing target list already provides that isolation. No migrations,
production data, deployment scripts or protected synchronization/posting files
were changed in this pass.

Final verification for this continuation passed:

- 3,021 unit tests, workspace typechecks, and the production build.
- 1,289 integration tests, zero failures/cancellations/skips; all 825 fixture
  leases were released and reset, with four bootstraps/teardowns and zero leaks.
- Three additional transfer regressions passed alongside all twelve existing
  inventory integration cases; these ran separately after the suite selected
  its file list.
- All 11 browser tests against the final build and a disposable runtime-role
  database. Build-source hashes match all sixteen changed production files.
- Lint passes its existing 733-warning ceiling; explicit-any stays at 399.

The preceding commit's restore drill is documented above; this pass did not
repeat restore or perform a production rollout. The wider audit remains open.

## Renewal, project markup and reopen controls — 2026-09-05 continuation

This continuation started from `284f1b04`. Four reproduced defects were corrected:

- **Subscription financial terms were silently coerced.** Fractional interval
  counts and renewal terms were truncated, invalid counts were clamped, and
  unknown intervals could become annual schedules. HTTP coercion also accepted
  booleans and arrays as numbers. Domain and HTTP boundaries now require exact
  positive integers within the persisted integer range, validate timing and
  renewal enums, and reject malformed dates and calendar overflow. Shared month
  arithmetic also preserves leap years before year 0100.
- **Project markup lost precision and ignored invalid configuration.** Rounding
  a percentage into a multiplier changed a 1.2345% markup on 100,000 from
  101,234.50 to 101,230. Applying the percentage directly with shared bigint
  helpers preserves the configured precision. Negative markup is honored;
  malformed configuration produces a controlled error without billing sources
  or completing the billing request.
- **Reopen approvals allowed intersecting scopes.** An organization-wide request
  and a subsidiary request could both be approved for the same period, book and
  modules. The overlap check now treats organization-wide scope as intersecting
  each subsidiary, under the existing period advisory lock. Concurrent approvals
  accept exactly one conflicting request; separate subsidiaries remain allowed.
- **Subledger reopening ignored inherited GL closure.** A subsidiary AP-only
  request could be approved while its governing organization-wide GL lock was
  closed. Approval now resolves the applicable GL lock, including expiration,
  and requires GL to be included when that lock blocks posting.

Before-change reproductions are retained alongside passing regressions in
thread storage under `audit-renewal-close-2026-09-05`. The final focused run passed
all 90 tests, with zero failures or skips, using a disposable PostgreSQL database.
It covers renewal retries, amendment persistence, HTTP validation, invoice
amounts, close approvals, concurrent reopen requests, and lifecycle authorization.
The canonical unit command passed all 2,997 tests. Workspace typechecks,
production build, and lint passed; existing lint warnings remain at 733 and
explicit-any usage remains at 399. All four changed production files match the
sources used for the isolated production build.

The complete integration and browser suites from the preceding continuation
were not repeated for this batch. No migrations, production data, deployment
scripts or protected synchronization/posting files changed. The earlier
capability gaps and broader audit remain open; this is evidence for these
corrections, not certification that the entire repository has no defects.

## Revenue, asset reversals, deposits and identity — continuation from 6d38737a

The next review traced recognition events through scheduling, multi-book posting
and cancellation, then asset reversal chains, property deposits and password
reset/MFA lifecycles. Reproduced defects and corrections:

- **Previously posted event periods dropped subsequent revenue.** Milestone and
  usage events now plan the period's total less its posted amount, appending
  new sequences for additions and negative corrections. Posted lines remain
  unchanged. Event recording, rebuilding and posting share the obligation lock;
  the public multi-book builder is transactional.
- **Recognition scope was applied only to the initial posting scan.** A shared
  subsidiary predicate now also governs diagnostics, locked posting claims,
  obligation completion and schedule status updates. Hidden contract names and
  hidden lifecycle changes are refused even with an explicitly supplied ID or
  an empty authorization set.
- **Forecast rules posted actual journals.** Both the scan and the locked claim
  now exclude forecast rules; their schedules and obligations remain forecasts.
- **Partial event recognition marked obligations satisfied.** Event-driven
  obligations require the allocated amount to be recognized on every schedule.
  Additional planned work reopens the obligation; cancelled obligations refuse
  new events and rebuilds.
- **Financial scheduling accepted silent coercion.** Unknown methods, malformed
  dates, invalid month starts, fractional terms/offsets, calendar overflow and
  out-of-range percentages now produce domain errors. Calendar arithmetic
  preserves early Gregorian leap years. Event amounts, unit rates and quantities
  require exact `numeric(19,4)` precision before persistence, preventing rounding
  from changing the amount or breaking an otherwise identical retry.
- **Restored assets could not be disposed again.** Disposal journals receive a
  unique identity while retaining their asset reference. The reversal-order check
  excludes source events already reversed, allowing newest-to-oldest correction
  without altering original journals. New event timestamps reflect the actual
  write time instead of a shared transaction-start time, and comparisons retain
  PostgreSQL precision. Ambiguous equal-time legacy sources fail closed.
- **Deposit reversals raced refunds.** Reversals now acquire the lease lock
  before reading the balance, matching receipts, refunds and applications. The
  regression holds a 150 refund uncommitted against a 200 balance while reversing
  a 100 receipt: the reversal must wait, see the remaining 50, and be refused.
- **Password reset left prior MFA authorization usable.** Reset now consumes
  pending login challenges and removes unfinished enrollment while preserving
  established factors. MFA completion follows the same user-lock order as login
  and reset; enrollment confirmation requires an active, unrevoked session.
  Tests prove old challenges and revoked enrollment sessions fail, while a fresh
  login using the new password and existing factor succeeds.

Before-change reproductions and passing focused runs are retained in thread
storage under `audit-revenue-assets-identity-2026-09-05`. Focused verification
passed 67 recognition/posting tests, 19 asset tests, 25 property tests and 23
authentication tests. These runs include pure helper tests and database
regressions using disposable PostgreSQL records and real domain functions. The
new authentication regressions substitute only the `server-only` import marker
and seed reset tokens directly, without sending email.

Broader verification passed 3,026 unit tests and 1,309 integration cases with
zero failures. The integration command skipped two Redis-dependent cases;
their entire 19-test outbox file subsequently passed with disposable Redis,
including both skipped cases. All 845 fixture leases were released and reset;
four fixture bootstraps and teardowns completed with zero leaks. The new asset,
deposit and authentication files were added after integration discovery and
passed separately as described above.

Workspace typechecks, the production build and all 11 browser tests passed.
Build-source hashes match all five changed production files. Production
dependency auditing reported zero vulnerabilities; container security checks
passed. Lint retains its existing 733 warnings and explicit-any remains at 399.

This continuation changes no schema, production data or deployment. The protected
synchronization, posting kernel, entry-number and swarm-release files remain
untouched. Broader provider acceptance, failover, load and remaining domain
journeys in the coverage table are still open.

## Revenue allocation and identity concurrency — continuation from 26306a79

This pass reproduced and corrected eight further defects:

- **Relative selling-price allocation ignored quantities.** Nine units and one
  unit at the same unit selling price incorrectly split a 1,000 contract into
  500 and 500. Allocation now uses exact extended selling-price weights and
  produces 900 and 100. It retains all eight document-quantity decimal places
  and does not round intermediate weights, including sub-money-unit products.
- **Contract totals omitted allocation-excluded lines.** Those obligations keep
  their booked amounts and now participate in the contract's transaction price.
  Mixed and entirely excluded bundles both retain the full contract total.
- **Zero allocation weights silently lost revenue.** A nonzero transaction
  price now requires a positive weight. Invalid negative weights are refused;
  negative total corrections with valid weights still allocate exactly.
- **Fair-value review rounded away violations.** Range comparisons now use
  exact cross-products, accept eight-decimal quantities, and detect violations
  smaller than one money unit instead of rounding them onto the boundary.
- **Partial legacy retries changed the allocation basis.** Restoring one missing
  obligation could turn a 500 + 500 allocation into 500 + 100. Repairs now use
  the whole bundle and refuse conflicts with surviving allocations or the
  stored contract total. Complete retries preserve their original pricing.
- **Concurrent reset requests bypassed issuance controls.** Eight requests with
  two recent tokens produced six total tokens and four usable links in the
  reproduction. Requests now lock the user before checking the hourly cap and
  superseding links. The same case leaves three total tokens and one usable
  link. Credentials and queued email evidence commit before provider I/O,
  releasing the identity lock before any potentially slow delivery.
- **A completed reset left other reset credentials usable.** Completion now
  locks the user before rechecking its token and consumes all outstanding reset
  links. Concurrent legacy links produce exactly one password change and one
  audit event; the other completion receives an invalid-token result.
- **Concurrent MFA enrollment could be bypassed.** Password login and both new
  and mapped OIDC login read MFA in the same statement that acquired the user
  lock. A blocked statement retained its pre-enrollment join result. All three
  paths now read MFA in a fresh statement after the user lock is acquired.
  Deterministic tests confirm the contender is waiting in PostgreSQL, commit
  enrollment, then require MFA before any session exists. The new factor can
  subsequently complete authentication successfully.

Focused verification passed 76 recognition/posting/allocation tests and 51
identity tests. Identity regressions use real PostgreSQL transactions; delivery
is replaced with an in-process recorder, so no email is sent. Before-change
failures and final receipts are retained under the thread-storage artifact
`audit-allocation-identity-concurrency-2026-09-05`.

The final canonical unit run passed all 3,034 tests. Engine and web typechecks,
the production build and all 11 browser tests passed; all three changed
production files match the build's sources. Lint remains at 733 warnings with
zero errors, and explicit-any remains at 399. The full integration suite from
the preceding continuation was not repeated; this batch's database cases ran
in the focused suites above. The temporary browser server and Redis stopped
after verification.

Existing revenue history is not rewritten automatically. An inconsistent legacy
contract needs controlled reconciliation rather than a silent repricing during
retry. This continuation changes no migrations, deployment or protected posting
and synchronization files. Remaining coverage in the domain table stays open.

## Inventory request integrity — continuation from efc1e400

The next review traced basic and advanced inventory HTTP commands through their
idempotency boundary and real stock/journal writes. Seven malformed requests
reproduced successful writes against the preceding implementation: an invalid
receipt date, invalid subsidiary IDs on receipt/transfer/voucher commands,
invalid adjustment cost, unsupported landed-cost allocation basis, and an
invalid lot reference. The handlers substituted defaults or discarded supplied
references instead of rejecting the instructions.

Both endpoints now compose the shared exact-money, UUID and calendar-date
validators before executing their existing domain commands. Omitted defaults
remain supported; malformed supplied values do not select another entity,
date, cost or allocation policy. Redundant coercion loops and the independent
request type declaration were removed. Required transfer/voucher/catalog
references receive validation errors before database casts. The shared calendar
validator also refuses year zero, which PostgreSQL date columns cannot store.

The regression pins the business clock into the fixture's open period, proving
that date rejection is validation rather than an incidental missing-period
failure. All seven cases fail against the earlier routes. Valid receipt,
transfer and landed-cost requests still succeed with omitted defaults, replay
identically, and leave balanced journals without duplicate movements.

GitHub's secret scanner flagged one hardcoded signing string in the preceding
MFA test. It was a disposable test value, not a production credential. Related
identity fixtures now generate signing keys in memory. The local secret scan
of every changed source file reports no findings; no scanner suppression or
history rewrite was introduced.

Focused verification passed 47 inventory, calendar-boundary and identity tests,
including the prior transfer/reversal/entity-ownership regressions. The final
production build and all 3,034 unit tests passed. Web typechecking passed and
the lint ceiling remains satisfied. The full integration and browser suites
were not repeated for this batch; their earlier receipts remain separate.
Before-change failures, passing results and source
hashes are retained in `audit-inventory-boundaries-2026-09-05` in thread storage.
No schema, deployment or protected synchronization/posting files changed.

## Recurring authorization and calendar integrity — continuation from 8c933465

The completed integration run of the preceding pushed commit passed 1,336 tests
with no failures and two Redis-dependent skips. Its disposable fixture owner
released all 872 leases, verified all four databases after teardown and reported
no leaks. This is separate evidence from the current corrections.

Nine live recurring API regressions reproduced subsidiary disclosure/mutation,
auto-post activation without `gl.post`, truthy-string posting coercion and
manual execution that posted despite the caller lacking posting authority.
Collection and detail routes now apply the shared subsidiary policy, validate
identifiers/dates/booleans, lock schedules and templates before mutation, and
retain atomic audit evidence. Enabling, reactivating or rescheduling automatic
posting requires posting authority. Manual execution also checks live engine
permissions and scope under the schedule lock, including deny overrides and
any narrower authority supplied by the HTTP entry point.

The web and engine now share one subsidiary restriction resolver. It preserves
unrestricted, list and subtree semantics and refuses inactive or absent users.
Engine permission checks resolve the identity from its home organization while
reading grants from the active organization; a platform administrator switching
organizations no longer loses permission solely because the home user row is
outside the tenant transaction.

Three additional PostgreSQL regressions failed against the old scheduler:
disabling a schedule or disabling auto-post while its candidate waited for a
lock still allowed the old policy to execute, and an invalid cron silently
became monthly billing. Claims now lock and re-read current configuration;
invalid recurrence records an error without advancing or creating a document,
and other schedules continue. Midnight daily cron no longer skips tomorrow.

Shared calendar arithmetic rejects impossible dates, fractional/unsafe offsets,
and overflow outside years 0001–9999. Early calendar years retain four digits
without JavaScript's year-1900 offset. Subscription month/year advancement also
preserves that canonical representation. Boolean validation callers in custom
fields, asset disposal and surcharge setup use the shared non-throwing predicate.

The next confirmed issue is independent: recurring template cloning omits tax
profiles and entity/custom-segment overrides. That remains open until its
regressions and correction land; this entry does not declare the audit complete.

Verification passed all 3,040 canonical unit tests, 110 focused domain/calendar/
authorization cases, and 29 identity/recurring cases after the final identity
resolver adjustment. Engine/web typechecks, the final production build, all 11
browser tests and all 19 Redis-backed outbox tests passed. The measured ceilings
fell to 398 explicit anys and 732 lint warnings (zero lint errors). The disposal
route test now exercises the real shared date predicate rather than reproducing
its implementation in a mock. The browser server and disposable Redis stopped
after verification. No schema, deployment or protected sync/posting files were
changed. Receipts and source hashes are retained in thread storage under
`audit-recurring-calendar-2026-09-05`.

## Recurring template source facts — continuation from 7cf7602e

Real database regressions confirmed that recurring invoices dropped their tax
group, gross input and override flag, and standing journals dropped subsidiary
and custom-segment assignments. Header custom segments were also omitted.
Generation now preserves those source facts, locks the template while reading
its header and lines, and writes tax components with the shared exact tax
calculator and evidence persistence helper before approval/posting. Tax rates
resolve on the occurrence document date; explicit overrides remain explicit.
An inactive/missing group member or missing inclusive input refuses generation
and rolls back the new document rather than inventing a tax result.

The new positive cases post both tax-code and grouped invoices and compare
exact AR, revenue and tax-control legs, including a rate changing from 13% to
15%. Standing journals retain their entity and segment overrides.

The execution-scope review also found that a visible journal header could
carry hidden intercompany lines. A shared recurring template predicate now
checks every affected line entity as well as the header across collection,
create, edit, delete and run paths. Eight HTTP regressions fail against the
preceding commit, including three real lock races. Mutations acquire template
locks before rechecking line scope in a fresh statement, so a predicate using
an earlier snapshot cannot authorize an entity introduced by a concurrent edit.

Focused verification passed 177 tests with one runtime-role case skipped; both
country-tax-pack tests then passed with the restricted runtime connection.
The next tax review independently reproduced two interactive billing defects:
a group silently loses disabled components, and an unrelated unrated active
code prevents use of valid codes. Those findings remain open for the next repair.

All 3,040 canonical unit tests, engine/web typechecks and the production build
passed for this correction. Lint and explicit-any ceilings remain at 732 and
398. Browser and full integration receipts from the preceding continuation
remain separate; this batch exercised the affected routes and accounting writes
through the real-database suites above. No migration, deployment or protected
sync/posting files changed. Evidence is retained in thread storage under
`audit-recurring-template-2026-09-05`.

## Interactive tax-profile completeness — continuation from 4f9513fe

Two database cases reproduced the next billing failures. An active group with
a disabled component computed only the remaining component's tax, and an
unrelated active code without an effective rate prevented loading any profile.
The map now retains only usable single-code profiles and excludes a whole
group if any member is missing, inactive or lacks an effective rate. Selecting
an unusable profile still fails before a financial write; unrelated valid
profiles remain available. Statutory zero rates remain valid.

Five new cases cover inactive, missing and lapsed rates, a complete group and
a zero-rate component. Together with tax posting and recurring source-fact
cases, all 17 focused tests passed. All 3,040 canonical unit tests, web
typechecking and the production build passed. Warning/type ceilings remain
732 and 398. Evidence is retained under `audit-tax-profile-2026-09-05` in thread
storage. Browser and full integration suites were not repeated for this small
shared calculation-map correction.

The broader order/lifecycle review then found millisecond-truncated revision
checks in sales-order issuance, order mutations and document void. The void
service also checks its token before acquiring the claim lock and accepts
impossible dates. Those are open findings for the next continuation.

## Exact order and void revisions — continuation from cee45822

Thirteen real-database regressions failed against the preceding implementation.
Order reads truncated PostgreSQL revisions to milliseconds; issuance, editing,
discard and void could accept a token superseded by one microsecond. Void checked
its revision before acquiring the aggregate lock, and conversion discarded the
HTTP token before its locked service call. Both could act on an edit committed
while the command waited. Explicit empty void dates silently selected today;
impossible dates escaped domain validation and failed later in PostgreSQL.

A shared revision formatter preserves all six fractional digits. Order readers
and locked mutation checks now use that opaque token, and conversion carries it
through to the service lock. Void acquires the parent lock before reading and
validating the revision and returns a 409 conflict without material effects.
Explicit invalid dates fail as domain errors; only an omitted date defaults.
Valid current-token issuance, void and quote conversion remain supported.

Focused verification passed all 67 cases, including the new lock races, exact
wire reads, positive lifecycle commands, three-digit token rejection, existing
credit controls, before-void rollback and atomic correction tests. All 3,040 canonical
unit cases passed with the transpiler cache disabled after an initial run
reported fewer cases. Engine/web typechecks, the locked-dependency production
build, all 11 browser tests and lint passed (732 warnings, zero errors; 398
explicit anys). Evidence is retained in thread storage under
`audit-document-revision-2026-09-05`. Browser and Redis processes stopped.

The next settings review found that the email configuration HTTP writer ignores
the engine's optional revision fence. Its reader and engine comparison also
truncate revisions. Those remain open until the settings continuation lands.

## Email configuration concurrency — continuation from d8393c67

Three PostgreSQL regressions reproduced a lost-update window in outbound email
configuration: the engine rounded revision tokens, the HTTP endpoint ignored
them, and saves inside one transaction reused its timestamp. The form now
echoes the exact revision; the endpoint requires and forwards it; the service
compares all six digits under the organization lock and advances its revision
on every save. Conflicts return 409 with no configuration or audit write. The
HTTP response uses the committed save result, avoiding a second read that could
return a different administrator's revision. Secret redaction and atomic audit
evidence remain covered by the existing database tests.

The next continuation has concrete party and project-task failures. The initial
party source inspection assumed raw timestamps were JavaScript Dates; the real
driver returns strings, and a valid party save succeeds. The actual reproduced
defect is a stale one-microsecond token overwriting a newer party name because
the precheck rounds both tokens and the SQL predicate uses the latest read.
WBS task reads and input parsing also discard microseconds, and repeated task
saves in one transaction reuse a revision. Those findings remain open.

Verification passed 17 focused email cases, all 3,040 canonical unit cases,
engine/web and E2E typechecks, the production build and all 12 browser tests.
The new browser case exercises successful save, a competing administrator,
stale refusal and reload/retry. The existing permission fake now matches the
service's committed-result contract. No outbound message was sent.

A stalled macOS unit worker was sampled at shutdown: Maglev waited for GC
while the main thread joined its compiler thread. The existing Darwin-only
test workaround now disables concurrent optimizing compilation as well as
Sparkplug. The restarted full suite finished normally. Linux CI and production
runtime flags are unchanged. Lint/type ceilings remain 732/398. Receipts live
in thread storage under `audit-email-revision-2026-09-05`.

## Party visibility and reviewed changes — continuation from 3a03e34e

The party regression confirmed a restricted reader receiving both visible and
hidden-entity invoices in its totals. Shared party reads now require subsidiary
scope and apply it to the parent, transaction counts, dates, currency totals and
additional subsidiary assignments. Directory counts, server-page drawers and
sales-representative pickers use the same visibility predicate. Scoped saves
replace only visible subsidiary associations; a separate baseline test proved
that the previous implementation deleted a hidden association. Unrestricted
readers retain the complete position; empty transaction scope produces no totals.

Party revisions now remain exact from read through the compare-and-set write.
The real driver returns timestamp text, so the initial theory that every valid
save failed was disproved. The actual defect was the millisecond precheck
accepting a stale token and then overwriting with the freshly read database
revision. The write now predicates on the caller's exact token.

Project task readers and request parsing preserve all six revision digits, and
accepted writes advance their token even inside one transaction. The task lock
now names only the task table: two independent editors previously upgraded
shared project locks and PostgreSQL rejected one with a 40P01 deadlock.

The document drawer now sends JSON and its current revision when discarding a
draft. Its previous empty request was rejected by the shared JSON parser. Both
interactive discard and void require the reviewed token, with the engine
checking it after taking the document lock. The void HTTP route previously
discarded a supplied stale token and returned 200 after voiding the document.
The new cases cover stale/missing refusal and successful current-token commands.

This continuation passed 38 focused cases, all 3,040 canonical unit tests,
engine/web and E2E typechecks, the production build, all 13 browser tests and
all 19 Redis-backed outbox tests. The new browser case creates a disposable
invoice and discards it through the actual drawer and confirmation dialog,
asserting the outgoing six-digit token. A fixture navigation mistake in its
first run was corrected before the successful run. Lint/type ceilings remain
732/398. The temporary browser server and Redis were stopped after testing.
Receipts are retained under `audit-party-task-lifecycle-2026-09-05` in thread
storage; the separate full integration run targets frozen commit `3a03e34e`.

## Inventory costing revisions and ownership — continuation from 3e52c500

The costing editor previously omitted its revision, while the API made the
fence optional and compared timestamps at millisecond precision. PostgreSQL
regressions reproduced stale saves and two simultaneous creation requests both
succeeding. The editor now sends the exact six-digit token; explicit null asserts
that no profile exists. The API serializes creation on the item, checks the
locked profile revision, and predicates its upsert on that revision. Accepted
writes advance the token even when the stored timestamp is ahead of transaction
time. Profile reads and committed responses use the same lossless formatter.

Malformed negative-stock flags, valuation bases and optional account IDs now
produce validation errors. They previously selected another policy or cleared
an account while returning success. The editor also resets its load state and
cancels obsolete reads when switching items, prevents editing before loading,
and releases its busy state after a failed network request.

A real restricted-role case also posted an inventory revaluation despite having
no subsidiary access. The route now passes current subsidiary authority into
the domain revaluation helper, which checks every locked layer owner before
rewriting costs or posting journals. Permitted subsidiary and unrestricted
revaluations remain supported. The focused database and boundary suite passes
53 cases, including unchanged state and audit counts for refused commands.

The separate full integration run of frozen `3a03e34e` completed 1,408 tests:
1,406 passed and two Redis-dependent cases skipped, with no failures. Its fixture
receipt records 943 leases/releases/resets, four bootstraps/teardowns/schema
verifications, zero active leases and zero leaks. The 19-case Redis outbox suite
had passed separately at `3e52c500`. These are distinct snapshots, not a claim
that the complete suite exercised subsequent source changes.

Verification also passed all 3,040 unit tests, engine/web typechecks, the locked
production build and explicit-any/lint ceilings (398/732). A dedicated browser
session exercised a successful costing save, a competing one-microsecond edit,
409 refusal with the original form token, and successful reload/retry with the
new token. Fresh bootstrap exposed a browser-fixture assumption: deferring the
setup wizard navigates to readiness. The discard test now waits for that
navigation and reopens its draft before exercising the drawer. All 13 browser
tests and the E2E typecheck passed after that correction. The database and
browser services use disposable local data only. Receipts are retained in
thread storage under `audit-costing-2026-09-05`.

## Item edit request shapes — continuation from 227588fd

The main item PATCH route normalized non-string monetary values and identifiers
into null, accepted PostgreSQL boolean coercion, and called `.trim()` on a null
name. Real database tests reproduced nine malformed-input failures, alongside
passing valid edit/clear controls. The route now validates the complete patch
shape and uses the shared exact-money boundary: safe integer JSON amounts become
exact monetary text, fractional JSON numbers are refused, and decimal strings
remain supported. Explicit null/blank clears and omitted fields retain their
existing meaning. Refused patches leave both the item and audit log unchanged.

All 15 focused route/database cases, 3,040 unit tests, the web typecheck, lint
and the locked production build passed. The 13 browser tests and dedicated
costing interaction receipts belong to the preceding costing batch; this
backend validation change was verified directly through its HTTP handler.
Receipts are in thread storage under `audit-item-input-2026-09-05`.

## Project billing authority, source claims and backup precision — continuation from 3304f2c1

Creation scoped billing requests to their project, but cancellation, invoice
generation and backup retrieval omitted that boundary. Six real role/database
cases reproduced hidden and empty-scope actors successfully cancelling requests,
generating invoices or receiving cached PDF bytes. Cancellation and generation
now carry subsidiary scope into their services and lock both the request and its
project. A controlled project-reassignment case verifies that a waiting generator
rechecks the new owner before consuming work. Request lists also hide linked
invoice details when the invoice belongs outside the reader's scope.

Backup assembly and cached reads require access to the invoice, its project and
supporting cost documents/Field Tickets. Cached packets additionally check their
retained source-document manifest; refused existing artifacts are distinguished
from cache misses so a reader cannot silently regenerate a packet with narrower
source access. Domain refusal maps to 404 at both backup HTTP methods. Regression
cases cover a hidden invoice, hidden current source and hidden manifest source,
plus allowed restricted and unrestricted retrieval.

The deeper source audit reproduced two requests committing invoices for one
approved time entry. Selected time is now row-locked in stable date/id order, and
the final conditional source claim must return its row. Losing the claim rolls
back the whole invoice. A separate case showed a visible project consuming a
vendor cost owned by a hidden entity; the generator now refuses that source set
before invoice creation instead of silently consuming or omitting hidden work.

The costed-timesheet backup footer also accumulated costs as JavaScript numbers.
A valid numeric(19,4) example, 999999999999999.9000 plus 0.0400, printed .90 instead
of .94. PostgreSQL now supplies the exact numeric sum directly to the money
formatter, retaining precision beyond ledger scale until presentation. The
regression checks the HTML passed to the real PDF boundary using real database
rows; PDF rendering is substituted only to capture that input without writing a
file. The focused suite passes 31 cases across these controls, billing currency
rounding, project dimension inheritance and existing backup allocation behavior.

The final checkpoint passed all 3,040 unit tests, web typechecking, the locked
production build and the 398/732 explicit-any/lint ceilings. The first unit run
caught one unused import in the new contention fixture through the lint-ceiling
check; removing that import restored the ceiling and the complete rerun passed.
These backend changes were verified through the real service/HTTP boundaries;
the preceding 13-case browser run is separate evidence. Detailed baselines,
source snapshots and results are retained under `audit-billing-scope-2026-09-05`
in thread storage. A full integration run will target this frozen checkpoint.

## Password-reset KDF admission — continuation from f7f87fbb

Reset completion previously invoked scrypt before checking whether the supplied
token existed. Random correctly sized strings therefore consumed the bounded
password KDF queue shared with login. A regression reproduced the unnecessary
hash invocation. Completion now checks the hashed token, expiry, consumption
state and active identity before hashing, then rechecks authority under the
existing user-then-token locks before changing credentials. No locks span the
KDF operation.

Twelve PostgreSQL cases passed, covering invalid-token admission, valid password
verification, token consumption/user deactivation during hashing, concurrent
issuance/completion, and session/MFA revocation. The 3,041-test unit suite, web
typecheck and locked production build also passed. Receipts are retained in
thread storage under `audit-reset-kdf-2026-09-05`. The independent full integration
run remains attributed to its frozen f7f87fbb billing revision.

## Chart-of-accounts input integrity — continuation from ed793046

Both account creation and editing accepted malformed policy fields. Objects
could clear currency/entity bindings, string booleans could be coerced or
silently defaulted, and malformed names/null flags could escape as exceptions.
The PostgreSQL baseline reproduced 27 failing cases with five passing controls.
Both endpoints now share typed policy fields at the existing JSON boundary,
preserving explicit nullable clears, omitted values and valid create replay.

All 40 focused tests passed: the input matrix checks unchanged rows and zero
audit writes for refusals, while existing tests cover hierarchy/posting
contention and idempotent creation. All 3,041 unit tests, web typechecking, the
locked production build and explicit-any check passed without raising lint or
type-safety ceilings. Receipts are retained in thread storage under
`audit-account-input-2026-09-05`.

## Authentication expiry after lock waits — continuation from 72366620

Three controlled database cases showed expired credentials still authorizing
password reset, MFA enrollment and MFA confirmation. Each test starts with a
valid credential, holds the user row until PostgreSQL confirms real expiry, and
then releases the waiter. Transaction-start `now()` and a session join evaluated
before locking retained authority past expiration. Unexpired controls succeeded.

Reset now claims its locked token against the live database clock before any
credential changes. MFA enrollment locks the user before reading/locking its
session; enrollment and confirmation recheck current expiry after their waits,
including password verification and the factor lock. All 21 authentication
integration cases, 3,041 unit tests, web typechecking and the locked production
build passed. Receipts are retained under `audit-auth-expiry-2026-09-05` in thread
storage. This checkpoint is distinct from the frozen f7f87fbb full-suite run.

## MFA security-change evidence — continuation from 4992f942

MFA enable, disable and recovery-code rotation changed account security without
retaining the material action or before/after state. Generic password-login
events could not establish what changed. All three operations now write an
attributable user audit event in the same transaction, with enabled status and
recovery-code counts only. Secrets, ciphertext and credential hashes are never
serialized into this evidence. Counts reflect the state before a recovery code
used for reauthentication is consumed.

Six new database cases verify actor, tenant, timestamp, precise non-secret
before/after values, and complete factor/session rollback on forced audit-write
failure. All 27 authentication integration cases, 3,041 unit tests, web
typechecking and the locked production build passed. Receipts are retained under
`audit-mfa-evidence-2026-09-05` in thread storage.

## Frozen integration checkpoint — f7f87fbb

The full integration suite completed with 1,466 tests: 1,464 passed, two
Redis-dependent flow-email cases skipped, and zero failures. The fixture owner
reported 1,001 leases/releases/resets, four bootstraps/teardowns/schema-wide
verifications, zero active leases and zero leaks. The exact log and receipt are
retained under `audit-billing-scope-2026-09-05`. This result belongs to f7f87fbb;
the subsequent authentication, account and payroll changes have their own
focused, unit, typecheck and build receipts.

## Payroll profile policy and audit integrity — continuation from 014af7c2

Profile writes silently coerced malformed withholding flags/counts and pay
basis/vacation methods; an object SIN/SSN could clear the sealed identifier.
The API now validates these types and enums before its existing exact-money and
country-pack checks. Explicit nullable clears remain supported, and omission
preserves the stored identifier. A related registry defect admitted inherited
object names such as `constructor` as installed country packs. The country
dictionary now has no prototype, preserving declared and third-party packs while
refusing inherited names.

Profile creation and editing now retain exact before/after audit evidence in
the same tenant transaction. The employee lock serializes initial creation;
the stored predecessor is locked before mutation. Employee/role and schedule
locks also keep the checked references stable during the write. The audit uses
an explicit column projection with SIN/SSN presence and last-three digits only,
never plaintext or ciphertext. Updated timestamps advance monotonically, and
audit events record the live write time and request identity.

The 43 focused cases cover malformed inputs, explicit clears, secret omission,
attributed/redacted audit snapshots, audit-failure rollback, concurrent creation
with chained before-images, built-in pack behavior and third-pack extensibility.
All 3,042 unit tests, workspace typechecks and the locked production build passed;
the explicit-any/lint ceilings remain unchanged. Baselines, source snapshots and
receipts are retained under `audit-payroll-profile-2026-09-05` in thread storage.

## Company audit viewer authorization — continuation from 5ad0e8ee

The company audit viewer checked its permission but ignored subsidiary scope
in lists, aggregate filters and selected snapshots. Restricted and empty-scope
roles could open another entity's deleted-document evidence. The whole-company
viewer now requires an unrestricted grant before reading audit data; existing
record-specific audit routes retain their scoped access. Invalid actor UUIDs
and nonexistent calendar dates are also refused before PostgreSQL casts can
turn malformed filters into server errors.

Seven database page cases passed, including unrestricted and valid-date
controls. Typed query results removed six explicit `any` casts. The enforced
ceilings were lowered with the measured counts to 392 explicit-any nodes and
726 lint warnings; the initial unit run correctly refused the stale higher
ceilings. The final 3,042-test unit suite, web typecheck and locked production
build passed. Receipts are retained under `audit-viewer-scope-2026-09-05` in
thread storage. The next full integration run targets frozen 5ad0e8ee, which
includes the preceding authentication, account and payroll corrections.

## Sentinel forensics authorization and drilldown — continuation from aca21500

The Sentinel page, service and assistant exposed whole-company comparisons and
retained audit snapshots to subsidiary-restricted and reports-only roles.
All three boundaries now require unrestricted subsidiary access and both
report and administrative audit permissions. The document-only Benford
drilldown retains its subsidiary filtering and report permission. Its missing
party join, which made valid requests fail in PostgreSQL, is corrected;
invalid dimensions, digit ranges and calendar-date ranges are refused before
queries run.

The 28 focused tests cover real roles, database records, page rendering,
assistant dispatch, successful drilldowns and malformed filters. All 3,050
unit tests passed. A test-fixture union type initially failed compilation;
after its annotation was corrected, web typechecking and the locked production
build passed. Baselines and receipts are retained under
`audit-sentinel-access-2026-09-05` in thread storage.

## Frozen integration checkpoint — 5ad0e8ee

The full suite at frozen 5ad0e8ee completed with 1,531 tests: 1,529 passed,
two Redis-dependent flow-email cases skipped, and zero failures. The fixture
receipt records 1,066 leases/releases/resets, four bootstraps/teardowns/schema
verifications, zero active leases and zero leaks. The log and receipt are
retained under `audit-payroll-profile-2026-09-05`. Later audit-viewer, Sentinel
and Financial Health changes have separate focused and release-check evidence.

## Financial Health ledger reconciliation — continuation from 7860d314

Monthly charts combined primary and secondary books. Segment, account-driver
and item-analysis queries also included draft journal lines. A real database
fixture reproduced 1,700 of account revenue against 100 in the primary posted
ledger. These queries now use the shared primary-book selector and posted or
reversed entry status, preserving selective line-date predicates. Monthly and
segment operating income now excludes nonoperating income, matching the
headline; the affected monetary subtotals use exact money helpers before
conversion for presentation ratios.

Segment, item and enabled-budget query failures previously became apparently
valid empty datasets. They now propagate; truly absent data and disabled
budgets retain their explicit empty states. Eleven regression cases failed
against the prior implementation, while the empty-data control passed.
The corrected 15-case focused run includes current/completed-month paths,
segments, drivers, items, operating income, injected query failures and the
existing financial-health ratio cases. All 3,056 unit tests, web typechecking
and the locked production build passed, with unchanged 392/726 explicit-any
and lint ceilings. Receipts are retained under `audit-health-ledger-2026-09-05`
in thread storage.

## Financial Health subsidiary scope — continuation from cedc0152

The Financial Health page, accounting-home score and assistant discarded the
caller's subsidiary restrictions. The data functions now require an explicit
scope, carried through primary-book statements, monthly summaries, line-level
segments/drivers/items, depreciation and employee headcount. Budget selection
requires a visible cell, and both plan and actual amounts use the same entity
scope. A later hidden-only plan no longer displaces the caller's visible plan.
The accounting budget badge also checks the mandatory budget-line entity,
alongside its existing account/project restrictions.

The new database cases cover restricted, empty and unrestricted roles across
the service, page, assistant, completed-month summaries and accounting badge.
They verify visible values remain usable while hidden names, headcount,
depreciation and budget amounts do not escape. The first run exposed a fixture
teardown defect: approved-budget guards were missing from its guarded-evidence
list. The fixture owner now deletes budget cells before headers using its
existing scoped, transactional trigger handling. No production guard changed;
all 12 fixtures left by the failed run were subsequently removed.

The corrected focused run passed all 33 tests, including prior ledger, ratio,
failure-propagation and accounting scope regressions. All 3,056 unit tests,
workspace typechecks and the locked production build passed. The explicit-any
and lint ceilings remain 392 and 726. Baselines and receipts are retained under
`audit-health-scope-2026-09-05` in thread storage.

## Cash ledger selection and empty scopes — continuation from 677b924d

Cash starting balances combined primary and secondary books in both summary
and partial-month paths. The final account list also omitted its tenant
predicate, exposing other tenants' zero-balance account metadata to a trusted
caller. The bank query now selects the primary book and explicitly pins its
account list to the resolved organization. Empty subsidiary arrays now match
no ledger rows/open items instead of becoming unrestricted reads; the empty
bank-account result is explicit.

The same accounting-book omission affected GL-average, card-cycle and
bank-register forecast history. GL averages also counted drafts. All four
history queries now use the posted primary ledger. Database regressions cover
both bank query paths, a second tenant, secondary-book copies, draft activity,
restricted/empty scopes, posted receivables/payables, and each history strategy.
Eight bank/open-item cases and six history cases failed against their prior
implementations; the valid controls passed. The corrected focused run passed
34 tests. All 3,056 unit tests, web typechecking and the locked production
build passed, with unchanged 392/726 explicit-any and lint ceilings. Receipts
are retained under `audit-cash-ledger-2026-09-05` in thread storage. The full integration run in progress remains frozen at 677b924d.

## Cash forecast authorization and payment history — continuation from b840acae

The AP, AR and cashflow pages and assistant tools discarded subsidiary grants.
Application vitals did the same for cash and aging, while cash account/vendor
options could disclose hidden-entity metadata even when balances were scoped.
The composite resolvers now require caller scope, carry it through every cash,
open-item, SQL-history and option query, and intersect selected banking views
with the grant. Vitals uses the same scope for its aging reports.

The settlement rollup has no subsidiary dimension. Restricted forecasts now
reconstruct its statistics from applications whose source and target lines are
both visible; unrestricted reads retain the rollup. A five-day visible payment
history previously became thirteen days when hidden twenty-day payments were
included. The new tests verify both sides, shared counterparties, empty grants,
selectors, API drilldowns, services, pages, assistant dispatch and vitals.
Thirty authorization/history regressions failed against the prior behavior;
the unrestricted controls passed. The corrected combined focused run passed
87 tests. A typed statistics result removed one explicit-any node; the enforced
ceilings were lowered to 391 explicit-any nodes and 725 lint warnings. All
3,056 unit tests, web typechecking and the locked production build passed.
Receipts are retained under `audit-cash-scope-2026-09-05` in thread storage.

## Analytics leap-day comparisons — continuation from 5b70695b

Financial Health (dashboard and score), Customer Intelligence, Vendor
Intelligence and Spend Velocity constructed prior-year dates by replacing
only the year. A period beginning or ending on February 29 produced an invalid
February 29 in the prior year and failed in PostgreSQL. All five resolvers now
use the report engine's shared month-shift helper, which clamps the day to the
target month's last valid day. Its existing calendar tests cover that rule.

Ten real database cases failed before this correction and five ordinary-date
controls passed. All 15 now pass across leap-day starts, leap-day ends and the
ordinary March control. Receipts are retained under
`audit-analytics-calendar-2026-09-05` in thread storage.
All 3,056 unit tests, web typechecking and the locked production build passed;
the explicit-any check remains at 391 and the lint ceiling remains at 725.

## Analytics primary-ledger reconciliation — continuation from d3f4de01

Vendor Intelligence spend totals and monthly history, Spend Velocity's account,
vendor, category, comparison and revenue queries, and customer project
profitability included draft entries and secondary accounting books. Their
actuals now select the organization's primary statement book and posted or
reversed history. Reversed originals remain included alongside the correcting
entries, preserving the ledger's net effect.

The new database suite isolates posted controls, secondary books, drafts and
reversal pairs across eight outputs. Sixteen cases failed before the query
correction; all sixteen posted/reversal controls passed. All 32 now pass,
along with the 15 calendar regressions. Evidence is retained under
`audit-analytics-ledger-2026-09-05` in thread storage. All 3,056 unit tests,
web typechecking and the locked production build passed. The explicit-any
and lint ceilings remain 391 and 725.

The separately frozen full integration run at **677b924d** completed with
1,575 tests: 1,573 passed, two Redis-dependent cases skipped, no failures.
Its four fixture slots completed 1,110 leases, releases and resets, four full
bootstraps, teardowns and schema verifications, with zero active leases or
leak detections. Runtime was 1,081,609 ms. The log and lifecycle receipt are
under `audit-health-scope-2026-09-05`; this full-run result applies to that
revision, before the subsequent cash, calendar and analytics-ledger fixes.

## Analytics subsidiary controls — continuation from cb915e0d

Customer Intelligence (including project profitability), Vendor Intelligence
and Spend Velocity accepted only an organization and period. Their pages and
assistant tools had the caller's subsidiary grants but did not pass them to
the data services, so restricted users received other legal entities' amounts
and names. Required scope parameters now reach ledger lines, source documents,
project ownership, invoice/payment history, customer cohorts, commitment
orders and expense reports. Empty grants produce no transactional data.

The initial database authorization matrix reproduced 18 failures across
service, rendered page and public assistant dispatch; all nine unrestricted
controls passed. Expanded coverage also checks shared counterparties' payment
history and the independent purchase/sales-order and expense-report queries.
Receipts are retained under `audit-analytics-scope-2026-09-05` in thread storage.

The expanded tests also exposed a separate commitment-summary defect: a
single populated month was returned as zero PO/SO totals, a zero ratio and
healthy status. Totals and ratio-based classification now use the observed
orders for every history length; only growth estimates require multiple
months. Empty, balanced and excessive-purchase cases verify that distinction.
The combined focused database run passed 85 tests.

All 3,056 unit tests, web typechecking and the locked production build passed
on the final correction; explicit-any and lint ceilings remain 391 and 725.
The two Redis-dependent scheduler cases previously skipped in full runs also
passed against an isolated local Redis instance: crash/retry deduplication and
deterministic recipient fanout. That focused receipt is under
`audit-redis-queue-2026-09-05`; it is separate from the full-run receipt above.

## Utilization access and feature controls — continuation from f72136e6

Utilization ignored subsidiary grants in its current, prior and rolling
history scans. It now follows the existing time-report ownership policy:
project subsidiary takes precedence, with employee subsidiary for internal
work. The page and assistant pass the caller's required scope; the service
also enforces Time Tracking and its Projects parent before reading data.

The regression matrix covers services, rendered pages and assistant dispatch
for unrestricted, restricted and empty grants. Cross-company project work,
internal time, employee names, cost, prior ranges and rolling history are
checked. Two additional cases disable the child and parent feature gates.
Eight tests failed before the correction and three unrestricted controls
passed; all 11 now pass. Receipts are retained under
`audit-utilization-scope-2026-09-05` in thread storage.
All 3,056 unit tests, web typechecking and the locked production build passed;
explicit-any and lint ceilings remain 391 and 725.

## True Cost primary-ledger reconciliation — continuation from e28ad13d

The burden-rate dashboard read draft and secondary-book journal activity in
current overhead, monthly history, prior-period comparison, applied burden
and revenue/direct-cost/labor-dollar allocation bases. The shared ledger
predicate now selects posted and reversed history in the primary statement
book while preserving subsidiary grants. The allocation-base query now joins
entries so it can enforce the same predicate.

Seven database regressions failed before this correction; seven posted-only
controls passed. All 14 now pass, checking rates and underlying monetary bases
against the seeded ledger. Receipts are retained under
`audit-true-cost-ledger-2026-09-05` in thread storage.
All 3,056 unit tests, web typechecking and the locked production build passed;
explicit-any and lint ceilings remain 391 and 725.

## Cash drill request validation — continuation from 1a6ec534

The weekly cash drill accepted nonexistent calendar dates, unvalidated as-of
values, fractional or silently clamped/defaulted horizons, and malformed
subsidiary identifiers. It now applies the shared calendar-date and UUID
validators and requires an explicit horizon to be an integer from 1 to 52.
Malformed inputs return 400 before invoking the forecast reader; valid
out-of-scope selections retain the existing authorization response.

Fifteen malformed-input tests failed before this correction, while seven
valid/scope controls passed. All 22 route tests now pass. Receipts are retained
under `audit-cash-drill-input-2026-09-05` in thread storage.
All 3,073 unit tests, web typechecking and the locked production build passed;
explicit-any and lint ceilings remain 391 and 725.

## Customer payment cutoff — continuation from 206a31ec

Customer payment metrics could mark an invoice paid using a settlement after
the report's reference date, a future-effective application, or a payment on
a secondary-book copy. The payment CTE now constrains invoice and payment
entries to posted/reversed primary-book history and requires application and
payment dates on or before the reference date. Existing subsidiary filters
and transaction-currency settlement comparisons remain in the query.

Three cutoff/book cases failed before this correction and the in-period
control passed. The combined cutoff, subsidiary, transport and currency-query
regressions passed 39 tests. Receipts are retained under
`audit-customer-payment-cutoff-2026-09-05` in thread storage.
All 3,073 unit tests, web typechecking and the locked production build passed;
explicit-any and lint ceilings remain 391 and 725.

## Employee spend actuals — continuation from f3819e6e

Spend Velocity's employee breakdown summed expense-report headers while its
account totals used posted ledger lines. That included unposted draft reports
and mixed transaction-currency totals with base-currency actuals. Employee
spend now composes the same primary-book ledger query as the expense summary,
including subsidiary and date predicates, and counts distinct source reports.

The draft and foreign-currency cases failed before correction; posted and
secondary-projection controls passed. All 31 combined ledger and authorization
regressions now pass. Receipts are retained under
`audit-spender-ledger-2026-09-05` in thread storage.
All 3,073 unit tests, web typechecking and the locked production build passed;
explicit-any and lint ceilings remain 391 and 725.

## Vendor settlement metrics — continuation from c88c1ad8

Vendor days to pay measured lateness from the due date despite the UI promising
elapsed days from the bill date. Partial installments counted as paid bills,
and future-effective applications, future payments and secondary-book
settlements could affect the report. The query now measures bill-to-final-payment
days only after full settlement in transaction currency, using posted/reversed
primary-book entries within the reference date. Late spend continues to include
actual partial payments made after the due date.

All six new settlement cases failed before correction. All 41 combined
settlement, installment, period and authorization regressions now pass.
Receipts are retained under `audit-vendor-settlement-2026-09-05` in thread storage.
All 3,073 unit tests, web typechecking and the locked production build passed;
explicit-any and lint ceilings remain 391 and 725.

## Margin waterfall reconciliation — continuation from 11159882

The Financial Health waterfall skipped the adjustments between total revenue,
operating income and net income when other income was present. It now explicitly
excludes other income before the operating subtotal and adds it back afterward,
preserving the report's existing total-revenue and gross-profit definitions.

Positive and negative other-income regressions failed before correction; the
zero-income control passed. All 30 combined waterfall, primary-ledger, query-failure
and subsidiary regressions now pass, including reconciliation of each displayed
subtotal against posted entries. All 3,076 unit tests, web typechecking and the
locked production build passed. Explicit-any and lint ceilings remain 391 and
725. Receipts are retained under `audit-margin-flow-2026-09-05` in thread storage.

## Historical headcount — continuation from cbd37d7f

Financial Health counted future hires and excluded employees whose termination
occurred after the selected reporting period. Its productivity ratios now use
employment dates at period end, including the final employment day. Undated
legacy hires retain their existing eligibility; subsidiary scope is unchanged.
The ratio reference formulas explicitly identify the period-end denominator.

Three date-boundary regressions failed before correction and three controls
passed. All 36 combined employment-date, ledger, waterfall and authorization
checks now pass, as do all 3,076 unit tests, web typechecking and the locked
production build. Explicit-any and lint ceilings remain 391 and 725. Receipts
are retained under `audit-health-headcount-2026-09-05` in thread storage.

## Frozen integration checkpoint — f72136e6

The complete integration suite at frozen revision `f72136e6` passed all 1,727
tests with zero failures or skips in 1,556,680 ms. A disposable loopback Redis
instance enabled the durable queue cases; no email workers were started.
Four fixture slots completed 1,270 leases, releases and resets, four full
bootstrap/teardown/schema-verification cycles, and zero active leases or leaks.
The log and copied fixture receipt are retained under
`audit-analytics-scope-2026-09-05` in thread storage. This checkpoint does not
cover subsequent commits, which have their own focused and build receipts.

## Inventory reversal chronology — continuation from 4e772784

Receipt, issue, transfer, assembly and landed-cost reversals could be dated
before their source events. Nonexistent calendar dates also reached PostgreSQL
instead of producing controlled domain errors. Reversal entry points now use
the shared calendar validator; locked source movements and inventory journals
must not be later than the requested reversal. Same-day and later reversals,
including their idempotent retries, retain existing behavior.

Ten chronology/calendar regressions failed before correction and ten valid
controls passed. All 38 combined reversal, lifecycle, concurrency and accounting
checks now pass. Refused operations preserve complete movement, cost-layer,
journal and allocation snapshots; successful operations reconcile GL to layers.
All 3,076 unit tests, every workspace typecheck and the locked production build
passed. Explicit-any and lint ceilings remain 391 and 725. Receipts are retained
under `audit-inventory-reversal-date-2026-09-05` in thread storage.

## Inventory write-down reversal chronology — continuation from ef2b6a3e

An NRV reversal could consume write-down evidence dated after the requested
reversal, including a mix of older and future write-downs. It now validates the
calendar date before SQL and refuses a reversal preceding any locked open
write-down. Filtering out future evidence would still revalue layers already
affected by it, so the operation is rejected atomically instead.

Three chronology/calendar cases failed before correction; same-day and later
controls passed. All 36 combined NRV, inventory-reversal and accounting checks
now pass, along with all 3,076 unit tests, every workspace typecheck and the
locked production build. Explicit-any and lint ceilings remain 391 and 725.
Receipts are retained under `audit-nrv-reversal-date-2026-09-05` in thread storage.

## Inventory remeasurement concurrency and attribution — continuation from 9095dbcb

NRV remeasurement locked existing cost layers without the shared inventory
position lock. A concurrent receipt could leave its layer outside that snapshot
while the subsequent on-hand query included it. Two ten-unit receipts at cost
10 were remeasured to the correct total 120, but their costs became 2 and 10;
the next FIFO issue therefore cost 2 instead of 6. Both remeasurement paths now
take the shared position lock before reading layers and on-hand totals.

The item accounting profile is also read with a share lock inside the same
transaction, so an in-flight profile edit completes before account selection.
Both write-down and reversal journals now retain the supplied actor in their
creation, update and posting columns, matching their valuation evidence.

All five new attribution and adversarial concurrency cases failed before
correction. All 59 combined inventory, NRV, chronology and concurrency checks
now pass, as do all 3,076 unit tests, every workspace typecheck and the locked
production build. Explicit-any and lint ceilings remain 391 and 725. Receipts
are retained under `audit-nrv-controls-2026-09-05` in thread storage.

## OIDC response memory bounds — continuation from bcbb6454

Discovery, token and signing-key responses enforced their one-megabyte limit
only after buffering the complete body. All three now share a streaming reader
that counts decoded response bytes, stops and cancels on overflow, and releases
the reader lock on success or failure. Declared oversized bodies are canceled
before reading; absent or understated length headers cannot bypass the limit.

All nine overflow/cancellation regressions failed before correction. All 27
focused OIDC and route-contract checks now pass, including exactly one million
bytes, one byte over the limit, split UTF-8, ordinary signed login responses
and redirect refusal. All 3,087 unit tests, web typechecking and the locked
production build passed. Explicit-any and lint ceilings remain 391 and 725.
Receipts are retained under `audit-oidc-response-limit-2026-09-05` in thread storage.

## Mapped tenant user activation — continuation from 07188839

An active home session and access grant could continue using a deactivated
mapped user, including retained role assignments. Environment resolution and
workspace listings now require an active acting user belonging to the target
organization. Sandbox resolution separately verifies the cloned user exists
and is active. Unavailable selections follow the existing home-workspace
fallback; explicit platform-administrator production access uses the platform
identity rather than a deactivated mapped identity.

Eight inactive-user regressions failed before correction and eight active
controls passed. The expanded member/platform-admin matrix plus MFA concurrency
checks passes all 35 tests, covering resolver, picker and signed browser-session
paths. All 3,087 unit tests, web typechecking and the locked production build
passed. Explicit-any and lint ceilings remain 391 and 725. Receipts are retained
under `audit-org-user-activation-2026-09-05` in thread storage.

## Workflow configuration and history — continuation from d6618c79

Flow activation accepted truthy non-boolean values, and graph saves checked an
unlocked snapshot: a simultaneous enable and draft edit could leave an invalid
graph enabled. Deletes also checked approvals before their transaction and
removed execution/effect history while retaining only a run count in audit.
PATCH and DELETE now require the exact six-digit revision, lock the parent row
before validation, and audit the locked before/after state. Successful writes
advance revisions monotonically. Flows with execution or approval history must
be disabled instead of deleted; parent locking serializes against child inserts.

All API and server-page readers preserve exact revisions, and both existing
list controls and the builder submit and retain committed tokens. The builder
keeps edits made during an in-flight save marked unsaved. Delete confirmation
copy in all five locales describes the history-preservation rule.

The baseline reproduced 14 failures with two passing controls. All 45 focused
API/engine tests now pass, including live concurrent enable/edit and approval
insert/delete interleavings. Twelve browser assertions on the locked production
build cover save/retry, stale conflicts, edits during a held save response,
enabling, disabling and deleting unused definitions. All 3,087 unit tests,
web typechecking and the locked build passed; the final five-locale copy change
also passes 13 catalogue/view tests. Explicit-any and lint ceilings remain 391
and 725. Receipts are in `audit-flow-controls-2026-09-05` in thread storage.

## Full integration checkpoint — bcbb6454

The frozen `bcbb6454` suite passed all 1,802 tests with zero failures or skips
in 1,078,723 ms. Its four fixture slots completed 1,345 leases, releases and
resets, four bootstraps/teardowns/schema verifications, zero active leases and
zero detected leaks. Redis was available for queue checks; no email worker or
external delivery was started. This checkpoint precedes the OIDC, mapped-user
and workflow fixes, which have separate focused verification. The log and
fixture receipt are retained under `audit-nrv-controls-2026-09-05`.

## Asset reversal chronology — continuation from b09d0914

Disposal, write-off, impairment and revaluation reversals previously accepted a
date before the original entry. Calendar-shaped but impossible dates reached
PostgreSQL as unhandled database errors. Reversal now validates the actual
calendar date and compares against both event and journal dates read under the
existing source locks. Earlier dates are refused before any financial write;
same-day/later corrections and idempotent replay remain supported.

Eight regressions failed before correction and eight valid controls passed.
All 35 focused lifecycle tests now pass, including unchanged asset, event,
journal and schedule snapshots after refusals. All-workspace typechecking and
the locked production build pass. Evidence is retained under
`audit-asset-reversal-date-2026-09-05` in thread storage.
All 3,087 canonical unit tests pass; explicit-any and lint ceilings remain 391
and 725. The adjacent audit has confirmed separate account-override and
subsidiary-scope defects in disposal/remeasurement; their remediation is next.

## Asset posting accounts and scope — continuation from 133a80d2

Disposal and remeasurement used legacy custom JSON/category defaults while
normal depreciation and the editor used native GL overrides. Both now compose
the same native account resolver as depreciation; adjustment accounts come
from the category's authoritative setting. Both HTTP routes also discarded
subsidiary restrictions. They now pass scope to the service, which enforces it
on the locked asset row before reading carrying value or posting. An empty
scope denies all assets, including after a concurrent subsidiary move.

Remeasurement now rejects malformed supplied dates instead of substituting
today; only an omitted date gets the organization's business day. Both engine
entry points independently validate calendar dates.

The expanded baseline failed 14 of 20 cases, including actual asset transfers
while posting waited. All 46 focused integration checks now pass, plus two
isolated date-default/refusal unit checks. All-workspace typechecking and the
locked production build pass after correcting the SQL row type. Receipts are
retained under `audit-asset-posting-controls-2026-09-05`. Separate asset-editor
scope, status-transition and financial-history gaps are confirmed and queued
for the next correction.
All 3,089 canonical unit tests pass. Explicit-any and lint ceilings remain 391
and 725. The extra same-thread root build attempt is not release evidence;
the successful locked build is recorded in `build-final.log`.

## Asset editor history and scope — continuation from cf95750d

Asset PATCH allowed moving records outside the caller's subsidiary scope,
reactivating disposed/written-off assets without reversal, and changing posting
accounts/category/entity after depreciation. Its basis guard also overlooked
impairment and disposal journals when no depreciation had posted. The save now
checks the target scope and locked source scope, includes posted/reversed
lifecycle evidence, and requires controlled corrections for those changes.
Unchanged effective account resaves remain valid for the existing drawer.

A name-only edit additionally rebuilt unposted depreciation from original cost,
undoing controlled impairment schedules. Saves with financial history now retain
those schedules. A two-period regression confirms an impaired 400/400 plan
remains byte-for-byte unchanged instead of returning to 500/500 on rename.

The initial 46-case matrix reproduced 29 failures; the schedule regression
failed independently. All 73 expanded editor/posting checks and 12 adjacent
lifecycle/depreciation checks pass, including the original posted-basis race
and a concurrent move outside subsidiary scope. Web types and the locked
production build pass. Evidence is retained under
`audit-asset-edit-controls-2026-09-05`. Asset detail valuation still ignores
lifecycle events; that separate confirmed defect is the next correction.
All 3,089 canonical unit tests pass. Explicit-any and lint ceilings remain 391
and 725.

## Full integration checkpoint — b09d0914

The frozen `b09d0914` suite passed all 1,850 tests, with zero failures or skips,
in 1,248,351 ms. Four fixture slots completed 1,425 leases/releases/resets,
four bootstraps/teardowns/schema verifications, zero active leases and zero
leaks. This includes the OIDC, mapped-user and workflow corrections; subsequent
asset corrections have separate focused checks. The log and fixture receipt
are retained under `audit-flow-controls-2026-09-05`.

## Asset detail valuation — continuation from 26d5e731

The detail payload showed acquisition cost less depreciation regardless of
impairment, revaluation or disposal. It now includes posted lifecycle movements
and their controlled reversals, scoped to the primary book for current totals
and each schedule row's own book/effective date for projections. Retired assets
show zero current carrying and accumulated balances; historical posted
depreciation remains separately available. Lifecycle journals count as
accounting evidence even when no depreciation exists.

The detail read holds a shared parent lock and uses one transaction so lifecycle
writers cannot change the asset/journal/schedule population mid-read. Queries
on that connection run sequentially. Eleven regressions failed before correction
with two passing controls. The expanded 98-case check passed; after serializing
the connection queries, the 86 valuation/editor/posting cases pass again without
the concurrent-query driver warning. Web typechecking and the locked build pass.
Receipts are under `audit-asset-valuation-display-2026-09-05` in thread storage.

The next confirmed gap is lifecycle posting chronology: current carrying-value
inputs may include financial activity after the requested posting date.
All 3,089 canonical unit tests pass after serializing the read queries.
Explicit-any and lint ceilings remain 391 and 725.

## Asset lifecycle posting chronology — continuation from 6196a6da

Disposal and remeasurement used current carrying value even when the requested
posting date preceded acquisition, already-posted depreciation, or a retained
lifecycle entry/reversal. Both now inspect those date boundaries after acquiring
the asset lock and refuse an earlier date before writing a journal. Imported
posted schedule evidence uses its period end when no journal date is available.
Reversals remain part of the boundary because their effects are already included
in current carrying value. Same-day and later entries remain supported.

Eight regressions failed before correction; sixteen valid controls passed.
The corrected 24-case matrix and all 141 expanded asset integration checks now
pass. Five older tests had valued on July 15 after posting July 31 depreciation;
their operation dates were corrected to July 31, preserving their original
restoration, balancing and rollback assertions. All 3,089 unit tests,
all-workspace typechecking and the locked production build pass. Explicit-any
and lint ceilings remain 391 and 725. Receipts are retained under
`audit-asset-lifecycle-date-2026-09-05`.

The continuing review has confirmed two separate asset-editor issues—missing
audit evidence for non-basis configuration and stale custom-data overwrites—and
unbounded depreciation work for enormous useful-life inputs. These remain open
for the next corrections; this checkpoint is not a production-readiness claim.

## Bounded depreciation calculations — continuation from 30e5eb01

Useful lives and convention windows were truncated/coerced and could request
billions of materialized schedule rows before fiscal-calendar filtering. The
shared engine now requires an exact positive integer, capped at 12,000 periods
(1,000 monthly years); convention windows have the same independent bound, so
no schedule can exceed 24,000 rows. This is a calculation resource limit, not a
category-specific accounting policy. Existing category/book inheritance remains
available. The asset API refuses invalid inputs before writes or schedule work;
the setup registry applies bounds to both category and book-policy life fields
through the shared API/import coercer. Integer setup fields no longer turn
booleans/arrays into numbers or accept unsafe integers.

Twenty-two safe regressions failed before correction. All 68 focused pure tests
and 71 database checks pass, including invalid-input rollback, unchanged audit
history on refusal and exact lifetime totals at the supported upper boundary.
The API workload is substituted in its dedicated boundary test to prevent a
regression from executing a billion-row loop; adjacent real schedule-building
and asset-control tests pass. All 3,118 unit tests, workspace type checks and
the locked production build pass. Explicit-any/lint ceilings remain 391/725.
Evidence: `audit-depreciation-bounds-2026-09-05`. Asset-edit audit coverage and
concurrent custom-data preservation are still open and are the next correction.

## Complete asset-edit evidence and concurrent custom preservation — continuation from 5e369662

Asset PATCH previously audited only depreciation-basis changes. Account-only,
status, identity, descriptive and tax-election changes could commit without
material configuration evidence. Every successful edit now stores the complete
locked before-image and committed after-image alongside the actor, in the same
transaction. Decimal amounts remain strings, and creation/update timestamps use
the shared lossless PostgreSQL representation. A failed audit write rolls the
asset and schedule changes back.

Custom data is now merged from the locked row, replacing only submitted tenant
fields or tax elections. Metadata-only saves leave custom data untouched. Three
real-writer tests cover metadata, defined custom fields and tax elections while
another transaction commits newer provenance; their audit before-images also
start at that committed state. All twelve new regressions failed before the
fix. All 80 expanded database checks, 3,118 unit tests, web typechecking and the
locked production build pass. The large-value audit check preserves
`900000000000000.1234` exactly. Explicit-any/lint ceilings remain 391/725.
Evidence: `audit-asset-edit-evidence-2026-09-05`.

A separate confirmed gap remains: the asset drawer submits full forms without
a client revision precondition, allowing sequential stale editors to overwrite
one another. That API/UI correction and adversarial tests follow next.

## Asset editor revision integrity — continuation from 5d8bb3fa

Asset PATCH now requires the exact loaded PostgreSQL revision and compares it
after acquiring the asset lock. Missing, malformed, rounded and stale tokens
return a conflict without changing the record or its evidence. Reads preserve
all six timestamp digits. The saved payload is assembled under the same
transaction lock, so its revision belongs to that save.

The existing drawer pins its editing revision, sends it with each save, adopts
the successful revision and preserves edits made while a response is pending.
Conflicts retain local input. Explicitly reopening the editor resets fields
and revision together; a background refresh cannot silently refresh a dirty
form's token. Placing an asset in service sends only the status and revision.

Seven new regressions failed before correction. All 88 expanded integration
checks plus 13 adjacent valuation checks pass. All 3,118 unit tests, web types
and the locked production build pass. Thirteen real-browser checks exercise
lossless tokens, pending-response edits, subsequent saves, competing editors,
conflict preservation, reload/retry and status-only activation. The expected
409 is the only browser console error in that journey. Evidence:
`audit-asset-revision-2026-09-05`. Explicit-any/lint ceilings remain 391/725.

Browser inspection also confirmed unnamed asset controls, and tracing their
shared custom-field component found a lossy Number conversion for currency
defaults. Those are retained for the next correction, not treated as covered
by the passing save-flow checks.

## Asset form accessibility and shared exact defaults — continuation from c396defc

Native asset fields and tax-election controls now associate their existing
labels with stable per-instance control IDs. Shared custom-field controls use
the same association, name hidden-label controls and reference pickers, and
label multi-select groups. Existing shared components and layouts are retained.

Custom currency/number defaults previously crossed Number(), losing precision.
They now retain decimal strings. Defaults initialize only when a field becomes
editable; passive viewing no longer consumes them. Cancel/reopen can initialize
an unsaved default again, while an explicit clearing during editing stays clear.

Thirty-four real-browser checks pass: named native/custom/tax controls, label
focus, exact default hydration, clearing, cancel/reopen and successful persisted
values of `900000000000000.1234` and `123456789012345.1234`. An initial fixture used
an unsupported eight-decimal numeric default and was correctly refused; the
final fixture uses the validator's four-decimal domain. All 3,118 unit tests,
web typechecking and the locked production build pass. Evidence:
`audit-asset-form-accessibility-2026-09-05`. Explicit-any/lint ceilings remain
391/725. This is targeted form coverage, not a site-wide accessibility claim.

## Broader integration checkpoint at 30e5eb01

The isolated full suite passed all 1,976 tests with zero skips/failures in
1,167,019.820166 ms. Four fixture slots completed four bootstraps, teardowns and
schema verifications; all 1,551 leases were released/reset, with zero active
leases or leak detections. Redis-dependent checks ran against the local test
service without mail workers. Both the suite and fixture-owner processes have
exited. Log and lifecycle receipt are retained under
`audit-asset-lifecycle-date-2026-09-05`.

That exact revision includes the asset lifecycle chronology, scope, historical
edit controls and valuation display corrections. It precedes the subsequently
verified depreciation bounds, complete asset-edit evidence, revision protection
and form corrections above; those have their own focused/build/unit/browser
receipts and require the next broader integration checkpoint.

## Shared form-picker boundaries — continuation from 77705be3

The form options endpoint resolved authentication but discarded subsidiary
visibility. Both party transports (including active customer/vendor/employee
role filters), both account transports and project references now enforce the
existing record-scope policy. Shared null-subsidiary master records remain
available to callers with entity access; an empty entity scope returns no
subsidiary-aware records. Organization-wide items retain their existing model.
Project references also enforce the authoritative Projects feature gate.
Both account transports now provide readable labels for unnumbered accounts.
The database pool was already context-wrapped; it was not an RLS bypass.

Eighteen regressions failed before correction. All 29 database checks pass,
covering unrestricted/restricted/empty scope, shared records, active-role
filters, inactive records, foreign tenants, unnumbered accounts and the
Projects on/off control without deleting data. All 3,118 unit tests, web type
checks and the locked production build pass. Evidence:
`audit-form-picker-boundaries-2026-09-05`. Explicit-any/lint ceilings remain
391/725. The next full integration run is executing the preceding exact
checkpoint `77705be3`; this picker correction is not included in that run.

The separate accounting conformance run at `77705be3` passed all 42 registered
cases, with zero failures, declared gaps or unrun cases within that corpus.
The report is retained under `audit-asset-form-accessibility-2026-09-05/conformance-77705be3`.
Those bounded cases do not certify all accounting standards or provider behavior.

Continuing traces confirmed missing audit evidence for custom-field definition
writes, rejection of the registry-supported fixed-asset custom-field target,
and a read-only display-mode spelling mismatch between settings and the shared
renderer. These remain open for the next corrections.


## Custom-field definition evidence and stale-editor controls

Continuation from `0c774bb7` found that definition creation and edits wrote no
actor or audit record. PATCH also rebuilt omitted fields from an unlocked read,
allowing concurrent administrators to silently overwrite each other. Fourteen
real-database regression cases reproduced twelve failures before correction.

Creation and edits now write actor, request ID and complete before/after evidence
inside the same transaction as the definition. PATCH locks the tenant-scoped row,
checks the exact six-digit revision, and advances it monotonically. The settings
page returns that lossless revision; the drawer pins it to its initial draft and
handles transport failure without losing input or permanently disabling Save.
Malformed and absent field IDs now reach the native not-found surface instead
of throwing a UUID database error or opening a creation drawer.

Verification: 14 database cases plus 6 adjacent route cases passed, including
forced audit refusal, waiting writers, competing edits, permission and foreign
record checks. Fifteen production-build browser assertions passed for two-editor
conflicts, exact revisions, reviewed retries, transport recovery and missing
records. Web type checks, the locked production build and all 3,118 canonical
unit tests passed (150,839.497875 ms; zero skips). The existing lint and explicit-any
limits were retained. Evidence is in `audit-custom-field-controls-2026-09-05`.
The browser uses a disposable tenant and the runtime RLS database role.

The first unit invocation also caught a documentation regression from the prior
commit: external benchmark URLs tripped the product-neutrality guard. The source
bibliography is now retained in the private evidence packet; the public comparison
remains vendor-neutral, and the unchanged gate passes. Browser test selectors were
corrected to use the actual translated transport error and the framework's
streamed not-found UI; neither correction changed application behavior.

Open custom-field traces remain: registry/creation target divergence, read-only
mode handling, configuration precision/validation, duplicate creation concurrency,
and app-provisioned definition controls. This checkpoint does not certify those
remaining paths or replace the broader integration checkpoint.

## Native custom-field targets and feature visibility

Continuation from `e91e4e54` repaired the designer's reader/writer disagreement:
entity forms loaded definitions from their native tables but created new fields
under document targets. A shared storage-capability catalog now supplies the
API and settings picker, with transaction kinds derived from the record registry.
Inline creation resolves the same table and kind used by the reader and appears
only where a supported header or line store exists. Fixed assets and time entries
join the existing writable targets; the missing transaction kinds include deposit,
transfer, project charge, quote, sales order, purchase order and field ticket.

Feature visibility now derives tables from that catalog and recognizes line-table
ownership, so fixed-asset and time-entry definitions are hidden and creation is
refused while their parent features are disabled. Stored definitions are retained.
The definition audit and revision controls from the preceding slice remain in force.

The focused set passed 50 cases: 35 database cases, six adjacent route cases and
nine catalog cases. The browser created fields through all seven native entity
form designers, reloaded each definition, created a deposit line field and found
the new asset field in the native asset editor (31 assertions). Initial browser
setup required the disposable tenant's normal onboarding deferral. A missing
rate-card target translation discovered during settings inspection was corrected
by reading its existing registry label key instead of constructing one.

Discovery also identified list profiles for budget scenarios, revenue contracts
and equipment units without corresponding custom-value storage columns. Those
profiles require a separate end-to-end capability repair; adding them to the
creation picker alone would not make them functional. No existing writable target
was removed. The initial discovery log includes those six out-of-scope checks and
an owner-role fixture-count assumption; the final focused set tests the supported
storage paths and identifies its newly created definitions explicitly. Browser
journeys use the restricted runtime role to exercise actual tenant isolation.

The full integration checkpoint at `77705be3` completed with all 2,009 tests
passing, zero failures and zero skips (1,145,213.853458 ms). Its four fixture slots
recorded 1,584 leases, releases and resets, four bootstrap/teardown/schema cycles,
zero active leases and zero leaks. This exact checkpoint precedes the picker and
custom-field corrections; it must not be described as covering their later commits.

Final target-slice verification also passed seven settings-picker browser checks
(38 browser assertions total), all workspace type checks, the rebuilt locked
production bundle and all 3,127 canonical unit tests (102,299.969625 ms; zero skips).
The new labels use the record registry's actual translation keys. The lint and
explicit-any limits remain 725 and 391. Evidence is retained under
`audit-custom-field-targets-2026-09-05`.

## Shared select placement and custom-field read-only display

Continuation from `22a40e4a` reproduced two visible defects. The settings editor
saved `displayMode: readonly`, but the asset header still exposed an editable
input because the shared renderer recognized only the legacy `disabled` spelling.
Generated line columns ignored both read-only spellings. Header and line controls
now recognize both modes, retain displayed values, and keep read-only defaults
from mutating the editor. Hidden fields remain absent and normal fields editable.
These are display controls; this change does not claim to establish field-level
API authorization or historical definition versioning.

The shared desktop select also always placed its menu below the trigger without
checking viewport space. In a drawer the read-only option was visible in the DOM
but outside the viewport and could not be clicked. Placement now chooses a side
with sufficient space, clamps width and height to the viewport, scrolls oversized
option lists, and remeasures after content changes, drawer scrolls and resizing.
The existing mobile sheet is preserved.

Verification passed eight focused cases, including a viewport-boundary matrix and
both display modes across all custom line types, plus 16 real-browser assertions
covering retained values, suppressed defaults, pointer selection at 768/420/260px
heights, live resizing and filtered search menus. All 3,135 canonical unit tests
passed (148,990.359917 ms; zero skips). Workspace type checks passed after adding
an explicit Node type reference to the new UI-package test; the locked production
build passed. The 725-warning and 391-explicit-any limits were retained.
Evidence is under `audit-custom-field-display-2026-09-05`.

## Custom-field definition configuration integrity

Continuation from `12f34b1a` reproduced a label-only currency edit rounding
`900000000000000.1234` to `900000000000000.1`: the drawer converted bounds through
`Number`. It also rebuilt configuration from an empty object, losing reference
filters and extension metadata; a reference definition could not be saved because
its target disappeared. The editor now preserves unknown metadata, keeps numeric
bounds as exact strings, exposes the existing reference type and target catalog,
and composes the shared typed input for defaults. Labels are associated with their
controls, legacy display aliases load correctly, and controls are disabled while a
save is pending. The shared Boolean control now preserves its empty choice instead
of silently converting it to false; the settings list uses the reference label.

The API now rejects malformed configuration, non-Boolean flags, invalid sort
orders, blank/duplicate options, invalid display metadata, impossible defaults,
reversed bounds and unsupported decimal precision before writing. Accepted bounds
are canonical decimal strings; valid false, zero and multi-selection defaults are
retained. Validation composes the existing value validator, and normalization
preserves extension metadata. Existing definition row locks, revision tokens and
transactional before/after audit evidence remain in force.

All 52 initial invalid-definition reproductions failed before remediation. The
expanded focused set passed 121 cases: 74 configuration database cases, 35 adjacent
control/target database cases, eight adjacent route/date cases and four editor
configuration cases. Invalid requests preserve both definitions and audit rows;
valid definitions survive creation and label-only edits. The owner-role database
fixtures test explicit predicates and authorization, while browser journeys use
the restricted runtime database role with enforced tenant RLS.

Final verification passed 42 real-browser assertions, all 3,139 canonical unit
tests (106,287.997709 ms; zero skips), workspace type checks and the locked production
build. The browser separately reproduced and then verified the Boolean empty-state
repair. Two initial browser assertions used guessed English labels; they were
corrected to the observed existing labels before the final run. The 725-warning
and 391-explicit-any limits are unchanged. Evidence is under
`audit-custom-field-config-2026-09-05`.

The full integration run at `22a40e4a` also completed: all 2,073 tests passed with
zero failures or skips (1,108,872.978958 ms). Four fixture slots recorded 1,676 leases,
releases and resets, four bootstrap/teardown/schema cycles, zero active leases and
zero leaks. Its receipt is retained under `audit-custom-field-targets-2026-09-05`.
That run predates the display and configuration slices and does not cover them.
Concurrent definition creation, app-installed definitions, historical type changes
and reference-value enforcement remain separate audit work; this checkpoint does
not certify those paths or claim repository-wide defect freedom.

## Concurrent custom-field creation and app ownership

Continuation from `aef293f3` proved that eight simultaneous authenticated API
requests could create six definitions with the same tenant, target and key.
The database reproduction also produced eight winners for competing app installs
and six winners for mixed API/app writers. Both entry points checked for an
existing definition before inserting, without sharing a lock or unique index.

Creators now acquire the same transaction advisory lock for each tenant/table/key.
App bundles acquire all keys in sorted order, including when declarations arrive
in opposite orders. Losing installs roll back their app, version and definition
writes. Inserts also handle database conflicts without reporting a successful
creation. Forward migration `0088_custom_field_definition_uniqueness.sql` adds a
unique index over tenant, table, normalized kind and key. It includes inactive
rows because historical custom values still refer to their keys. Different tenant,
table and non-null kind scopes remain independent. The original baseline is intact.

The migration locks the definition table during preflight and index installation.
It reports legacy collisions and rolls back without renaming, merging, deactivating
or deleting definitions. Before rollout, the schema owner should run:

```sql
select org_id, target_table, coalesce(target_kind, '') as kind_scope, key,
       array_agg(id order by id) as definition_ids
from public.custom_field_defs
group by org_id, target_table, coalesce(target_kind, ''), key
having count(*) > 1;
```

Any result requires a reviewed repair that accounts for existing custom values and
audit history. Schedule the write-blocking metadata migration in the normal schema
window. Application locks work before the index exists; retain the index during
an application rollback. No production migration or deployment was performed.

Verification passed 129 focused checks, including competing creators, reversed
bundle order, adjacent app transaction/audit cases and definition controls. The
migration tests verify direct concurrent inserts, updates, null/empty equivalence,
inactive identity, independent scopes, repeat application and collision preservation
in isolated schemas. The final migration text passed those tests again after its
required header was added. The canonical migration inventory now lists the new
forward file; no published migration was edited.

Four production-browser scenarios sent 32 requests under the restricted runtime
role: three contested scopes each produced one success and seven conflicts, while
eight independent keys all succeeded. All 3,139 canonical unit tests passed
(86,781.305416 ms; zero skips), workspace types and the locked build passed, and the
725-warning/391-explicit-any limits remain unchanged. Evidence is under
`audit-custom-field-creation-2026-09-05`. App definition validation and per-definition
audit evidence remain separate work; the concurrency repair does not certify them.

## App-provisioned custom-field controls

Continuation from `078b1df6` reproduced an app installing a currency definition
with a Boolean label, a string required flag, reversed bounds and an invalid
default. It also produced no per-definition audit record. Seventeen initial
regressions failed across malformed definitions, missing evidence, audit-failure
rollback and provisioning into a disabled Projects domain.

Bundle parsing and API writes now share the structural definition contract and
native target catalog. Installation composes the same server-side configuration
and reserved-key validation as the API, canonicalizes exact bounds, and refuses
unsupported definitions before writing. App upgrades preserve the existing target
identity. Each create/update records full before/after evidence with actor,
timestamp and app-version provenance inside the installation transaction; failed
audit writes roll back app versions and definitions together. Definition revisions
advance monotonically even when the stored timestamp is ahead of transaction time.

App provisioning takes the authoritative feature fence before checking enabled
targets and holds it to commit. Feature helpers accept the existing transaction
executor, keeping their reads on the connection that owns the lock. A concurrent
disable test verifies the installer waits, then refuses creation after the feature
is disabled. The creation locks and unique index from the preceding slice remain.

All 169 focused checks passed (384,762.117333 ms), including 19 app-field control
cases, adjacent app transactions, definition races and feature controls. Seven
production-browser checks verified actual install endpoint rejection, valid
installation/upgrade and exact values in the native editor. Workspace types,
the locked production build and all 3,139 canonical unit tests passed
(573,630.853 ms; zero skips). The warning and explicit-any limits remain 725 and
391. Evidence is under `audit-app-field-controls-2026-09-05`.

The broader run at `078b1df6` finished with 2,152 of 2,153 tests passing, zero skips,
and one fixture-owner timeout in the item-costing null-existing case
(7,677,927.124542 ms total). All 12 item-costing revision cases passed when rerun
against the same source checkpoint. That does not turn the failed full run green.
Its lifecycle receipt reports 1,754 leases but 1,755 releases/resets and -1 active
leases. Inspection confirmed overlapping releases can both reset and decrement the
same slot; this harness defect remains to be repaired before the next full run.
Both the failure log and exact receipt are retained with the creation-slice evidence.

## Fixture concurrency and owner disconnections

Continuation from `61d9b950` repaired the harness defects exposed by that full run.
Concurrent initialization could exceed the configured pool size, concurrent
borrowers could receive the same tenant, and overlapping releases could reset and
count the same lease twice. Partial initialization failures skipped cleanup;
concurrent closes could finish before teardown; and losing every healthy slot
could leave queued requests pending. A separate socket reproduction showed that
an owner closing without a complete reply left its request unresolved.

Initialization, reset and close operations now share their in-flight promises.
Slots are reserved before yielding or waking a borrower. Close waits for pending
resets and cleans successfully created tenants even after partial initialization
failure. Lifecycle verification rejects any nonzero active count or mismatch
between leases and releases. An exhausted pool rejects queued borrowers, and
incomplete owner replies reject promptly on connection end or close.

Ten regression tests cover these cases. The final real owner/worker probe passed
all 34 checks, including all 12 item-costing revision cases, with 16 leases,
16 releases/resets, four bootstrap/teardown/verification cycles, zero active leases
and zero leaks (36,415.554959 ms). All 3,149 canonical unit tests passed with zero
skips (151,697.324541 ms); engine types and changed-file lint passed. The warning
and explicit-any ceilings remain 725 and 391. Evidence is under
`audit-fixture-concurrency-2026-09-05`.

These are test-harness changes; the preceding production build remains the latest
product build checkpoint. The failed full integration result above remains a
failure until a fresh complete run establishes a new checkpoint. Passing targeted
reruns does not certify the entire codebase or establish production readiness.

## Asset category policy after financial history

Continuation from `49b17c21` reproduced category edits that redirected an asset's
inherited accumulated-depreciation account after depreciation or impairment had
posted. Both API requests returned success, despite direct asset edits already
refusing the equivalent change. Lifecycle posting also read category defaults
without taking the category lock used by depreciation.

Forward migration `0089_asset_category_policy_guard.sql` prevents changes to a
category's book accounts, depreciation method, formula reference, life, convention
or identity once its assets have posted depreciation or lifecycle history. Reversed
history still counts. The database boundary also covers imports and direct writers;
it preserves existing data and permits unchanged policy, labels, activation and
connector metadata. Categories without financial history remain configurable.
This controls book policy; it does not certify every tax-attribute policy.

Disposal and remeasurement now lock the asset and then its category before reading
defaults, matching depreciation's lock order. A settings write either commits
before posting reads those defaults or waits and is refused after posting commits.
Category setup edits record the locked before row and actual after row, with actor,
in the same transaction. Failed evidence writes roll back the edit.

All 83 focused checks passed (60,996.479042 ms; zero skips), including 12 new cases
covering eight protected policy fields across depreciation, impairment, disposal
and reversed history, both concurrency orders, metadata, audit rollback and tenant
scope. Four authenticated production-browser checks passed under the restricted
runtime role. All 3,149 canonical unit tests passed (183,084.880333 ms; zero skips),
workspace types and the locked production build passed, and the 725-warning /
391-explicit-any ceilings remain unchanged. Evidence is under
`audit-asset-category-policy-2026-09-05`.

Apply the forward migration through the normal schema rollout before relying on
the new application behavior. Keep category policy writes paused during a mixed
old/new application rollout, because older lifecycle code lacks the category lock.
Retain the guard on application rollback. A rejected historical policy change needs
a new category for future assets or a controlled accounting adjustment; do not drop
the guard to force it through. No production migration or deployment was performed.

## Shared setup evidence and root metadata

Continuation from `435ea9fb` confirmed five initial regressions: root-subsidiary
metadata edits were rejected by a misplaced deletion check, generic setup creation
and updates lacked stored snapshots, deletion recorded an empty object, and tax
group evidence omitted ordered memberships. A subsequent check also found that
unused tax groups could not be deleted because their owned membership rows were
left behind under a non-cascading foreign key.

The shared setup audit helper now loads the tenant-scoped stored row and ordered
tax-group members. Generic creation records the actual after-image; updates lock
and record before/after state; deletion records the retained before-image. All
evidence shares the mutation transaction and actor. Tax-group deletion removes
owned memberships within that transaction; transactional references still refuse
deletion and restore those memberships. The root metadata refusal is removed,
while existing structural validation and database deletion protection remain.

All 37 focused checks passed (11,704.544084 ms; zero skips), including 12 new cases
for snapshots, ordered membership, all three audit-failure rollback paths,
concurrent before-images, tenant boundaries and root controls. Nine authenticated
production-browser checks passed; the retained database receipt verifies their
six configuration audit records. All 3,149 canonical unit tests passed
(174,763.260834 ms; zero skips), workspace types and the locked production build
passed, and the warning/explicit-any ceilings remain 725/391. Evidence is under
`audit-setup-evidence-2026-09-05`.

This repair covers the generic setup mutation path. Specialized book-promotion and
effective-versioning branches still need their own complete snapshot audit; this
checkpoint does not certify those branches or the entire configuration surface.

## Specialized setup evidence and derived-rule lifecycle

Continuation from `516a0cdb` reproduced eight failures in the specialized setup
branches. Book creation, promotion and default reassignment omitted complete
stored snapshots; derived-rule creation and effective-date closure did the same.
Archiving a rule or closing its window without changing pricing also accessed
`setParts` before initialization and returned a runtime error instead of saving.

Book promotions now share a transaction helper that locks every row being demoted
and records its actual before/after state plus the reassignment reason. Both
creation and promotion record the new/current book's complete stored state.
Derived-rule creation, successor insertion and prior-window closure likewise use
actual snapshots. The unchanged-policy path builds its own validated assignments,
preserves the rule identity and records the successful lifecycle change.

All 57 focused checks passed (14,605.8535 ms; zero skips), including 20 new cases
covering both book types and entry points, rule creation/versioning/archive/window
edits, and rollback when either stage of a compound operation cannot append its
evidence. Eight authenticated production-browser checks passed, with retained
actor/snapshot receipts. The browser fixture initially omitted the Payroll feature
and correctly received 404; the final run enabled it explicitly. Workspace types,
the locked production build and all 3,149 unit tests passed (162,058.127334 ms;
zero skips). Warning and explicit-any ceilings remain 725 and 391. Evidence is
under `audit-setup-specialized-evidence-2026-09-05`.

The fresh full integration run at `49b17c21` passed all 2,172 tests with zero skips
(1,189,243.166 ms). Its lifecycle receipt balances 1,773 leases/releases/resets,
four bootstrap/teardown/verification cycles, zero active leases and zero leaks.
This establishes a passing checkpoint after the earlier failed run; it does not
retroactively change that failure. The checkpoint includes the fixture and app
definition fixes, but predates the category and setup changes above. Their full
integration checkpoint remains to be established.

## Rate-book deletion versus default promotion

Continuation from `af29d59e` reproduced a delete request that passed its default
check, waited behind a concurrent promotion, then deleted the newly selected
default. The response was successful and the intended default no longer existed.

Deletion now joins the same tenant advisory lock as creation and promotion, then
checks the default flag on the locked row. If promotion commits first, deletion
returns a conflict and retains the book. If deletion commits first, a waiting
promotion refuses the missing record and preserves the prior default. Unused
nondefault deletion still records its retained before-image.

All 45 focused checks passed (12,690.546292 ms; zero skips), including five new
default/deletion cases and adjacent compound audit rollback controls. Workspace
types, the locked production build and all 3,149 unit tests passed
(172,319.421334 ms; zero skips). Warning and explicit-any ceilings remain 725/391.
Evidence is under `audit-rate-book-default-2026-09-05`. The full integration run at
`af29d59e` is independent and predates this race repair. A separate investigation
has reproduced setup writes committing after a feature disable; that issue remains
open at this checkpoint.


### 2026-09-05 — Setup feature-disable serialization

Real PostgreSQL races reproduced six interactive setup mutations committing after
a concurrent feature disable. The request passed its initial feature check,
waited behind another writer, then inserted, updated or deleted configuration
after the disable committed. Additional probes reproduced equipment-trigger and
subsidiary-scoped writes escaping their subordinate feature gates.

All nine interactive setup mutation branches now join the authoritative tenant
feature fence before any book or row locks. Entity gates and submitted-field
integrity are checked again using that transaction's connection. Feature-default
resolution and sequence-kind validation accept the same executor, including
uncommitted tenant configuration. Rejections retain the existing rollback
boundary and return the normal unavailable/invalid-input response.

The 105 focused checks passed (91,394.642334 ms; zero skips), including 18 new
checks covering parent-gate create/update/delete races, equipment triggers,
subsidiary scope, currency and Field Ticket controls on create/update, and
transaction-local feature defaults. Adjacent audit rollback, book-default and
asset-category history controls also passed. Workspace types, the locked
production build and all 3,149 unit tests passed (166,500.532 ms; zero skips).
Warning and explicit-any ceilings remain 725/391. A built HTTP probe of the parent-gate fix observed a
waiting request, committed a Projects disable, and received 404 with no new
rate book; that probe preceded the subsequent field-validation extension.

A scoped initialization-order scan examined 849 engine/API source files and
found no additional candidates for the specific earlier-if/return pattern. Its
positive control identified the previously fixed derived-rule declaration bug.
This is pattern coverage, not a claim that all initialization defects are absent.

Evidence is under `audit-setup-feature-fence-2026-09-05`. A separate real-database
probe confirmed that a cached bulk setup import resource still writes after its
parent feature is disabled; that import path remains open at this checkpoint
and is the next repair. The independent full integration run at `af29d59e`
predates this interactive repair and finished with 2,209/2,216 passing
(2,681,872.425791 ms), seven asset-category guard failures and zero skips.
Its reused database was still migrated only through 0087: the category policy
trigger from 0089 was absent. This was a test-environment preparation error,
not a passing full run or fresh-bootstrap verification. All 1,820 fixture leases
were released/reset, with four bootstrap/teardown/verification cycles and zero
leaks. The next full run must first execute the deployment bootstrap and verify
the migration ledger and live category trigger.


### 2026-09-05 — Bulk setup import feature controls

A loaded setup import resource could continue writing after its parent feature
was disabled. Imports also discarded an explicitly supplied disabled subsidiary
scope and created an unscoped record, accepted foreign rate-book currency with
Multi-Currency off, and advertised import support for read-only reference data.
Four initial regressions reproduced those failures. The read-only currency probe
reached SQL but rolled back on an audit UUID error; no persisted global-currency
change was observed or claimed.

Bulk setup writes now bind their tenant transaction, join the authoritative
feature fence, and re-resolve entity/field availability before processing rows.
Unavailable fields reject their row instead of changing its meaning. With
Multi-Currency off, an omitted book currency uses the organization's recorded
base currency on creation and preserves the existing currency on update.
Read-only resources advertise no import support and refuse writes before SQL.
Per-row savepoints and the import job's outer evidence transaction are retained.

All 39 focused checks passed (11,940.936666 ms; zero skips), including 13 new
checks for stale resources, insert/upsert races, unavailable fields, previews,
tenant binding, base currency, row-level failure continuation and whole-import
rollback when job evidence fails. Workspace types, an additional final web
typecheck, changed-file lint, the locked production build and all 3,149 unit
tests passed (159,943.019625 ms; zero skips). Production dependency audit
reported zero known vulnerabilities; warning/explicit-any ceilings remain
725/391. Five built
browser HTTP checks ran under the non-bypass runtime role: mixed valid/invalid
rows, unavailable currency, base-currency creation, read-only preview, and a
feature disable committed while an import waited. Stored rows and import-job
counts matched every result. The isolated browser, server and tenant were
cleaned up. Evidence is under `audit-setup-import-controls-2026-09-05`.

The ongoing independent full run at `df56ab44` first applied deployment
bootstrap and verified the ledger through 0089 plus the live category guard.
Its formerly failing category cases now pass; the full run remains pending
and does not include this later import repair. A separate follow-on probe has
confirmed that book imports bypass first-default selection and allow direct
demotion of the current primary/default book. That book-policy path remains
open at this checkpoint and is the next repair.


### 2026-09-05 — Shared primary/default book lifecycle

Three database probes showed imports creating the first active rate book without
a default and directly demoting current default/primary books. A fourth probe
showed interactive promotion of an inactive rate book demoting the prior active
default. These paths could leave the organization without its authoritative
active book.

Interactive and imported accounting/rate-book writes now compose one shared
book lifecycle in `web/lib/setup/books.ts`: first-default selection, prevention
of direct demotion, active-default validation, tenant book locking, promotion
and full stored-row audit evidence. Import previews run the same validation
without mutations. Every demotion and promoted row stays inside the caller's
transaction/savepoint, including the import job's outer audit transaction.

All 70 focused checks passed (22,683.738958 ms; zero skips), including 14 new
book import and inactive-promotion cases. Eight injected audit failures verify
rollback at both demotion and promotion for insert/upsert on both book kinds.
Seven built browser HTTP checks passed with the non-bypass runtime role; stored
rows retained one active default and one active primary, and six successful
changes retained their actor and before/after evidence. The browser, server and
disposable tenant were cleaned up. Workspace types, final web types, changed
lint, the locked production build and all 3,149 unit tests passed
(209,570.99825 ms; zero skips). The refactor removed two explicit
`any` uses; the enforced explicit-any and warning ceilings were tightened to
389 and 723. Evidence is under `audit-setup-import-book-policy-2026-09-05`.

The independent full run at `df56ab44` passed all 2,239 checks
(2,488,757.585875 ms; zero skips). All 1,844 fixture leases were released/reset,
with four bootstrap/teardown/verification cycles and zero leaks. This checkpoint
predates the two import repairs. A further real-database probe has reproduced earning creation
through both interactive setup and imports storing five tax/statutory booleans
as false when they were omitted, despite explicit true defaults in the setup
registry. Metadata updates likewise reset omitted flags, and malformed boolean
strings are accepted as false. Those shared coercion defects remain open at
this checkpoint and are the next repair.


### 2026-09-05 — Declared setup defaults and explicit boolean controls

Six database regressions reproduced earning creation ignoring five declared
true defaults, metadata updates resetting omitted flags to false, and malformed
boolean strings being accepted as false. Both interactive setup and bulk imports
shared the same coercer. These were implicit changes to taxability, pension,
insurance, vacation and disposable-earnings eligibility settings.

The shared row builder now applies declared defaults on creation and preserves
omitted booleans on updates. Explicit false remains an intentional configuration
choice. Boolean fields accept the existing supported scalar spellings used by
CSV/XLSX imports and reject unrecognized strings, objects, arrays and non-boolean
numbers. Declared numeric/select defaults pass through the same validation as
submitted values; an invalid explicit value never falls back to a default.

All 66 focused checks passed (38,784.556417 ms; zero skips), including ten new
database cases and four pure coercion checks. Eight built browser HTTP checks
passed under the non-bypass runtime role. Stored earning flags remained true
through omission-only updates, explicitly exempt components retained false,
malformed rows were absent, and all six successful changes retained audit
evidence. Workspace types, changed-file lint, the locked production build and
all 3,153 unit tests passed (161,343.061417 ms; zero skips). Quality ceilings
remain 389 explicit-any uses and 723 warnings. Evidence is under
`audit-setup-declared-defaults-2026-09-05`. The isolated browser, server and
fixture tenant were cleaned up.

No stored component flags are mass-rewritten: an existing false value can be an
intentional exemption, and previous input omission cannot be inferred reliably
from the stored value. The next complete integration checkpoint will include
this coercion repair and both import repairs after the passing `df56ab44` run.


### 2026-09-05 — Preserve committed payroll component tax policy

Two real create/calculate/commit regressions changed historical employment
income from 240.0000 to zero: editing the base earning's taxable flag and deleting
its component. Deletion detached the historical stub line through the existing
SET NULL foreign key. Neither action changed the committed pay amounts.

Forward migration 0090 preserves component tax identity and classification after
committed or voided payroll use, and refuses deletion that would detach that
history. Unused components remain editable/deletable; names, active status and
future amount settings remain editable. Payroll commit locks its used component
rows in deterministic order before checking freshness. An earlier policy edit
invalidates the calculation; a later edit waits and is refused after commit.
Raw policy edits also stamp their actual write time for the freshness check.
Interactive setup returns a named conflict; bulk import rolls back the failed
row and its audit evidence.

All 64 focused checks passed (27,251.689834 ms; zero skips), including eleven new
database cases covering classification fields, deletion, voided history, both
concurrency orders, setup routes and imports. Six built browser HTTP checks
passed through the restricted application database role; the actual tax slip
remained unchanged, and successful metadata/create/delete actions retained audit
snapshots. The failed import was recorded as failed. The isolated browser,
server and fixture tenant were removed. Workspace types, changed-file lint,
locked production build and all 3,153 unit tests passed (109,509.3385 ms; zero
skips). The first unit attempt caught the missing migration-inventory entry;
0090 is now listed explicitly, without relaxing the inventory check. Quality
ceilings remain 389 explicit-any uses and 723 lint warnings. Evidence is under
`audit-payroll-historical-policy-2026-09-05`.

The migration was applied with the normal bootstrap on a disposable database
and its SQL was repeated successfully. Deploy the forward migration before the
new application commit path. It changes no tenant data and leaves the baseline
untouched; an application rollback should retain the database guard. No
production database or deployment was changed. Existing misclassified or
already-detached history cannot be reconstructed from current settings and is
not silently rewritten.

The broader payroll review continues with two separately reproduced defects:
generic setup import preview claims success for a historical-policy update that
commit refuses, and changing an employee's current country can remove their
already committed tax slip. This component-policy repair does not certify
historical employee filing context, remittance mappings or every payroll path.


### 2026-09-05 — Setup previews exercise the real write controls

Five failing database regressions showed preview accepting historical-policy
changes, storage-invalid rows and unavailable audit evidence, and counting two
rows with one natural key as two creates. The committed import would refuse or
classify those rows differently.

Setup preview now runs the ordinary batch writer under a savepoint and rolls
back the complete batch before returning. Earlier preview rows are visible to
later rows, so duplicate inserts and repeated upserts have the same outcomes as
commit. Storage guards and audit writes are exercised in the same transaction;
row failures retain their existing isolation. Rolling back the preview leaves
its caller's preceding and subsequent transaction work intact. Preview takes
real write locks while validating and is not a reservation against changes
that another transaction makes afterward.

All 46 focused tests passed (13,359.747708 ms; zero skips), including six new
preview regressions and the existing book, feature-gate and declared-default
checks. Seven built browser HTTP checks passed through the restricted runtime
role. Database evidence showed no preview components, duplicate departments,
audit entries or import jobs; the one deliberately committed department had
exactly one audit entry and one committed import job. The committed payroll
slip stayed unchanged. Workspace types, changed-file lint, locked production
build and all 3,153 unit tests passed (139,178.652667 ms; zero skips). Ceilings
remain 389 explicit-any uses and 723 lint warnings. Evidence is under
`audit-setup-preview-validation-2026-09-05`; the isolated browser, server and
fixture tenant were removed.

This closes the preview mismatch recorded in the previous checkpoint. The
separate historical payroll country/profile defect remains the next accounting
remediation; this checkpoint does not claim that all historical payroll context
is stable.


### 2026-09-05 — Historical payroll country and prospective component flags

The completed full checkpoint at `c37020fc` passed 2,276 tests with zero failures
or skips (1,249,145.195084 ms). Its fixture receipt records 1,877 balanced leases,
releases and resets, four bootstrap/teardown/verification cycles, and no active
leases or leaks. It includes the import and declared-default repairs preceding
`900c1248`, not the subsequent payroll-history and preview changes.

Two new real-payroll regressions showed a committed Canadian tax slip disappearing
after its employee profile was moved to another country or deleted. Pay stubs
now capture the resolved statutory country and its provenance at calculation.
Forward migration 0091 derives existing attribution from the already-stored
province/state using the disjoint region sets of the two supported legacy packs;
it never consults the employee's current country. Unrecognized legacy regions
remain explicitly unknown and block affected year-end populations with a named
review requirement. New calculations supply their country directly, including
future pack identities. The stored country cannot be overwritten in place.
Canadian, regional Canadian and US year-end populations use the stub country and
retain committed rows even when the live profile is absent.

The full run at `53b0b90d` exposed one overbroad restriction in migration 0090:
prospective pension/insurance/vacation/non-periodic flags were frozen although
their resulting monetary bases and accruals are already stored on stubs. Forward
migration 0092 keeps historical report classification and destructive deletion
protected while allowing those prospective inputs to change. It also stamps
actual write time for every changed component row, so a raw prospective edit
cannot bypass calculation freshness. The existing controlled retro-pay test now
passes without being weakened. The earlier full-run failure remains recorded;
a new complete checkpoint is required for this implementation.

All 75 focused checks passed (23,230.987459 ms; zero skips), including Canadian
profile moves/deletion, regional slips, US W-2 and quarterly worksheets, captured
provenance, all 65 legacy region mappings, immutable country, unknown legacy
refusals, component freshness, setup controls and controlled retro pay. Three
built year-end API browser checks passed with the restricted runtime role:
original data, a later country change, and profile deletion all retained the
same Canadian amounts and no US wage rows. Workspace types, changed-file lint,
locked production build and all 3,153 unit tests passed (166,440.629166 ms; zero
skips). Quality ceilings remain 389 explicit-any uses and 723 lint warnings.

A separate database was bootstrapped from the prior `53b0b90d` schema and seeded
with genuinely calculated/committed payroll before upgrading. Its current
profile was moved to the US before migration. Upgrade recovered CA from the
historical ON region, preserved every pre-existing stub field exactly, and
restored the original 240.0000 employment-income slip. Repeating the normal
bootstrap retained that result. The upgrade database, browser tenant, browser
and server were removed. Evidence is under
`audit-payroll-country-snapshot-2026-09-05`.

Apply 0091 and 0092 before the new application reads country snapshots. The
migrations preserve monetary history and existing fields; retain their additive
columns and guards when rolling an application version back. Legacy unknown
attribution requires review of original evidence and must not be filled with a
guessed country. Historical opening-balance country, employee filing-account
assignment, remittance destination and other live profile dependencies remain
separate review areas; this checkpoint does not certify those paths or all
payroll history.

## Payroll filing-account snapshots and legacy reconciliation — 2026-09-05

Two actual calculate/commit regressions showed that changing an employee's
filing account, or changing the organization's default, moved already committed
240.0000 wages and accrued remittance groups to a different employer account.
Calculation resolved the correct filing account but did not persist it; year-end
and remittance queries recomputed it from live profiles. New pay stubs now store
that resolved account and explicit provenance. Captured null stays unassigned.
T4 employment and employer-contribution summaries, W-2, Form 941 and remittance
amount/gross/headcount grouping read the snapshot. Historical labels include
inactive accounts; prospective selectors retain their active-account filter.

Forward migration 0093 adds the snapshot, same-tenant foreign key, immutable
attribution guard and evidence fields. It does not invent a historical account
for legacy stubs: those remain unknown and affected reports refuse pending
review. An operational reconciliation command validates original evidence,
checks live payroll-management permission, previews by rolling back actual
writes, and applies a reviewed batch atomically. Only unknown attribution can be
resolved once. Storage records the actor, timestamp, full before/after row and
evidence; incomplete evidence, cross-tenant/country accounts, reassignment of
captured history and deletion of referenced accounts are refused. See
[the reconciliation runbook](payroll-filing-attribution-reconciliation.md).

Following the historical account through authorization found another defect:
the remittance route checked the current profile's account before returning
historical account totals. A real two-subsidiary route regression reproduced a
200 for an out-of-scope original employer after reassignment to a visible one.
The route now checks the stored account and returns the same 404 as a missing
record. Historical filing/remittance checks can authorize inactive original
accounts; creation checks remain active-only. Unresolved legacy remittance
reports return a controlled 422 instead of an unhandled server error.

All 84 focused tests passed (26,462.555375 ms, zero skips), covering Canadian and
US reporting, profile/default changes, profile deletion, deactivation, explicit
unassigned history, immutable attribution, authorization, tenant/country
coherence, audit evidence, batch rollback inside caller transactions, amendments,
remittance execution and controlled retro payroll. Workspace types and
changed-file lint passed. An upgrade database bootstrapped from `b64b0736` was
seeded with committed payroll and then a later profile reassignment. Migration
preserved every original stub field exactly and left attribution unknown.
Command preview left zero changes/audits; apply restored the account proven by
the original register, preserved monetary fields and wrote exactly one audit.
Repeating apply was refused with no additional audit.

Evidence is under `audit-payroll-filing-snapshot-2026-09-05`. This checkpoint does
not reconstruct missing original evidence or certify opening-balance attribution,
mutable filing-account metadata, remittance destination/accounting policy, or
all payroll workflows. No production database or deployment was changed.

## Cross-domain scope, integrity and control divergences — 2026-09-06

The remaining-coverage column above named eight domains where only the API
transport had been traced. This pass hunted each of them for the recurring
defect shape (policy divergence between entry points) and for history
mutability, concurrency and arithmetic faults, then fixed what reproduced.
Every correction ships with a database regression that failed against the
prior implementation and passes now; the before/after logs are under
`thr_euzdd2x36a/<domain>/`.

### Payroll

Server pages and the assistant tools read payroll populations directly from
the engine while the JSON routes guarded them, so a caller restricted to one
legal entity was shown year-end slips, separation documents, remittance
aggregates, opening balances and retro schedules its own API refused with
404. One loader module (`web/lib/payroll-scoped-views.ts`) now makes every
scope decision, and the pages, the routes and all six assistant payroll tools
read through it; a source-pattern test pins the pages to the loaders. The
generic import route bound the caller's subsidiary fence on export but not on
import: a restricted importer could load payroll carry-ins (the only input for
the year's CPP/EI ceilings) for another entity's employee, and the preview
disclosed that employee as "created". Import now refuses restricted callers
for every resource that does not enforce the fence in its write path, and the
payroll resources enforce it row by row before preview reports anything.

The commit-time freshness gate never watched statutory carry-ins: a carry-in
saved between Calculate and Commit was silently ignored, the employee was
deducted past the annual maximum, and the carry-in was then locked in a state
the committed stub contradicted. The gate now watches carry-in rows, their
components and the save's audit evidence (deletes leave no row to timestamp),
and the carry-in save serializes on the same employee × tax-year fence the
commit takes. The retro-pay control set (voided or moved source period,
cross-year, retired component, another open retro run holding the same cell)
was computed and displayed nowhere and enforced nowhere: the commit now
refuses a retro run with any blocker, the pre-flight shows the findings, and
retro-run creation serializes per schedule and refuses a duplicate up front.

The liability account a committed deduction was credited to was re-read from
the pay component's current setup by the remittance summary and the
remittance bill, so repointing a component moved an already-accrued period to
a different account. Forward migration 0094 stamps the credited account on
each committed stub line; the commit resolves it once for the GL projection
and the stamp, remittances read the stamp, and it is immutable. Committed
legacy lines are backfilled from the component's account and marked as such
(the figure every summary reported until now, so no historical amount
changes); lines whose component names no account keep resolving through the
pack's legacy slot. The remittance destination (vendor) remains a policy read
from setup: which party is paid is a prospective decision, which account was
credited is history.

### CRM

Opportunity deletion ignored the caller's subsidiary scope, read its
linked-document guard unlocked against an estimate route that inserts links
under a row lock, and left activity links dangling so every restricted reader
lost those activities forever. Deletion now locks the scoped row, checks and
removes links inside one transaction, and writes audit evidence. The party
activities tab omitted the shared activity boundary (a hidden note's body was
searchable one substring at a time); estimates from opportunities were gated
on the AR create permission alone and now require CRM manage as well; a
header-probability change without resent lines recomputed the weighted amount
from the header and contradicted stored per-line overrides; malformed dates
and non-UUID order ids reached PostgreSQL as server errors and now fail as
client errors. Duplicate team members are refused.

### Tax and statutory

Taxable-base return boxes summed every posted document family for a code, so
a code that applies to both sides put purchases into the sales box and vice
versa (GST34 line 101, VAT100 boxes 6 and 7). Each box now resolves its side
from the pack definition or the code, restricts to the kernel's document
families and nets credit memos. Filing preparation locked and versioned on the
requested window but stored the obligation-clamped window, so a second
version of a mid-quarter registration could never be prepared; identity is
now derived from the stored window. The provision detail, information-return
and compliance pages dropped the scope their routes pass; every by-id
information-return route (lifecycle, transmittal export, recipient copies,
recipient adjustments) had no entity gate; the tax page rendered every filing
to callers every tax route refuses. All now apply the routes' fences.

### Projects and construction

Progress billing (schedule of values, change orders, applications, retainage
release) and subcontracts checked organization membership only, and the
project cockpit page and the WIP billing workspace reached any project by id
while the project route refused it. Project financials dropped every
organization-wide overhead rate through a null-equals join and double counted
stacked department rates, disagreeing with the posting engine and the WIP
pricing. A time amendment re-derived bill rate, cost rate and costing basis
instead of negating the original, so a reversal did not net to zero and an
estimated-basis original produced phantom negative overhead. The
not-to-exceed cap counted posted invoices only, so two open billing requests
could each draft the full contract value. Retainage and change-order dates
reached PostgreSQL unvalidated, and milestone billing claimed unpriced
schedule rows it did not bill. Each is corrected with its regression.
The WIP billing workspace also selected a column the project-type table
does not carry, so every prebill creation and the WIP analytics query failed
against the current schema; the fallback profile now resolves from the type's
newest published financial-profile version and fails closed when none exists.

### Inventory, AP/AR and property

The shared document action route validated no action verb: any spelling other
than submit fell into the posting path under the create permission. Manual
landed-cost apportionment debited inventory for a target whose layers carried
no value and wrote no allocation, leaving the GL over the subledger with
nothing to reverse. Lot-recall filters and dunning ids reached the database
unvalidated; the dunning document kind was an unchecked string that could mail
vendors. Extending an active lease never extended its base-rent window (a
renewal billed nothing); escalations applied out of date order under-
compounded rent; a lease could be re-parented into an unseen entity; the
schedule horizon and billing date were unbounded; a deposit offset could be
the liability account itself; CAM rounding residue and the finalize
fingerprint depended on physical row order.

### General ledger, close and consolidation

Ownership consolidation posted non-controlling-interest and equity-method
adjustments untranslated for foreign subsidiaries, and a successor
effective-dated ownership policy re-posted the acquisition elimination. The
intercompany-residual readiness check summed functional-currency amounts
across currencies, and the FX-revaluation check disagreed with the engine on
zero deltas, monetary overrides and a missing following period, so a
reconciled multi-currency group could never be approved for close. The
generated adjustment period overlapped the final regular day and made
year-end consolidated statements fail with a scalar-subquery error.
Re-deriving consolidated rates on a closed period restated published
statements with no lock, audit or close-run invalidation. All six are
corrected; two new close exceptions name missing consolidated rates and a
missing reversal period.

### Deferred, by name

Purchase orders for stock items cannot be billed because nothing produces the
receipt leg the three-way match requires; the design (a purchase-receipt
document clearing received-not-billed, or a procurement setting for the match
depth) is recorded in the thread ledger and not built. Party deactivation with
open opportunities, empty forecast snapshots, re-billing a voided rent
invoice, a self-service change-password route (only the email reset exists),
persisting a taxable-base side on tenant-authored boxes, and a zero-priced
stock line on a bill for an item with a received-not-billed account (raw
nonzero-journal violation) remain open and named.

### Verification for this batch

Every workspace typechecks and the locked production build passes. The unit
suite passed 3,169 tests with zero failures or skips. The integration suite
ran on a freshly bootstrapped isolated database (migration 0094 applied by
the production bootstrap) and passed 2,353 of 2,357 tests with zero failures;
the four skips are the pre-existing environment-conditional cases (the
no-context fail-closed probe, the two Redis-backed flow-email cases, and the
runtime-role tax-pack installer), none of them new. Fixture receipt: 1,950
balanced leases, releases and resets, four bootstrap/teardown/verification
cycles, no active leases and no leak detections. Lint reports zero errors and
722 warnings; the ceiling was tightened to that measured count, and explicit
`any` remains at its 389 ceiling.

An upgrade database bootstrapped from `04cafd03` was seeded with committed
payroll whose CPP component carried a tenant-mapped liability account and
whose EI component did not. Migration 0094 stamped the mapped component's
lines as `legacy_component` with that account, left the unmapped lines
`unknown`, reported identical remittance accounts before and after, and kept
reporting the mapped account after the component was repointed. Evidence is
under `thr_euzdd2x36a/payroll/`.

Not certified by this pass: the purchase-receipt leg and every item listed
under "Deferred, by name"; live provider acceptance, object-storage recovery,
production-scale load and complete end-to-end business journeys. No production
database or deployment was changed.

## Goods receipts close the procure-to-pay gap for stock — 2026-09-06

Stock lines on a purchase order bill on a three-way match, but nothing in the
product produced the receipt leg: the only writer of the received quantity
was sales fulfillment, so every order carrying an inventory, assembly or kit
line was unbillable through conversion and AP capture alike. A new immutable
`purchase_receipt` document, the inbound counterpart of the sales shipment,
receives an approved order's stock lines (partial, lot/serial-aware,
idempotent, fenced under the order lock) at the order price against the
item's received-not-billed account. The vendor bill for received stock now
clears that account instead of receiving the stock a second time, and any
difference between the invoiced and order price posts to the item's purchase
price variance account with a deterministic entry so replays cannot book it
twice. Vendor-credit returns accept goods-receipt movements as their source.
See `docs/operations/purchase-receipts.md`. A dedicated receipt reversal
remains open, as it does for shipments.

## Second hunt round: identity, extensions, files, reports — 2026-09-06

The four domains the first round left untraced were hunted the same way and
produced 25 reproducible defects, all corrected with regressions.

### Identity and sessions

A user holding only the user-management or role-management permission could
assign themselves the built-in administrator role, or rewrite their own role
to the full catalogue, in one request. Delegated administration now enforces a
ceiling: a role may only be granted, created or widened within the actor's
own effective permissions, never to oneself, with super administrators exempt.
Deleting a role stripped every assignment and left active users with valid
sessions that could reach nothing; the delete now refuses when active users
would be left without a role unless a replacement role within the ceiling is
supplied, and every removed or replacement assignment is audited. Entering a
sandbox environment was gated only in the shell; the resolver every request
uses now requires the sandbox permission for the production identity, so a
stale environment cookie cannot keep a member inside after the permission is
removed. The internal service endpoints compared their shared token with
plain equality and passed the tenant id to the row-security scope unvalidated;
a constant-time helper and a UUID gate now front both.

### Extensions, scripts and application tools

Journal writes from installed apps and user scripts always posted into the
organization's root entity regardless of the caller's scope; they now resolve
the entity with the same decision table the journal draft route applies and
refuse anything outside scope. Script query helpers bypassed the query
console's three gates (feature, permission, unrestricted scope) and are now
held to them for attributed callers. The assistant's open-items, financial
trends and budget tools ran without the caller's entity allowlist; a
correction tool let a restricted actor re-home the replacement document into
an unseen entity; uninstalling an app destroyed the provenance a reinstall
needs, so any reinstall was refused forever. All corrected; reinstalls now
re-adopt provisioned objects from the uninstall's audit evidence.

### Files, PDFs and sandboxes

Detaching an attachment skipped the visibility gate the listing applies and
was the step around the retention guard for evidence on posted documents; the
PDF template preview rendered a real record, including pay stubs, to anyone
with the customization permission; header and footer merges interpolated
record values unescaped; zip entry names were built from raw file names; and
three PDF routes reached the database with unvalidated ids. Sandbox refreshes
re-copied production credentials that only creation had neutered, the clone
copied API keys and SFTP servers into globally unique indexes (which made
sandbox creation fail for any tenant that had ever created an API key), and
masked sandboxes still carried bank routing, taxpayer identifiers and the
organization's tax registrations. All corrected; credential tables are now
excluded from clones outright, and refreshes neuter and re-mask.

### Reports and statements

Six report pages ignored the caller's entity restriction while their exports
honoured it; the aging drill-through was unscoped; the indirect cash flow fell
through to organization-wide net income and cash for an empty scope; the
direct cash flow statement fused parallel accounting books; scheduled report
deliveries rendered a frozen copy of the definition so edits never reached
recipients; financial trends mixed period identity with posting date and were
unscoped by book and entity; dimension filters reached the database
unvalidated; and the prior-period comparison was an equal-day window rather
than the prior accounting period. All corrected. Scheduled deliveries now
render the current definition and re-check the pinned principal's access.

### Deferred, by name

A dedicated goods-receipt reversal; a replacement-role picker in the role
delete dialog; book selection on statement PDF exports (the page has a book
selector, the export always renders the primary book); resolving pay-stub
subsidiary scope through the pay run so restricted callers can print their
own entity's stubs; the first round's open items.

### Verification for the second round

Every workspace typechecks and the locked production build passes. The unit
suite passed 3,209 tests with one failure that was a doctrine conflict, not a
product defect: the reports correction had moved the financial-trends query
onto posting-date windows, which the period-identity contract forbids; the
query was restored to exact ledger period identity (closing cash as a balance
across every ledger period ending on or before the row's period) with the new
book and entity scoping kept, and the contract, trends and assistant-scope
tests pass. The integration suite ran on the isolated database and passed
2,383 of 2,387 with zero failures and the same four environment-conditional
skips. Fixture receipt: 1,980 balanced leases, releases and resets, four
bootstrap/teardown/verification cycles, no leaks. Lint reports zero errors and
722 warnings at the ceiling; explicit `any` holds at 389. The goods-receipt
regression drives receipt, replay, over-receipt refusal, receipt-governed
billing, price variance, replay of the posting-effect drain and the
no-clearing-account refusal end to end against the real posting engine.

## Payroll PDF ownership and year-to-date isolation — 2026-09-07

The pending commits through `a564b7a9` were verified with a fresh 3,209-test unit
run (284,927.055333 ms, no failures or skips) and pushed normally to main. The
previous `b64b0736` full integration run also completed: 2,301 passed, no failures
or skips (1,149,000.970791 ms), with 1,901 balanced fixture leases/releases/resets,
four bootstrap/teardown/verification cycles, no active leases and no leaks.

The named pay-stub PDF gap was reproduced for both stubs and payroll cheques.
Their shared print/email scope resolver returned a null subsidiary because the
catalog types have no direct document kind; every subsidiary-restricted reader
was refused, including one who owned the pay run. Template previews similarly
returned no real payroll sample for any restricted designer. Both now resolve
the tenant-bound pay-run document's subsidiary. A later employee transfer does
not change the original payroll's ownership, and hidden, foreign and missing
records remain refused.

Tracing that newly accessible output exposed another defect: year-to-date
amounts summed every committed stub for the employee across legal entities and
currencies. A CAD 240 stub printed CAD 3,240 after including CAD 1,000 from another
employer and USD 2,000. The value loader now limits YTD to the original pay-run
entity and the stub's currency. The regression also includes another valid CAD
60 stub for the same employer and proves it still accumulates: CAD 300 gross/net
and CAD 15 tax, with the other entity/currency excluded. All print, preview,
email and merged-run outputs share this loader.

All 18 focused checks passed (14,276.224459 ms, zero skips), including real
PostgreSQL ownership/transfer/sample/YTD cases and the existing print, send,
preview and run-scope route tests. The two remaining untyped payroll row reads
in this loader were replaced with unknown-valued rows and explicit currency
conversion; quality ceilings were tightened by two. No schema migration,
production data mutation or email delivery was needed. Evidence is under
`audit-payroll-pdf-scope-2026-09-07`.

Final validation passed all 3,209 unit tests (93,060.887959 ms; no failures or
skips), workspace typechecks, changed-file lint and the production build using
the exact locked dependencies. The route inventory assertion was updated to
require payroll's document join and subsidiary predicate instead of the old
blanket refusal. Canonical lint measured 720 warnings and explicit-any measured
387; both ceilings match those counts. The broader audit remains open: a real
two-book probe has reproduced statement export selecting primary-book revenue
100 instead of the requested secondary-book revenue 700, and statement drill
state also omits the selected book. Those are the next remediation slice.

## Accounting-book selection across statements and supporting rows — 2026-09-07

A real two-book probe populated primary-book revenue 100 and secondary-book
revenue 700. The P&L screen selected the secondary book, but `resolveReport`,
which supplies statement exports and scheduled rendering, returned 100. The
balance-sheet page had no matching book selection, and both statement drill
state and the supporting-row loader dropped the book. Invalid, foreign, missing
or inactive explicit selections silently changed the P&L back to its primary
book instead of refusing the request.

Pages and the shared renderer now use one tenant-bound active-book selection
helper. Only an omitted selection defaults to the primary book; explicit
unavailable selections fail closed, and valid UUID case is normalized. Balance
Sheet composes the existing P&L `ReportFilterBar` book selector. The chosen book
is identified on report paper and exported output and travels through the
shared table, URL target parser and supporting-row query. Invalid drill book
syntax returns 400; unavailable books return 422.

Budget Actual cells had the same defect: they escaped their scenario into a
primary-book ledger drill. All budget cells now retain scenario identity, and
Actual supporting rows use the tenant-verified scenario book, including after
that book is retired. The scenario remains the authority for historical budget
comparisons; a retired scenario book is not substituted with another book.

Validation: all 21 focused checks passed (23,039.931083 ms, no skips), covering
real page props, the shared export/schedule renderer, CSV and XLSX output,
drill routes, unavailable/foreign selections, case normalization and retired
budget-book history, alongside report authorization and subsidiary regressions.
All 3,209 unit tests passed (150,812.605750 ms; no failures/skips), web typecheck
and the exact-lock production build passed. Canonical lint measured 719
warnings after removing the shared table's unused-expression warning; its
ceiling was tightened to match. Explicit-any remains 387.

The locked production dependency audit reported zero known vulnerabilities.
That is advisory-database evidence, not proof that dependencies contain no
vulnerabilities. The full integration suite for `255ac64e` is still running in
an immutable checkout with a disposable runtime DB role and isolated Redis.
The next CRM slice has real failing probes: deactivation leaves active open
opportunities behind, and draft/activation routes accept inactive parties.
Evidence is under `audit-statement-book-selection-2026-09-07` and
`audit-crm-party-lifecycle-2026-09-07`.

## Party retirement and CRM lifecycle serialization — 2026-09-07

The named party-retirement gap was reproduced through real routes: an exact-
revision, reason-bearing PATCH returned 200 and deactivated an account with an
active open opportunity. A second probe created and activated CRM work for an
already inactive account. Two-connection regressions also showed retirement
missing work committed while it waited for the account lock, and activation
missing account retirement committed while it waited for that same lock.

Party retirement now obtains the account lock and rechecks both the existing
transaction/balance dependencies and active non-closed opportunities inside the
mutation transaction. Refusals preserve the party and audit history. Opportunity
drafting checks account activity both before work and after taking the account
lock; activation/reopening checks it against the locked account and status.
Existing work on an inactive account can still be closed with the existing
permission and loss-reason controls. A closed opportunity does not prevent
account retirement. No historical CRM rows are deleted or reassigned.

All 25 focused checks passed on the final source (9,975.952416 ms, no skips),
including both real concurrency directions, audited retirement refusal, allowed
closure, CRM write validation, exact revisions and restricted party reads.
All 3,209 unit tests passed (115,982.827500 ms; no failures or skips). Replacing
the route's untyped predecessor with its existing row type exposed a mutable
closure narrowing error; capturing its prior probability resolved it, and the
final locked-dependency production build and focused tests passed. Canonical
lint measured 718 warnings and explicit-any measured 386; both ceilings were
tightened accordingly. Evidence is under `audit-crm-party-lifecycle-2026-09-07`,
including `concurrency-before-corrected.log` from the prior source.

The next confirmed financial defect is property billing's stale schedule read:
a competing transaction changed scheduled rent from 1,000 to 500 and shortened
its end date while billing waited for the schedule lock. Billing still created
a 1,000 invoice with the old date range and marked the 500 schedule invoiced.
Evidence is under `audit-property-billing-snapshot-2026-09-07`. The broader full
integration run for `255ac64e` remains in progress; this checkpoint is not a
claim that the codebase has no remaining defects.

## Rent billing reads its locked financial source — 2026-09-07

Billing discovered due schedule rows before its transaction, later locked only
their IDs, and still created invoices from the old discovery values. A real
competing write reduced a scheduled charge from 1,000 to 500 and shortened its
period to July 15 while billing waited; the resulting invoice still charged
1,000 through July 31. The same race ignored revised charge descriptions and a
lease's newly disabled auto-invoice control.

Discovery now supplies only candidate IDs. The billing transaction locks and
rechecks lease eligibility, holds property and charge configuration stable,
and reads complete invoice inputs under the schedule locks. Lease-before-
schedule ordering matches termination and lease edits; charge-before-schedule
ordering matches escalations. The lease uses a non-key update lock so an
in-flight escalation can insert replacement charges through their foreign-key
checks without deadlocking the waiting biller. A real escalation service race
proves that the invoice follows the newly prorated schedule and period.

All 20 focused tests passed (10,163.381083 ms, no skips): proration, configuration
and suspension races, the real escalation race, idempotent replay, property
billing provenance, CAM controls and base-rent concurrency. All workspace
typechecks and the exact-lock production build passed. Final unit verification
passed all 3,209 tests (133,367.523416 ms; no failures/skips); an old feature-gate
assertion's 4,000-character window was replaced with a function-scoped check
that still requires the inventory refusal. Changed-file lint is clean; quality
ceilings remain 718 warnings and 386 explicit-any nodes. No schema or protected
posting/sync/deployment file changed. Evidence is under
`audit-property-billing-snapshot-2026-09-07`.

The next forecast probes have confirmed three defects: empty pipelines report
201 Created with no persisted snapshot; impossible calendar dates reach SQL;
and an unqualified override of 250 is duplicated as both CAD 250 and USD 250.
Evidence is under `audit-crm-forecast-snapshots-2026-09-07`. The named voided-rent
re-billing gap is separate and remains open.

## Forecast snapshot evidence and currency controls — 2026-09-07

Empty pipelines previously returned Created with no snapshot rows. Impossible
calendar dates reached SQL, and an unqualified override of 250 was persisted
as both CAD 250 and USD 250. Calculated snapshots also accepted override values
and override snapshots accepted missing amounts. Real route probes reproduced
these failures before correction.

The shared calculator and route now validate calendar dates. Empty calculated
forecasts persist explicit zero evidence, recording the selected currency or
organization reporting basis. Nonzero overrides require an explicit currency
when the pipeline does not identify exactly one currency, and snapshot kind
must agree with the presence of an override. Currency selection is validated
against the currency registry. The page uses the same calendar validation and
shared typed forecast row. No amounts are converted or duplicated across currencies.

All 18 focused tests passed (6,874.415375 ms, no skips), including six new
route/page integration cases. All 3,209 unit tests passed (146,712.491125 ms;
no failures or skips). Final web typecheck and exact-lock production build
passed; changed-file lint is clean. Removing five untyped tuple entries
tightened explicit-any to 381 and canonical lint warnings to 713. Evidence:
`audit-crm-forecast-snapshots-2026-09-07`.

The immutable full integration run at `255ac64e` completed: 2,390 tests passed,
zero failures/skips, 1,607,841.639667 ms. Its fixture receipt records 1,991
leases, releases and resets, zero active leases and zero leak detections.
This validates that commit, not all later changes. The exact-lock production
dependency audit reported zero known vulnerabilities. Neither result proves
absence of unknown defects.

A subsequent real posted-rent probe confirmed that controlled invoice voiding
leaves the rent schedule invoiced and prevents corrected rebilling. Evidence:
`audit-property-rebilling-2026-09-07/before.log`. That remediation is next.

## Controlled rent invoice replacement — 2026-09-07

Voiding a posted rent invoice left its schedule permanently invoiced. Deleting
a generated draft failed the schedule's tenant-qualified document foreign key.
The shared controlled void/delete path now releases rent reservations and records
actor, reason and before/after evidence in the same transaction. Failed commands
leave both reservation and evidence unchanged.

The original invoice retains its unique billing key and schedule provenance.
Each replacement uses a deterministic generation key linked to its predecessor;
voided documents are never adopted as live invoices. Existing schedule locking
serializes competing retries. No posted history or database constraint is removed.

All 17 focused integration tests passed (9,776.186583 ms, zero skips), including
repeated real posted reversals, draft deletion, concurrent replacement requests,
refused void, transaction rollback, tenant isolation and prior billing races.
All 3,209 unit tests passed (167,033.543667 ms, zero failures/skips). Workspace
typechecks, exact-lock production build and changed-file lint passed. Quality
ceilings remain 713 warnings and 381 explicit-any nodes. Evidence is under
`audit-property-rebilling-2026-09-07`.

Adjacent probes confirmed that lease termination strands prorated final rent
and CAM-generated draft deletion fails its allocation foreign key. These are
separate remaining corrections; this checkpoint does not close the broader audit.

## Bill earned final rent after termination — 2026-09-07

The real termination service prorated July rent from 1,000 to 483.8710 through
July 15, but billing excluded every terminated lease and stranded that earned
amount. Both discovery and the locked billing read now admit terminated leases
only for schedule periods ending on or before their termination boundary.
Auto-invoice suspension remains authoritative. Cancelled future periods and
legacy unprorated periods crossing termination are never admitted.

All 30 focused checks passed (10,274.244292 ms, no skips), including three new
integration cases: exact final rent and future-period cancellation, suspension
and unprorated-history refusal, and billing racing the actual termination
transaction. Existing replacement, escalation, billing provenance and feature
contracts also passed. Engine typecheck and changed-file lint passed. The
previous commit's 3,209-unit/build gates remain recorded separately; this SQL
admission correction was checked with its affected suites. Evidence is under
`audit-property-final-rent-2026-09-07`.

Full integration is running against immutable `a1381bba`. A further CAM
concurrency probe proved that billing and pool reopening can both succeed
while reopening deletes the newly billed allocation. Its initial waiter probe
was corrected to recognize a queued lock waiter; actual defect evidence is
`audit-property-rebilling-2026-09-07/cam-race-before-corrected.log`.

## CAM correction and billing concurrency — 2026-09-07

Deleting generated CAM invoice and credit drafts failed their allocation
foreign keys. Separately, concurrent pool reopening and billing both succeeded
while reopening deleted the allocation belonging to the new invoice. A pool
lock alone was insufficient: the original reopening query evaluated its billed
dependency subquery before waiting and retained that stale result afterward.

CAM invoice/credit void and deletion now release reservations with actor, reason
and before/after evidence in the same transaction. Finalized amounts and the
invoiced pool state remain frozen. Billing accepts released allocations from
those pools, uses the shared predecessor-linked generation keys, and holds the
pool lock before reading locked allocation/configuration values. Reopening
checks billing dependencies in a fresh statement after obtaining that lock.
The existing CAM table exposes replacement billing for released nonzero amounts.

All 25 focused integration checks passed (28,973.311750 ms, no skips), including
seven new lifecycle cases: invoice/credit draft deletion, posted reversals,
both reopen/bill race directions, competing replacements, tenant isolation and
rollback of source release plus audit evidence. All three CAM rendering tests
passed. All 3,210 unit tests passed (138,835.685334 ms; no failures/skips).
Workspace typechecks, exact-lock production build and changed-file lint passed.
Quality ceilings remain 713 warnings and 381 explicit-any nodes. Evidence is
under `audit-cam-billing-lifecycle-2026-09-07`; the first direct UI invocation
lacked the repository's TSX config, and the corrected invocation and canonical
unit run both passed. No protected posting, sync or deployment file changed.

The full immutable integration run at `a1381bba` remains active. The next
confirmed payroll defect is the mutable account fallback for legacy liability
lines with no saved account: changing component setup reinterprets an already
committed period. Evidence is under `audit-payroll-legacy-liabilities-2026-09-07`.

## Refuse mutable legacy payroll liability fallbacks — 2026-09-07

A pre-0094 line with unknown liability evidence still resolved its account from
the current component or statutory setting. A real legacy fixture changed the
same committed CPP period's remittance account merely by repointing setup.
Remittance reads now use only the saved account; a nonzero unresolved historical
liability refuses reports and bill creation with an explicit evidence error.
Changing either setup source cannot bypass that refusal. Known snapshots and
unrelated periods remain usable. No legacy account is inferred or overwritten.

All 27 focused checks passed (12,400.161583 ms, zero skips), including the new
legacy refusal, zero bill artifacts on rejection, known snapshot stability,
Quebec filing/remittance, overlapping-period and destination-fence races. The
small committed-accrual race fixture now includes the liability stamp a real
commit writes; its concurrency assertions are unchanged. Engine typecheck and
changed-file lint passed. Evidence: `audit-payroll-legacy-liabilities-2026-09-07`.

Operational limitation: unresolved legacy liability accounts require reviewed
original evidence before affected remittance work can resume. The existing
filing-account reconciliation command handles filing attribution only, not
liability accounts. A separately guarded liability reconciliation path remains
necessary; neither current setup nor a manual trigger bypass is an acceptable
production repair. The full `a1381bba` integration run is still in progress.

## Reviewed legacy liability reconciliation — 2026-09-07

Forward migration 0095 adds evidence for a one-time unknown-to-reconciled
liability transition. Existing amounts, account stamps and posted history are
preserved. The database requires a tenant-owned posting liability account,
unchanged payroll facts, committed source payroll, an actor and original
evidence. Captured/reconciled attribution cannot be overwritten, and a legacy
line cannot impersonate a new commit. The service checks payroll management
permission and original pay-run legal-entity scope, holds the source document
against voiding, and rolls failed batches back even inside caller transactions.

The operational command copies the existing filing-reconciliation workflow:
preview performs the guarded writes and audit inserts, then rolls back; apply
records the reviewed mapping. Repeating an apply is refused. See
[the runbook](payroll-liability-reconciliation.md). No production records were
reconciled, and no baseline migration or protected posting/sync file changed.

All 17 focused integration checks passed (34,608.899209 ms, no skips), including
three new reconciliation cases for preview rollback, atomic failed batches,
permission/entity/tenant refusals, immutable evidence, unchanged amounts and
competing one-time updates. The actual CLI preview, apply and repeated-apply
refusal passed. Workspace typechecks, exact-lock production build and changed-
file lint passed. An isolated database bootstrapped from `a1381bba` was seeded
with six real committed payroll lines and one unknown account. Applying the
final 0095 file preserved every old amount/account/source; reviewed resolution
then restored remittance reporting.

The unit run passed 3,209 of 3,210 tests (147,020.629125 ms); its only failure
was the canonical migration inventory missing the newly added filename. That
explicit inventory was extended, and the complete canonical-baseline test file
passed afterward. The initial migration-header convention failure was also
corrected; the final upgrade used a fresh disposable database and the exact
final migration, without altering any applied checksum. Quality ceilings
remain 713 warnings and 381 explicit-any nodes. Evidence is under
`audit-payroll-legacy-liabilities-2026-09-07`.

The next confirmed defect is historical remittance scope: an employee transfer
removes the original employer's access and exposes its earlier totals to the new
employer. The corrected fixture records original scope 404/zero groups versus
new scope 200/one group while the pay-run owner is unchanged. Evidence is under
`audit-payroll-remittance-history-scope-2026-09-07/expanded-before.log`.

## Full integration checkpoint and fixture corrections — 2026-09-07

The immutable `a1381bba` run completed with 2,410/2,412 passing tests, zero skips
(1,519,803.123250 ms). Fixture ownership balanced all 2,014 leases, releases and
resets, with zero active leases or leak detections. Both failing assertions
were investigated rather than treating the focused pass as sufficient.

The forecast boundary test manually inserted a second zero snapshot after the
API had correctly started persisting one. It now verifies the API-created ID
and retains its restricted-reader denial checks. The book-selection fixture
used a superuser/schema-owner connection: its unqualified subsidiary picker
could select another pooled scratch tenant. The test now explicitly selects
its own entity while retaining primary/selected/invalid book and export/drill
assertions. An independent controlled proof reproduced the missing amount with
the schema owner and returned exactly 100.0000 for the default selection under
the real NOSUPERUSER/NOBYPASSRLS runtime role. No production report code was
changed for that fixture failure.

All 26 affected checkpoint checks passed afterward (11,601.681833 ms, no skips).
The subsequent full unit gate passed 3,210/3,210 (146,813.395375 ms, no skips);
workspace typechecks and the locked-dependency production build passed. Evidence:
`audit-property-rebilling-2026-09-07/full-integration.log`,
`statement-runtime-proof.log`, and
`audit-payroll-remittance-history-scope-2026-09-07/checkpoint-regressions.log`.
A complete integration pass on the newer committed source is still required.

## Historical remittance ownership and artifact isolation — 2026-09-07

Moving an employee to another subsidiary previously denied the original
employer's remittance history while letting the new entity read its earlier
liabilities. The original pay-run document had not moved. Both the shared
HTTP/page period guard and the engine's amounts/context queries now follow
that original document's legal entity. Empty scopes remain deny-all and
filing-account authorization remains an additional check.

A second real fixture showed that filtered accruals still included matching
remittance bill artifacts owned by another entity. Existing-bill discovery
now applies the same legal-entity scope, protecting document identifiers and
amounts as well as accrual totals.

All 59 focused checks passed (11,160.972375 ms, no skips), including two new
integration cases proving both directions of employee-transfer scope and
hidden bill exclusion while confirming the unfiltered fixture contains the
bill. All 3,210 unit tests passed (146,813.395375 ms, zero failures/skips).
Workspace typechecks, locked-dependency production build and changed-file lint
passed. Evidence: `audit-payroll-remittance-history-scope-2026-09-07`.

The next year-end population probe confirms an availability defect: after an
employee transfer the original employer receives 404 for its historical filing
population. The new employer was also refused in that fixture; it is not
evidence of year-end disclosure. Evidence:
`audit-payroll-filing-history-scope-2026-09-07/before.log`.

## Native UUID filing authorization — 2026-09-07

The filing row parser accepted UUID versions 1–5 while this database generates
UUIDv7. A real hidden-entity filing account was silently removed from a T4
row's authorization inputs, allowing the restricted caller through. Native
employee IDs were also rejected, and malformed nonempty account suffixes were
treated as unassigned accounts. The parser now uses the shared UUID validator,
retains valid account IDs, and refuses malformed nonempty suffixes.

The new integration regression failed before the fix and passes afterward.
It verifies hidden-account denial in both stored-row and population guards,
visible-account acceptance, native employee IDs across built-in filing shapes,
and malformed T4/W-2 suffix denial. All 56 focused checks passed
(7,330.440375 ms, zero failures/skips); web typecheck and changed-file lint
passed. Evidence: `audit-payroll-filing-history-scope-2026-09-07/uuid-before.log`,
`uuid-regression-before.log`, `uuid-focused.log`, `uuid-typecheck.log`, and
`uuid-lint.log`. The historical employee-transfer filing defect remains a
separate open audit item.

## Annual filing ownership after employee transfer — 2026-09-07

Annual T4/W-2/RL-1 access previously followed the employee's current party
subsidiary. The original employer therefore lost its historical filing
population after a transfer. The shared population and amendment-row guards
now check original pay-run documents for the requested country and tax year;
every HTTP route and the shared page/tool loader supplies that year. Voided
pay runs remain ownership evidence for stored historical artifacts.

The guard checks the employee's whole year because annual caps and opening
carry-in can affect multiple account/province rows. Filing-account checks
remain additional. Opening balances lack historical employer stamps, so
nonzero carry-in still requires the current employee boundary in addition to
any pay-run ownership. This deliberately does not invent an employer for
unstamped imported money. ROE's current-employment, cross-year source scope
remains a separate audit item.

The new regression failed before the correction. All 61 focused checks passed
(19,438.270375 ms, zero failures/skips), including original/new employer access,
amendment rows, empty/unrestricted scopes, tax-year separation and opening-only
and mixed opening/pay-run evidence. Web typecheck and changed-file lint passed.
Evidence: `audit-payroll-filing-history-scope-2026-09-07/history-regression-before.log`,
`history-focused.log`, `history-typecheck.log`, and `history-lint.log`.

The full unit gate also passed 3,210/3,210 (148,866.245458 ms, zero failures or
skips), and the locked-dependency production build passed (`history-unit.log`
and `history-build.log`). Follow-up review found that the remittance page/tool
loader and GET route omit the engine's subsidiary argument; that caller gap is
a separate confirmed repair item, despite the engine-level filtering passing.

## Remittance transport and refusal isolation — 2026-09-07

The earlier engine-level bill filter was insufficient: the shared page/tool
loader and GET route omitted the actor's subsidiary argument. A real fixture
returned `loaderLeaks: true, apiLeaks: true` for a matching hidden-entity bill.
Both callers now pass the scope; POST also carries it into the transactional
bill creator, preserving its vendor, target-entity and accrual checks.

A second reproduction showed duplicate prevention revealing the hidden bill's
number in its error text. The conflict query remains organization-wide so
hidden liabilities cannot be billed twice, but the service checks the
conflicting document's entity before returning identifying metadata. Hidden
conflicts receive the ordinary non-disclosing refusal.

All 59 focused checks passed (7,280.820458 ms, zero failures/skips), including
real GET, shared page/tool loader, POST, unrestricted-reader control, unchanged
bill count, and the existing remittance concurrency suite. Workspace
typechecks and changed-file lint passed. Evidence:
`audit-remittance-transport-scope-2026-09-07/before.log`, `overlap-before.log`,
`focused.log`, `typecheck.log`, and `lint.log`.

## Native depreciation evidence and typed candidate discovery — 2026-09-07

Normal uploads receive database-generated UUIDv7 IDs, but depreciation input
validation accepted only versions 1–5. Replacing the test's UUIDv4 file fixture
with the native generator reproduced `an attached evidence file is required`
for valid attached evidence. Validation now accepts the supported UUID range;
attachment, tenant, evidence-retention, posting and concurrency controls remain
exercised by the existing integration suite using native IDs.

The due-line query now selects and types only its four discovery/error-context
fields; posting still reloads authoritative fields under locks. This removes
one explicit `any` and unnecessary projected values. The enforced quality
limits are reduced to 380 explicit-any nodes and 712 lint warnings.

All 42 depreciation and CI-integrity checks passed (52,923.462042 ms, zero
failures/skips), engine typecheck passed, and full repository lint passed with
zero errors and exactly 712 warnings. Explicit-any verification passed at 380.
Evidence: `audit-depreciation-native-evidence-2026-09-07/before.log`,
`focused.log`, `typecheck.log`, `lint-full.log`, and `any.log`.

## ROE historical-source and current-header isolation — 2026-09-07

A transferred employee's new entity passed the ROE row guard while the real
record contained 240.0000 of the original employer's insurable earnings.
ROE authorization now requires current employee/profile-account visibility
and the original pay-run entities contributing to its earnings window.
The selected-employee file route uses this same boundary.

The engine exposes ownership inputs using the existing frequency-to-period
count declaration, across tax years. It also includes every source on the
final pay date because separation-payment blocks read that whole date.
Worksheet ties now order by pay date and stub ID, matching the ownership
selector. Older sources outside both windows do not block access.

All 64 focused checks passed (8,296.639042 ms, zero failures/skips), including
transfer denial, selected-file denial, profile-account isolation, cross-year
reads, a 13-period boundary, and a hidden final-date source outside that
13-period window. All 3,210 unit tests passed (120,438.487583 ms, no skips).
Workspace typechecks, changed-file lint and the locked-dependency production
build passed. Evidence: `audit-roe-source-scope-2026-09-07/before.log`,
`regression-before.log`, `focused-final.log`, `unit.log`, `typecheck.log`,
`lint.log`, and `build.log`.

## Form 941 source ownership and unassigned quarters — 2026-09-07

An account-only Form 941 row passed authorization for a visible EIN even when
its original pay-run document belonged to a hidden entity; the real worksheet
contained 100.0000 of that entity's Medicare wages. The shared filing guard now
checks original source documents for each requested EIN, quarter and tax year,
including voided-run ownership evidence needed by stored corrections. Missing
source evidence fails closed.

The row parser also rejected the registry's valid unassigned key (`:3`). It now
accepts empty-or-valid account IDs with quarters 1–4. An unassigned aggregate
requires root visibility even when mixed with visible assigned-account rows.
Population and stored-row guards share one implementation.

All 61 focused checks passed (10,073.954 ms, no failures/skips), covering hidden
sources, visible sources, year/quarter boundaries, mixed unassigned accounts,
empty/unrestricted scopes, malformed keys and voided history, plus annual,
ROE and remittance regressions. Web typecheck and changed-file lint passed.
Evidence: `audit-941-source-scope-2026-09-07/before.log`,
`regression-before.log`, `focused.log`, `typecheck.log`, and `lint.log`.

The full integration run on 79ff8918 completed with 2,426/2,428 passes, two
statement-fixture failures, no skips, and 1,431,923.857583 ms elapsed. Its receipt
balanced 2,031 leases/releases/resets, four bootstraps/teardowns/schema checks,
and zero active leases or leak detections. Investigation found that the prior
statement-fixture change used the ignored `subsidiary` key instead of the
shared parser's `sub` key. That correction is still required; this checkpoint
is not a passing full integration gate. Evidence:
`audit-payroll-remittance-history-scope-2026-09-07/full-integration.log`.

## Deterministic statement-fixture entity selection — 2026-09-07

A deliberately earlier-sorting unrelated tenant reproduces both shared-renderer
failures without running the whole suite. The fixture now uses
`REPORT_PARAM_KEYS.sub`, and directly asserts that `parseReportQuery` resolves
its subsidiary. The unrelated tenant remains in the fixture so this regression
cannot be hidden by an otherwise empty scratch database. Both tenants are
cleaned up even if an assertion fails.

All 25 statement/domain-boundary checks passed (9,129.298125 ms, zero
failures/skips), including screen, shared renderer, CSV/XLSX, drill-through,
invalid books and retired scenario-book history. Web typecheck and changed-file
lint passed. No production report behavior changed. Evidence:
`audit-statement-fixture-parameter-2026-09-07/before.log`, `focused.log`,
`typecheck.log`, and `lint.log`. A new full integration run is still required.

## Revenue-recognition posting snapshot — 2026-09-08

A controlled interleave changed an obligation's recognized account while a
recognition run waited for its lock. After the edit committed, the run still
credited 1,200.0000 to the old account: accounts, amounts, dimensions and posting
dates had been computed from an unlocked discovery read.

Discovery is now advisory. Each posting acquires the obligation and reloads
the shared typed projection, locking the schedule line and native schedule,
book, contract, rule and period records. Current scope, eligibility, period,
account and dimension checks precede journal writes. The subsidiary tree is
held during restriction validation. Zero-amount updates follow the same locked
path, and results report the amount actually claimed. Missing accounts retain
the skipped count and named refusal.

Seven controlled races cover obligation/rule account edits, amount changes,
zero-to-positive, positive-to-zero, forecast-only policy and missing accounts.
All 51 final recognition/cancellation checks passed (6,118.837 ms, no skips).
The broader unit gate passed 3,210/3,210 (111,764.889958 ms, no skips), workspace
typechecks and locked-dependency production build passed, and full lint passed
with zero errors and 711 warnings. Final engine typecheck passed after adding
the explicit missing-account outcome. The typed projection removes one more
explicit-any node; the enforced limits are now 379 explicit-any / 711 warnings.
Evidence: `audit-revenue-posting-snapshot-2026-09-07/before.log`,
`final-regressions.log`, `unit.log`, `typecheck.log`, `typecheck-final.log`,
`lint-full.log`, and `build.log`.

## Recognition failure isolation inside tenant transactions — 2026-09-08

Nested `db.transaction` calls deliberately join the caller's tenant transaction.
A caught recognition-line SQL failure therefore left that transaction aborted:
the summary query failed and unrelated caller changes were lost. A regression
injects a failure after the first journal leg and reproduces PostgreSQL 25P02.

Recognition now wraps each posting unit in an explicit savepoint. A failed
draft and all its lines roll back together; subsequent valid lines and the
caller's unrelated writes can commit. The shared helper requires an already
open transaction and uses unique names so nested savepoints remain independent.
Ordinary transaction participation is unchanged.

All 61 focused recognition, cancellation, tenant-context and RLS checks passed
(20,713.468084 ms, no skips). Tests verify partial-journal removal, continuation,
caller-write preservation, and independently caught nested application errors.
All 3,210 unit tests passed (103,226.99225 ms, no skips), workspace typechecks
and changed-file lint passed, and the production build with locked dependencies
passed. Evidence:
`audit-revenue-ambient-rollback-2026-09-08/regression-before.log`,
`focused-final.log`, `unit.log`, `typecheck-final.log`, `lint-final.log`, and
`build.log`.

## Depreciation failure isolation inside tenant transactions — 2026-09-08

A controlled failure on the second depreciation journal leg reproduced the
same ambient-transaction defect independently: the caught error poisoned later
asset postings and the final status update (PostgreSQL 25P02), rolling back the
caller's unrelated changes. Each depreciation posting now uses the shared
explicit savepoint so partial journals are removed before continuing.

The regression verifies one failed asset remains in service, a valid asset
posts and becomes fully depreciated, only its balanced two-line journal remains,
and the caller's earlier update commits. All 55 focused depreciation and
savepoint checks passed (7,748.210041 ms, no failures/skips); engine typecheck
and changed-file lint passed. Evidence:
`audit-depreciation-ambient-rollback-2026-09-08/before.log`, `focused.log`,
`typecheck.log`, and `lint.log`.

## FX reversal failure isolation — 2026-09-08

A real two-entity fixture rejects the first entity's mandatory FX reversal after
its adjustment has posted. The caught SQL error previously aborted the ambient
tenant transaction and the next entity's idempotency query failed with 25P02.
The adjustment/reversal pair now shares an explicit savepoint. Failure removes
both parts and leaves the caller transaction usable for subsequent entities.

All 20 focused FX and ambient-rollback checks passed (4,978.79925 ms, no skips),
including exact adjustment/reversal retention for the successful entity and
preservation of the caller's earlier write. Engine typecheck and changed-file
lint passed. Evidence: `audit-fx-ambient-rollback-2026-09-08/before.log`,
`focused.log`, `typecheck.log`, and `lint.log`.

## Full integration checkpoint at 66327181 — 2026-09-08

The frozen full integration run passed 2,434/2,434 tests, with zero failures or
skips, in 1,284,080.113708 ms. The fixture receipt balanced 2,042 leases,
releases and resets, four bootstraps/teardowns/schema verifications, and zero
active leases or leak detections. Both previously failing statement fixtures
passed. This checkpoint includes the earlier payroll source-ownership fixes
and canonical statement parameter correction; subsequent recognition and
savepoint changes have the focused checks recorded above. Evidence:
`audit-statement-fixture-parameter-2026-09-07/full-integration.log`.

## Lease commencement and payment concurrency — 2026-09-08

Controlled overlapping requests exposed missing authoritative claims in both
lease workflows. Finance and short-term commencement retries collided on
`lease_agreement_schedule_lease_seq`; payment retries collided on
`journal_entries_org_number`. Sequential retry tests did not exercise either
race.

Commencement now locks and reads the lease within its transaction before checking
status or measuring it. Scheduled posting locks the lease, reloads and claims
the current due line, and skips work another runner completed. Discovery carries
only IDs; accounts, amounts and dates come from the locked records.

All 20 lease and present-value checks passed (2,600.916166 ms, no skips), including
both concurrent commencement models and payment/amortization idempotency.
Workspace typechecks, changed-file lint and the locked-dependency production
build passed. The full unit gate passed 3,210/3,210 tests (117,550.331875 ms,
no skips), covering the latest recognition, depreciation and FX changes too.
Evidence: `audit-lease-concurrent-posting-2026-09-08/before.log`,
`focused-final.log`, `typecheck.log`, `lint.log`, `unit.log`, and `build.log`.

## Lease journal legal-entity controls — 2026-09-08

A real commencement posted 2,970.2481 to an account restricted to a different
legal entity. Both commencement and scheduled payments also accepted a location
owned by another entity. An independent pre-fix run posted into an inactive
branch. The database guards cover account activity, summary status and currency,
but these journal paths omitted the shared subsidiary policy.

Lease posting now uses `validateSubsidiaryRestrictions` for accounts, native
dimensions and entity activity. It holds the subsidiary hierarchy, referenced
accounts/dimensions and posting context while validating and writing. Book and
period context is read through the posting transaction. Refusals roll back the
whole unit; legitimate descendant access remains supported.

All 37 focused lease, scope and posting-policy checks passed (5,893.236708 ms,
no failures/skips). They cover commencement/payment refusals, successful retry
after correction, allowed descendant accounts and a concurrent account-scope
edit. The inactive-entity fixture uses a branch: its initial root variant was
correctly rejected by the existing tree guard and was corrected before the
final run. Workspace typechecks and locked-dependency production build passed.
Full lint remains at 711 warnings/zero errors; explicit-any remains 379. The
locked production dependency audit reported zero vulnerabilities, and the
container security check passed.

Evidence: `audit-lease-posting-scope-2026-09-08/before.log`,
`inactive-before.log`, `regression-before.log`, `focused-final.log`,
`typecheck.log`, `lint-full.log`, `explicit-any.log`, `build.log`,
`dependencies.json`, and `container-security.log`.

## Payroll payment retains historical liability ownership — 2026-09-08

A root-only payer was correctly denied a mixed-entity run until the branch
employee transferred to the root. The same call then paid all 250, including
150 still owed by the hidden branch. Both the refusal guard and payable-line
query used the employee's current subsidiary instead of the posted liability.

Both now use `journal_lines.subsidiary_id`. Regression coverage verifies that a
transfer cannot authorize the hidden liability, while an employee moving away
does not revoke the original employer's ability to pay its own posted liability.
The unrestricted mixed-entity payment still balances each legal entity.

All nine focused remittance, payment and engine-scope checks passed
(4,148.945292 ms, no failures/skips); engine typecheck and changed-file lint
passed. Evidence: `audit-payroll-payment-history-scope-2026-09-08/before.log`,
`focused.log`, `typecheck.log`, and `lint.log`.

## Payroll payment HTTP scope propagation — 2026-09-08

The engine's historical-liability guard was bypassed by the pay-run action API:
the route checked only the document header and omitted `allowedSubsidiaryIds`
when recording payment. A historical branch-liability journal was refused by
the restricted direct service call, but the same caller's real HTTP action
returned 200 and paid it. The route now passes its resolved scope to the engine.

The integration regression uses the real route and financial services, replacing
only the authenticated feature gate. It verifies the restricted response is 422
with the existing non-disclosing error, the run remains unpaid, and an
unrestricted caller can still pay successfully. All 18 focused transport,
payment and scope checks passed (8,409.743958 ms, no failures/skips); web
typecheck and changed-file lint passed. Evidence:
`audit-payroll-payment-transport-scope-2026-09-08/before.log`, `focused.log`,
`typecheck.log`, and `lint.log`.

## Payroll settlement account and entity controls — 2026-09-08

A native calculated/committed/posted payroll run could be paid from a bank
account restricted to another legal entity. The payment service checked active
bank type but omitted the shared account-ownership policy.

The settlement now holds the subsidiary hierarchy, bank, intercompany policy
and all selected accounts while validating every new journal leg through the
shared subsidiary policy. Draft-journal creation follows validation. The bank
type/activity check also holds its row lock through posting.

All 14 focused payment, API and posting-policy checks passed (8,955.9975 ms,
no failures/skips); workspace typechecks and changed-file lint passed. Coverage
includes a forbidden bank, a forbidden intercompany account, an inactive
settled branch, unchanged unpaid status/no draft fragments after refusals, and
successful balanced payment after correction. Evidence:
`audit-payroll-payment-bank-scope-2026-09-08/before.log`, `focused-final.log`,
`typecheck.log`, and `lint.log`.

## Project GL requires the authoritative posting book — 2026-09-08

The project journal helper selected any active book, preferring the primary
but silently falling back to the next code. It also ignored `posts_gl`. Three
real regressions posted into an alternate posting book, an alternate forecast
book, and a primary book with posting disabled.

The helper now requires `is_primary`, `is_active` and `posts_gl`, and holds the
book through the transaction. Missing eligibility produces a named refusal
with no draft journal. Re-enabling the primary posts there even when an
alternate sorts first. All ten focused GL, concurrency and recognition checks
passed (3,633.589083 ms, no failures/skips); engine typecheck and changed-file
lint passed. Evidence: `audit-project-gl-book-policy-2026-09-08/before.log`,
`focused.log`, `typecheck.log`, and `lint.log`.

## Project journal account and dimension controls — 2026-09-08

The project journal helper posted both a branch-restricted account and a
branch-owned project dimension into the root entity. It now validates the
complete forward posting through the shared subsidiary policy while holding
the hierarchy, accounts and referenced projects. Controlled historical reversals
retain their existing exact-source behavior. The insert result is now typed;
the enforced limits drop to 378 explicit-any nodes and 710 lint warnings.

All 16 focused project/GL checks passed (5,439.017917 ms, no failures/skips),
including refusal without draft fragments and valid descendant use. Workspace
typechecks, the locked-dependency production build and full lint passed (zero
errors, 710 warnings). All 3,210 unit tests passed (1,310,529.163833 ms, no skips),
including the latest payroll changes. Evidence:
`audit-project-gl-entity-policy-2026-09-08/before.log`, `focused.log`,
`typecheck.log`, `explicit-any.log`, `unit.log`, `build.log`, and `lint-full.log`.

## Full integration checkpoint at ce524573 — 2026-09-08

The frozen full suite passed 2,457/2,457 tests, zero failures/skips, in
1,241,408.376792 ms. Its receipt balanced 2,065 leases/releases/resets, four
bootstraps/teardowns/schema verifications, and zero active leases or leak
detections. This includes the recognition posting snapshot, all three financial
batch savepoints, lease concurrency and lease entity controls. Later payroll
and project fixes have the focused and unit evidence recorded above. Evidence:
`audit-lease-posting-scope-2026-09-08/full-integration.log`.

## Projects parent gate at time posting services — 2026-09-08

With Projects disabled and time tracking enabled, both native labor costing
and overhead application still posted journals and stamped approved time.
The services now recheck the authoritative Projects gate while holding the
organization settings row through posting. The existing feature registry and
dependency resolver were extracted into a pure engine module and re-exported
by the web feature module, preserving one definition and existing defaults.

Four real database cases cover each service with Projects already disabled
and with a disable committing while posting waits. Disabled posting preserves
time and project data, re-enabling posts once, and controlled historical
reversals remain available after disabling again. All 23 focused checks passed
(13,831.214458 ms, no failures/skips). All 3,210 unit tests passed
(134,033.133542 ms, no skips); workspace typechecks and the locked-dependency
production build passed. Full lint has zero errors and 709 warnings; removing
an unused import lowers the enforced warning ceiling accordingly. Evidence:
`audit-project-time-feature-gate-2026-09-08/before.log`, `overhead-before.log`,
`focused.log`, `typecheck.log`, `unit.log`, `build.log`, and `lint-full.log`.

## Payment-provider settlement posting policy — 2026-09-08

Four real database regressions showed that a settlement could post to an
account restricted to a different entity, an inactive subsidiary, an inactive
primary book, or a primary book with GL posting disabled. The forward service
now requires an active primary posting book, holds the organization policy,
subsidiary hierarchy and selected accounts, and uses the shared entity
restriction validator before inserting a journal. Currency is read from the
locked hierarchy. Policy refusals retain the PSP domain error contract.

All 37 focused settlement, subsidiary and HTTP boundary checks passed
(6,073.205667 ms, zero failures/skips); engine typecheck and changed-file lint
passed. Tests verify draft/source preservation, no journal fragments, valid
parent-to-child account use, retry idempotency, and an account restriction
committing while posting waits. Existing exact-source reversal tests pass.
Evidence: `audit-psp-posting-policy-2026-09-08/before.log`, `focused-final.log`,
`typecheck-final.log`, and `lint.log`. The separately running full integration
checkpoint is frozen at e52f1367 and therefore excludes this later change.

## Projects parent gate at revenue synchronization — 2026-09-08

A real disabled-Projects invocation created a $1,000 project revenue contract
and obligation at 25% completion while revenue recognition remained enabled.
The transactional sync now checks the shared Projects feature registry while
holding the organization settings row, before creating or updating any
contract, obligation, or schedule. Independent revenue recognition remains
available under its own gate.

The regression verifies no contract creation while disabled, normal creation
after enabling, byte-equivalent contract/obligation/schedule evidence while
disabled again, and resumption using the same records at the changed completion
percentage. All 53 focused project, recognition and HTTP boundary checks passed
(6,078.446917 ms, no failures/skips); engine typecheck and changed-file lint
passed. Evidence: `audit-project-revenue-feature-gate-2026-09-08/before.log`,
`focused.log`, `typecheck.log`, and `lint.log`.

## Concurrent project revenue synchronization — 2026-09-08

Two simultaneous synchronizations of one fixed-price project both succeeded
and created two contracts and two obligations. The regression holds contract
insertion until both transactions reach the race; it observed `{contracts: 2,
obligations: 2}` before the fix. Synchronization now locks qualifying project
rows in deterministic code/id order before checking or creating the revenue
records. Both callers converge on the same contract and obligation.

All 54 focused project, recognition and HTTP boundary checks passed
(7,007.105625 ms, no failures/skips); engine typecheck and changed-file lint
passed. Evidence: `audit-project-revenue-concurrency-2026-09-08/before.log`,
`focused.log`, `typecheck.log`, and `lint.log`. This prevents new duplicates in
this service; no production data was inspected or rewritten.

## Fixed-asset forward posting policy — 2026-09-08

Ten real regressions demonstrated that disposal and remeasurement both
accepted restricted adjustment accounts, restricted locations, inactive
subsidiaries, inactive primary books and primary books with GL posting off.
Both forward operations now require an active primary posting book and hold
the subsidiary hierarchy before reading functional currency. A shared lifecycle
helper holds all used accounts and dimensions and applies the native entity
restriction validator before journal creation. Controlled historical reversals
retain their exact-source behavior.

All 47 focused lifecycle, date, reversal and arithmetic checks passed
(10,530.574208 ms, no failures/skips), including unchanged asset status and no
journal/event fragments after refusal, then successful posting after policy
correction. All 3,210 unit tests passed (146,402.922125 ms, no skips), workspace
typechecks and the locked-dependency production build passed, and full lint
passed with zero errors and 709 warnings. These broad checks include the
preceding settlement and project revenue fixes. Evidence:
`audit-asset-lifecycle-posting-policy-2026-09-08/before.log`, `focused.log`,
`unit.log`, `typecheck-full.log`, `build.log`, and `lint-full.log`.

## Property security-deposit posting policy — 2026-09-08

Five real receipt regressions posted with a bank or location restricted to a
different entity, an inactive property subsidiary, an inactive primary book,
or a primary book with GL posting disabled. Forward deposit posting now locks
the authoritative feature setting, hierarchy, property context, eligible
primary book, selected accounts and location. Liability/bank/offset type checks
read locked account rows, and the native subsidiary validator runs before
journal/subledger creation. Historical deposit reversals retain their existing
source-based controls.

All 29 focused deposit, balance-concurrency, property hardening and arithmetic
checks passed (9,576.8475 ms, no failures/skips); engine typecheck and
changed-file lint passed. Refusals leave no journal or deposit transaction, and
correcting policy permits the preserved receipt. Evidence:
`audit-property-deposit-posting-policy-2026-09-08/before.log`, `focused.log`,
`typecheck.log`, and `lint.log`.

## Lease primary-book eligibility — 2026-09-08

Lease commencement and scheduled payment each posted with either primary-book
activation or GL posting disabled. The existing locked book lookup now requires
both flags. Four database regressions verify named refusal, unchanged lease
status and payment claims, no new journal fragments, and successful resumption
after restoring book eligibility. All 33 lease integration and measurement
checks passed (5,150.947917 ms, no failures/skips); engine typecheck and
changed-file lint passed. Evidence: `audit-lease-book-policy-2026-09-08/before.log`,
`focused-final.log`, `typecheck-final.log`, and `lint.log`.

## Income-tax provision posting policy — 2026-09-08

Provision source fingerprints did not prevent posting to a restricted expense
account, an inactive entity, an inactive primary book or a primary book with
GL posting disabled. Each case was reproduced against the real database. The
posting service now holds organization/entity policy, requires an active
primary posting book, locks every account in the proposed replacement, and
validates all entity legs before reversing or superseding any earlier run.

Eight policy cases cover both an initial posting and replacement of a posted
run. Refusals retain the draft, leave the prior run and its journal posted,
and create no additional journals. Correcting policy permits the same draft
to post. All 37 focused provision and computation checks passed
(6,397.600167 ms, no failures/skips); engine typecheck and changed-file lint
passed. Evidence: `audit-tax-provision-posting-policy-2026-09-08/before.log`,
`focused-final.log`, `typecheck-final.log`, and `lint-final.log`.

## Straight-line property rent snapshot and posting policy — 2026-09-08

Six real policy regressions posted rent accruals with restricted accounts or
locations, an inactive subsidiary, an inactive/non-posting primary book, or
USD property amounts treated as CAD functional amounts at rate one. A separate
controlled race changed first-year rent from $10,000 to $20,000 while the
service waited on the lease. It still posted the old +$2,000 accrual instead
of the corrected −$6,000.

The service now discovers IDs, then locks feature/account configuration, the
hierarchy and lease before reading property terms and the full charge stream.
Those inputs, current accrual and new posting share one transaction. It also
requires an eligible primary posting book, validates account/location/entity
policy, and refuses currency translation without supporting evidence.

All 31 focused levelling, deposit and property checks passed (8,021.216 ms,
no failures/skips), including the controlled rent edit and repeat no-op. All
3,210 unit tests passed (135,414.272083 ms, no skips); workspace typechecks,
locked-dependency production build and full lint passed (zero errors, 709
warnings). The explicit-any guard remains at 378. Evidence:
`audit-property-levelling-posting-policy-2026-09-08/before.log`,
`concurrency-before.log`, `focused-final.log`, `unit.log`, `typecheck-full.log`,
`build.log`, `lint-full.log`, and `explicit-any.log`.

## FX revaluation posting policy — 2026-09-08

Four real revaluation regressions posted adjustment/reversal pairs with a
gain/loss account restricted to another entity, an inactive subsidiary, an
inactive primary book or a primary book with GL posting disabled. The existing
transaction/savepoint boundary now validates the locked book, hierarchy,
functional currency and all used account restrictions before inserting either
entry. Named refusals remain per-entity problems; controlled pair rollback and
idempotency behavior are preserved.

All 21 focused FX policy, pair-rollback, revaluation and arithmetic checks
passed (5,022.443625 ms, no failures/skips); engine typecheck and changed-file
lint passed. Tests verify the original exposure journal is the only journal
after refusal, correction permits one pair, and retry posts nothing. Evidence:
`audit-fx-posting-policy-2026-09-08/before.log`, `focused.log`, `typecheck.log`,
and `lint.log`.

## Full integration checkpoint at e52f1367 — 2026-09-08

The frozen full suite passed 2,467/2,467 tests, zero failures/skips, in
1,419,442.964792 ms. Its receipt balanced 2,075 leases/releases/resets, four
bootstraps/teardowns/schema verifications, and zero active leases or detected
leaks. It covers the earlier payroll and project fixes through the Projects
time-posting gate. The newer settlement, project-revenue, asset, property,
lease-book, tax-provision and FX controls have the targeted/broad evidence
recorded above; a new full suite is frozen at 0083b76c to cover them together.
Evidence: `audit-project-time-feature-gate-2026-09-08/full-integration.log`.

## Consolidation posting-book policy — 2026-09-08

Ownership consolidation posted with primary-book GL posting disabled, and
auto-elimination posted with either primary activation or GL posting disabled.
Both posting phases now hold an active primary posting book. Four real cases
verify refusal leaves source journals intact, creates no successful/running
generation, and posts normally after correction. Existing failed-attempt
ownership evidence is intentionally retained; the initial test incorrectly
counted it as a successful generation and was corrected.

All 24 consolidation and close-readiness checks passed (7,448.570208 ms, no
failures/skips); engine typecheck and changed-file lint passed. Evidence:
`audit-consolidation-book-policy-2026-09-08/before.log`, `focused.log`,
`typecheck.log`, and `lint.log`. The running full suite remains frozen at
0083b76c and excludes this newer consolidation change.

## Inventory book policy and NRV caller-transaction rollback — 2026-09-08

Four real receipt/issue cases changed stock and posted with primary-book
activation or GL posting disabled. Primary-book resolution now requires both
flags and holds the book in the stock transaction; receipt, issue and assembly
reads were moved inside that boundary. The shared inventory journal writer
also checks the requested book's eligibility. A fifth regression verifies a
receipt waits for a book edit, then refuses without journals, movements or
cost layers.

Failure testing also exposed an existing NRV atomicity gap: a write-down with
no accounting period changed ten $5 units to $4 before throwing, and a caller
catching the error could retain $40 of stock against $50 in the GL. The new
book refusal reached the same gap in both write-down and recovery. Before
shipping the book guard, both NRV operations were wrapped in the existing
transaction-savepoint helper. Three caller-transaction regressions now preserve
layers, journals, write-down/recovery evidence and the caller's prior write.

All 32 combined inventory/NRV checks passed (10,454.983125 ms, no failures/skips),
as did final workspace typechecks and changed-file lint. Before the final NRV
savepoint addition, all 3,210 unit tests passed (154,804.905667 ms), the locked
production build passed, and full lint passed with zero errors/709 warnings.
Evidence: `audit-inventory-book-policy-2026-09-08/before.log`,
`focused-final.log`, `unit.log`, `build.log`, `lint-full.log`; and
`audit-nrv-ambient-rollback-2026-09-08/before.log`, `before-expanded.log`,
`focused.log`, `typecheck.log`, and `lint.log`.

### Payroll settlement source-book eligibility (2026-09-08)

Confirmed on `4b37f875`: recording payment of a posted payroll run still posted a
new settlement journal and marked the run paid when its source accounting book
was inactive or had `posts_gl=false`. Both real PostgreSQL refusal regressions
failed with “Missing expected rejection”; an eligible non-primary source book
was already usable.

`recordPayRunPayment` now locks the original accounting book with `FOR SHARE`
and requires it to remain active and permit GL posting before any settlement
writes. It deliberately retains the source book when another book becomes
primary. No historical journal is changed.

Validation: 12/12 focused payroll tests passed (5,869.580167 ms), covering both
refusals, no payment/journal/application fragments, restored eligibility,
primary-book replacement, mixed-entity settlement, scope and remittances.
Engine typecheck and changed-file ESLint passed. Private before/after evidence:
`audit-payroll-payment-book-policy-2026-09-08`. The full integration checkpoint
running at `0083b76c` predates this fix and is not validation of this change.

### NRV valuation legal-entity policy (2026-09-08)

Confirmed on `c86fd5de`: both inventory NRV write-downs and IFRS recoveries
posted through an asset account restricted to another legal entity, and also
posted for an inactive stock-owning subsidiary. Four corrected real PostgreSQL
regressions failed with “Missing expected rejection.” An initial inactive-root
fixture was invalid (the database correctly prohibits that state); the evidence
uses a valid child owner instead.

Both operations now hold the subsidiary hierarchy through commit and validate
their accounts under shared row locks using the existing subsidiary validator.
Recovery resolves currency and posting context inside the transaction after
taking those locks. The existing operation savepoint preserves all owners'
layers, journals and recovery headroom when a caller catches a refusal,
including when a later owner fails after an earlier owner's work began.

Validation: 24/24 focused inventory/NRV checks passed (7,918.20925 ms), including
five new policy cases, mixed-owner atomic refusal, restored-policy success,
source-cost recovery ceilings, exact fractional valuation and disabled-book
controls. Workspace typechecks, changed-file ESLint and `git diff --check`
passed. Private evidence: `audit-nrv-posting-policy-2026-09-08`. The running
`0083b76c` full integration archive predates this fix.

### Depreciation status reconciliation respects caller scope (2026-09-08)

Confirmed on `c4432e14`: after the journal loop correctly filtered out hidden
assets, its final status reconciliation updated every eligible asset in the
organization. A caller with an empty scope or access to another subsidiary
could change a hidden child's lagging `in_service` status to
`fully_depreciated`, while the run reported zero postings.

The final UPDATE now carries the same subsidiary restriction, using the shared
UUID-array binder. The two real database regressions use a valid fully-posted
schedule with a lagging legacy/imported status; both failed before the fix.
They also verify that the owning subsidiary's authorized caller can reconcile
the status without duplicating the journal.

Validation: 8/8 focused depreciation checks passed (4,754.836708 ms), engine
typecheck and changed-file ESLint passed. Private evidence:
`audit-depreciation-status-scope-2026-09-08`.

Separate checkpoint at `c4432e14`, before this scope fix: 3,210/3,210 unit tests
passed with no skips (101,993.79625 ms), and the production web build passed
using the locked dependency installation. Those runs include the payroll-book
and NRV-policy fixes. Logs: `audit-nrv-posting-policy-2026-09-08`.

### Percent-complete editing serializes with Projects disable (2026-09-08)

Confirmed on `c4432e14` through the real route and PostgreSQL, with only the
authentication boundary supplied by the fixture: a request passed its initial
Projects check, changed the override, then waited behind a concurrent disable
in the revenue-sync service. After disable committed, the service correctly did
nothing, but the route still committed the override and returned HTTP 200.

The route now checks and holds the authoritative Projects row lock inside the
transaction before updating the project. A disable that wins returns HTTP 404
without changing the override or audit columns; a write that wins retains the
feature lock through override and schedule synchronization.

Validation: three real database checks passed (3,646.579875 ms): the route race,
disabled revenue-sync preservation, and concurrent sync uniqueness. The two
existing route unit checks also passed independently with database mode off.
Workspace typechecks, changed-file ESLint and whitespace validation passed.
The race regression also re-enables Projects and verifies the 75% update.
Private evidence: `audit-project-percent-feature-race-2026-09-08`.

### NRV valuation obeys the Inventory feature (2026-09-08)

Confirmed on `fff4c2ac`: inventory write-down and IFRS recovery services still
changed layer values and posted journals after `features.inventory=false`.
Both real database refusal tests failed before the fix.

Both services now acquire and check the authoritative Inventory feature inside
their operation transaction before valuation work, holding the organization
row through commit. Reporting-framework policy is read under that same lock.
Tests preserve existing valuation evidence while disabled and confirm that
re-enabling resumes the operation. Recovery here is a new valuation movement,
with source-cost ceilings; this does not alter historical journal reversals.

Validation: 21/21 NRV checks passed (7,846.197458 ms), workspace typechecks and
changed-file ESLint passed. Private evidence:
`audit-nrv-feature-gate-2026-09-08`.

### Full integration checkpoint at 0083b76c (2026-09-08)

The frozen archive passed **2,512/2,512 integration checks**, zero failures and
zero skips, in 1,421,806.883791 ms. Fixture lifecycle evidence: four bootstraps,
four teardowns, four schema-wide verifications, 2,120 leases/releases/resets,
zero active leases and zero leak detections. This includes the PSP, project
revenue, asset lifecycle, property deposit, lease, tax provision, rent levelling
and FX fixes through `0083b76c`. It predates consolidation book validation,
inventory book/NRV rollback, and the subsequent payroll/NRV/depreciation/Projects
fixes. It is not a clean run of the newer commits.

Full log: `audit-fx-posting-policy-2026-09-08/full-integration.log`.

### Payroll adjustment and GL-preview employee scope (2026-09-08)

Confirmed on `71a3c2d1`: a root-scoped caller could add/delete adjustments,
include/exclude an employee, apply bulk adjustments or set the roster for a
child-owned employee through a root-owned run. GL preview also exposed the
hidden employee's name and net pay. Seven real route/database regressions
returned HTTP 200 before the fix.

All adjustment dispatches now pass caller scope to the shared mutation service.
It checks the run owner, locks the target employee and the complete calculated
stub population, and refuses if any are inaccessible. Checking the whole
snapshot is necessary because a successful edit invalidates every stub.
Ownership locks prevent an employee transfer from bypassing the decision.
GL preview now receives the existing engine's caller scope argument.

Validation: 13/13 focused payroll tests passed (11,027.4185 ms), plus the existing
end-to-end payroll surface scope test (7,141.523042 ms). Coverage includes all
seven route refusals, unrestricted success, direct authorized writes, preserving
hidden stubs when editing a visible employee, and concurrent employee transfer.
Workspace typechecks, changed-file ESLint, 3,210/3,210 unit tests with no skips
(136,349.848 ms), and the locked-dependency production build passed.
Private evidence: `audit-payroll-run-action-scope-2026-09-08`.

A separate run-detail GET disclosure was reproduced during this validation and
is under remediation; this adjustment/preview fix does not close that finding.
The full integration archive currently running at `71a3c2d1` predates these
adjustment/preview changes.

### Payroll run detail protects the entire employee population (2026-09-08)

The separate GET disclosure noted above is now fixed. A real request for a
visible run containing an inaccessible employee returned the employee's name,
wages, net pay, statutory factors and component lines before the fix.

Detail reads now hold shared locks on the run and document, authorize all
employees referenced by stubs or adjustments under shared ownership locks, and
return the complete response within that transaction. A partially visible run
returns the same HTTP 404 body as a missing run. This also protects an
adjustment-only draft after its calculated stubs were invalidated.

Validation: 11/11 payroll route checks passed (7,228.001541 ms), including hidden
stubs, hidden adjustments, a concurrent employee transfer, authorized scoped
reads and unrestricted reads. Existing mutation and payroll surface scope
checks remain green. Workspace typechecks, changed-file ESLint and whitespace
validation passed. Private evidence: `audit-payroll-run-read-scope-2026-09-08`.
The 3,210-test unit/build checkpoint in the previous section predates this GET
change; the running `71a3c2d1` full archive predates both payroll scope commits.

### Payroll summaries and wizard share whole-population visibility (2026-09-08)

Five further real database regressions failed on `ba29b8f1`: the collection API,
shared payroll record list, assistant list/detail, and wizard page all exposed
a root-owned run containing an inaccessible child-owned employee. The wizard
returned employee data in its server-rendered props even after the detail API
had been corrected.

The existing payroll scope primitives now live in the dependency-light
`payroll-scope.ts`, with their old exports preserved. A shared whole-population
SQL predicate excludes any run containing inaccessible stubs or adjustments
from summary readers. The wizard holds its run/document and employee ownership
locks through response assembly, checks the same population policy, and passes
scope to its roster, prior-pay comparison and engine-owned status loaders.
Its existing shared UI composition is unchanged.

Validation: 20/20 focused payroll checks passed (14,829.362459 ms), including all
five corrected surfaces and both unrestricted and fully authorized multi-entity
reads. Workspace typechecks, changed-file ESLint (no errors; existing warnings),
whitespace validation, 3,210/3,210 unit tests with no skips (121,444.910042 ms),
and the locked-dependency production build passed. Private evidence:
`audit-payroll-run-population-scope-2026-09-08`.
The production dependency audit also reported zero vulnerabilities from the
locked installation (`audit-payroll-run-read-scope-2026-09-08/dependencies.log`).

Separately confirmed during this validation: calculate/dry-run/commit still
omit caller scope at dispatch. Their remediation must refuse an inaccessible
whole population; forwarding a filter alone risks silently calculating a
partial run. This finding remains under active remediation.

### Payroll calculation and commit authorize the complete population (2026-09-08)

Real route regressions reproduced calculation, dry-run, and commit returning
hidden employee payroll when the caller could see only the run's header entity.
Direct calculation with scope also silently filtered the roster before replacing
the entire run. Both existing snapshots and fresh rosters reproduced the defect.

Dispatch now carries caller scope through all three operations and freshness
checks. Calculation authorizes the complete selected roster and existing evidence
before component provisioning or payroll writes. Commit checks the complete
population before projecting ledger lines. A shared locked ownership guard also
serves adjustments, detail reads, and the wizard. Concurrent employee transfers
refuse without changing payroll evidence; calculation retains repeatable-read
isolation and can refuse with PostgreSQL serialization failure.

Validation: 139/139 payroll integration checks passed with no skips
(151,080.298584 ms), including hidden existing/fresh populations, authorized
multi-entity calculation/commit, route dispatch, and real ownership races.
Workspace typechecks, changed-file lint (zero errors; four existing warnings),
3,210/3,210 unit tests (131,580.455084 ms), and the locked production build passed.
Evidence: `audit-payroll-calculation-commit-scope-2026-09-08`.

The independent frozen `71a3c2d1` repository integration checkpoint also passed:
2,537/2,537 tests, no skips (1,491,607.924292 ms), 2,145 balanced fixture
leases/releases/resets, zero active leases or leaks. That checkpoint predates
the subsequent payroll scope changes; their coverage is stated separately above.

A separate real database proof confirmed that dry-run inside an ambient
transaction replaces persistent pay stubs because its rollback signal is caught
without a nested savepoint. This remains under active remediation; passing scope
checks do not resolve transaction rollback semantics.

### Payroll previews and refused commits preserve ambient transactions (2026-09-08)

Two preview regressions proved that dry-run and committed-run simulation replaced
real stubs inside `withOrgTransaction`. Standalone previews already rolled back;
the ambient path joined its caller without a savepoint, then swallowed the rollback
signal. A separate real lock interleaving reached commit's projection replacement,
changed configuration, and triggered its late freshness refusal. Catching that
refusal inside the caller left projection rows, liability stamps, and time claims.

Calculation and commit now use the existing transaction savepoint helper. Preview
signals and late errors restore operation-owned writes before reaching the caller,
while earlier caller work survives. Calculation retains repeatable-read isolation.
Regressions compare complete payroll evidence, including record IDs and audit
timestamps, and prove successful calculation/commit still persist afterward.

Validation: 144/144 payroll integration checks (100,958.910375 ms), 61/61 additional
legacy payroll/control/entitlement checks (5,673.532833 ms), 3,210/3,210 unit tests
(108,905.389542 ms), workspace typechecks, changed-file lint (zero errors, two
existing warnings), whitespace validation, and the locked production build passed.
No tests were skipped. Evidence: `audit-payroll-dryrun-ambient-2026-09-08`.

The creation page's employee and schedule pickers separately reproduce subsidiary
privacy leaks in server-rendered client props. Those are under active remediation;
this transaction change does not resolve them.

### Payroll creation pickers restrict server-rendered metadata (2026-09-08)

Two real page regressions confirmed a root-restricted payroll actor received a
child entity's schedule metadata and an employee's name, identity, schedule, and
termination date in `NewRunButton` props. Filtering the eventual run list did not
protect these separately assembled creation options.

Schedule options now apply the shared payroll subsidiary predicate to their
effective owner, resolving organization-wide schedules to the active root exactly
as creation does. Final-pay candidates require both employee visibility and a
schedule offered to the caller. Filtering happens before client props are built;
the existing shared list, page layout, and creation controls remain the composition.

Validation: 8/8 real database page/API/summary checks passed (7,156.2475 ms),
including root-only, child-only, empty, combined, and unrestricted picker scopes.
Workspace typechecks, changed-file lint without warnings, whitespace validation,
and the locked production build passed. Evidence:
`audit-payroll-create-picker-scope-2026-09-08`.
The full integration archive running at `66be48a8` includes the payroll transaction
and preceding scope fixes, but predates this page change.

### Inventory write services enforce the authoritative feature gate (2026-09-08)

Seven real database proofs reproduced new stock/accounting activity after
`settings.features.inventory` was explicitly disabled: receipt, issue, adjustment,
transfer, assembly build, transfer-order creation, and landed-cost capitalization.
The direct services did not enforce the feature checked by their HTTP callers.

New movement and document operations now hold the shared organization feature
lock before their position/profile locks and writes. Transfer shipment and receipt
take that lock before entering their delegated movement path. Transfer numbering
was moved inside the guarded transaction so a refused creation consumes no number.
Registry defaults remain authoritative, and controlled reversal of historical
movements remains available after disabling the feature.

Validation: 110/110 inventory/costing/NRV/ownership/transfer/reversal checks passed,
with no skips (28,489.598416 ms). New regressions cover nine write entry points,
caught refusals inside caller transactions, unchanged numbering and financial
evidence, re-enablement, an actual concurrent feature disable, and historical
reversal. Workspace typechecks, changed-file lint without warnings, and whitespace
checks passed. Evidence: `audit-inventory-movement-feature-2026-09-08`.
The running full `66be48a8` archive predates these Inventory changes.
