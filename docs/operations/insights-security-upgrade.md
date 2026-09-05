# Insights authorization and mutation integrity

This change closes the Insights execution and saved-library access gaps found
in the September 2026 production-hardening review.

## Execution

- Insights uses the report catalog's subsidiary policy. The server supplies the
  user's current scope; request bodies cannot widen it. An empty scope produces
  no rows, including for shared catalog entities.
- Source permissions and effective Company Settings feature gates apply to
  execution. Projects being disabled also disables its Time Tracking child.
  The studio uses those same effective feature settings when offering sources.
- Compiled queries run in a read-only transaction under the application runtime
  role, with tenant RLS explicitly established and bypass disabled. The SQL
  console's separate restricted role cannot read the application tables used by
  the Insights compiler; its privileges have not been expanded.

## Saved cards and dashboards

Role audiences now apply to lists and their counts, direct reads, embedded cards,
pins, and mutations. Membership is resolved from role assignments in the current
organization. An identically named role in another organization grants nothing.
Readers see published records; editors/publishers can inspect drafts but still
must satisfy an explicit audience. Super administrators and roles granting the
full `*` permission can administer all audiences.

Null or an empty role array remains public to eligible Insights users. Malformed
role lists submitted to the API are rejected. Existing records are preserved;
an administrator can adjust legitimate audiences through the existing APIs.

## Changes and concurrency

Card/dashboard creation, edits, publication and deletion use one transaction
for authorization, row locking, mutation and audit evidence. The audit records
the actor and complete before/after images. Failure to record evidence rolls
back the mutation, including removal of deleted-card placements from dashboards.

Every Insight writer acquires the same organization-specific transaction lock
before row locks. This serializes JSON layout references against card deletion.
Dashboard writes reject malformed, missing and inaccessible card references.
Deleting a card advances each affected dashboard revision and audits its layout
change, so an earlier autosave cannot restore a deleted placement.

Reads return values and their six-digit timestamp revision from one SQL
statement. Writes return their own resulting row and revision rather than
performing a later independent read. Publish/unpublish requests now require
`expectedUpdatedAt`, using the exact token from the displayed record. A stale or
missing token returns 409. Both editors update their token from the publication
response before their next autosave; publication is unavailable while unsaved
changes remain.

Deploy the web server and its assets from the same build. No schema migration
or historical data rewrite is required.

## Regression evidence

`web/lib/report-security.integration.test.ts` exercises the real route handlers,
current database grants, subsidiary restrictions, role audiences, feature gates,
audit-failure rollback across all lifecycle writes, layout validation, and stale
revision rejection. Its session and translation adapters are test-only; query,
authorization, audit and transaction behavior use PostgreSQL.

`e2e/insights.spec.ts` exercises live query preview and the browser's
edit → publish → edit flow for both a card and a dashboard. The analytics package
also checks every catalog subsidiary policy, mandatory execution scope and
transaction cleanup after a query error.

The fixture architecture regression now speaks the owner's newline-delimited
shutdown protocol. It previously waited for EOF and deadlocked against the real
client, failing the GitHub merge gate after a two-minute timeout.

## Additional defects found during verification

- Inventory FIFO now orders remeasurement fragments by their original receipt
  and creation chronology before using the fragment ID as a final tie-break.
  A random rounding-fragment UUID previously changed consumption order and
  produced an intermittent NRV reversal mismatch. The regression deliberately
  places a fragment's UUID before the original layer. Posted entries are not
  rewritten; the correction applies to subsequent layer consumption.
- Test processes no longer read the developer's local `.env` through the database
  module. Database, Redis and transport settings must be supplied explicitly.
  This is enforced for both `NODE_ENV=test` and Node's test-worker context.
- The macOS test launcher disables concurrent Sparkplug compilation to avoid a
  sampled Node 24 shutdown deadlock between the main thread and background GC.
  Linux CI and production runtime flags are unchanged.
- Accessibility checks wait for page entrance opacity animations to finish
  before measuring contrast. They retain the same WCAG rules and thresholds.
