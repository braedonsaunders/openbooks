# Payment access and concurrent editing

The September 2026 payment review found authorization differences between the
server-rendered workspaces and their APIs, an incorrect allocation lookup, and
two concurrent editing defects. This is a reviewed subset of the payment
domain, not an exhaustive audit or a production-readiness certification.

## Access boundaries

Payment and collection run lists, counts, source pickers, preselected documents
and drawers now use the caller's subsidiary scope. A shared predicate covers
the run header and every retained source item, including excluded items shown
as historical evidence. Restricted users cannot open a run whose source
document is missing or outside their scope. An empty scope returns no runs.
Bank profile and party choices retain explicitly shared records while excluding
records assigned exclusively to another subsidiary.

The payment-runs listing API returns outbound runs under `ap.pay`; inbound
collections require `ar.pay`. Direct payment drawers and initial allocation
choices apply subsidiary authorization too. A shared party identity no longer
allows its open items or automatic suggestions to expose another subsidiary's
transactions.

The allocation authorization guard now resolves `openLineId` against
`journal_lines`, the actual open-item ledger. It previously queried
`document_lines`, rejecting legitimate allocations for restricted users.
Draft allocation validation also enforces the payment's legal entity before
posting, consistent with the existing settlement invariant.

## Concurrent edits

Payment header values and their exact six-digit timestamp revision are read
in one statement. Previously a concurrent edit between two reads could pair
old values with a newer revision, defeating optimistic concurrency.

Draft updates lock the header before reading and merging stored fields. A
waiting partial update therefore preserves fields committed by the previous
writer. Revision timestamps advance monotonically, and a save returns its own
result while holding the transaction rather than reading a subsequent writer's
result. Existing stale-revision conflicts remain HTTP 409.

## Verification and rollout

`web/lib/payment-visibility.integration.test.ts` uses real PostgreSQL records,
role grants, subsidiary resolution, API handlers and server components. Only
session identity and presentation adapters are replaced. Twelve scenarios cover
AP and AR visibility, direct drawers, retained run evidence, empty scope,
shared-party reads and suggestions, a complete authorized allocation and post,
stale writes, deliberately interleaved reads and a blocked concurrent save.
Eleven scenarios were also run against the preceding production implementations
and failed, establishing the regressions before the final AR scenario was added.

No schema migration or historical transaction rewrite is required. Deploy the
web server and its assets from the same build. Rolling back this change would
restore the documented access and concurrency defects; prefer a forward fix if
an operational issue appears.

Run creation, approvals and segregation of duties, bank-file generation and
delivery, settlement retries and reversals still require systematic lifecycle
review. Passing these tests does not certify those remaining workflows.
