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
