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
