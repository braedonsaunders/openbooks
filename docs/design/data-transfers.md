# Durable data transfers

Import and export use organization-scoped PostgreSQL jobs processed in the
separate application worker. The browser uploads file slices and observes
durable status; it does not parse a complete file or construct an export Blob.
Company Setup hosts both workspaces with its native sidebar and page chrome.
Sample-company provisioning remains a Company Setup action in a separate
workspace.

## Import controls

An import proceeds through upload, parsing, mapping, validation, approval and
commit. Uploaded 4 MiB parts are ordered, checksummed and immutable. A resumed
upload verifies the original file against every acknowledged part before
appending. Request identities and optimistic command revisions protect against
duplicate submissions and stale browser actions.

The worker stages records in windows of at most 250 records and 8 MiB. Preview
responses retain at most 20 sample records and 64 KiB, and 100 findings; the full
findings download streams the persisted evidence. Whole-file identity and
consistency checks detect conflicts across batch boundaries. Approval binds
the source checksum, field definitions, mapping, mode, posting choice, actor,
record count and captured legal-entity scope. Editing mapping requires another
preview. Formula cells and ambiguous financial inputs retain the existing
native refusals.

Each committed batch uses the resource's native domain services, lifecycle
rules, precise decimal handling, posting controls and audit trail. Domain
effects, transfer checkpoint and batch evidence commit in one transaction.
A refused batch rolls back completely. Earlier committed batches remain
committed: this behavior is disclosed beside progress before approval.
Cancellation stops after the current transaction; it does not undo posted
history. Corrections use the applicable native reversals or adjusting entries.

Retries resume committed imports at their last checkpoint. Parsing can replay
the immutable prefix after a worker crash without staging duplicate rows.
The worker rechecks live actor status, permissions, feature availability,
schema and subsidiary access between batches. A narrowed permission scope
refuses continuation instead of silently omitting previously approved rows.

## Export controls

Record-backed resources use bounded keyset pagination instead of an offset
scan or the legacy synchronous 50,000-row ceiling. One repeatable-read,
read-only transaction supplies the complete export snapshot. Independent
organization-scoped transactions publish progress and checksummed output
parts while that snapshot remains open. Artifacts become downloadable only
after completion and a whole-file checksum. A failed export starts a fresh
snapshot and replaces only its unpublished output; it never mixes snapshots.

CSV and JSON output stream directly. XLSX uses a disk-indexed shared-string
reader and a streaming writer with backpressure; exports start another sheet
after 1,048,575 data rows. Financial decimals remain text to preserve digits.
An individual import record is limited to 4 MiB. Spreadsheet export cells
are limited to 32,767 characters; a refusal names CSV or JSON as the remedy.
Configuration resources whose native source is a single settings document
remain subject to that document's native bounds.

Completed downloads support single HTTP byte ranges, immutable ETags and
part checksum verification. Actor and resource authority are checked again
during long downloads. Unauthorized operators cannot open another actor's
job; whole-company import history requires unrestricted audit authority.

## Live status and operation

Both workspaces display durable phase, worker activity, record or upload byte
counts, last activity, committed effects and refusals. Polling retains the
last checkpoint through an outage and reconnects with bounded backoff. The
job identifier stays in the URL; recent transfers and import-history links
recover work after navigation or browser restart. Cancellation, retry and
artifact download act on the same persisted job.

The worker runs two transfer loops. Import validation and commit yield after
20 batches so older queued requests can advance between checkpoints. Claims are fenced, renewed during long
parses, and released during graceful shutdown after current work drains.
A replacement claim prevents an older worker from committing or overwriting
status. All child tables enforce organization isolation and composite job
ownership. Original source, staged record content and lifecycle evidence
have database immutability guards.

Rollout requires forward migration `0472_durable_data_transfers.sql` followed
by an updated web application and worker. Existing synchronous APIs remain
available with their documented small-file limits. A stopped transfer worker
leaves work queued and visible. Operational rollback should stop new transfer
submissions and roll back application code while retaining the additive
tables and existing tenant evidence.

Capacity planning must include database storage for original source, staged
records, indexes and output artifacts, temporary disk for XLSX decoding,
database connection capacity, and the MVCC cost of long export snapshots.
No automatic retention deletion is enabled: evidence remains available until
an authorized organization-data lifecycle operation removes it. Million-row
capacity depends on resource complexity and deployment capacity; bounded
memory is not a throughput or elapsed-time guarantee.
