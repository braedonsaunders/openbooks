# Posting effects: reconcile, retry and close

A successful journal commit is durable. Inventory and revenue projections run
through the durable posting-effects outbox after that commit. A downstream
failure does not unpost the document and must not be treated as full completion.

## Review on the source document

The shared document drawer displays the effect state:

| State | Meaning and action |
| --- | --- |
| Queued | Worker processing is pending; check worker health and wait. |
| Processing | A leased attempt is running; do not launch another manual attempt. |
| Automatic retry pending | Review the error and correct configuration or data; the worker retries with bounded backoff. |
| Review and retry required | The attempt ceiling was reached. Investigate and correct the cause, then choose **Retry posting effects** with a 10–1000 character review reason. |
| Complete | The durable effect finished successfully. Reconcile the resulting subledger and journal evidence. |

Retry requires the document's posting permission and legal-entity access at the
engine boundary, including operations-CLI calls. The document must still be
posted. A retry queues work; it does not itself establish completion. The prior
terminal evidence and the actor/reason are retained in the audit trail. Worker
lease fencing and downstream idempotency protect against repeated attempts;
retrying never deliberately creates a second source-document journal.

## Operations inspection

For an authorized database operator, use the existing operations CLI:

```bash
npm -w engine run posting-effects:ops -- list --org=<organization-id>
npm -w engine run posting-effects:ops -- replay --org=<organization-id> \
  --id=<effect-id> --actor=<authorized-user-id> --reason= '<review reason>'
```

Use your deployment's configured runtime database connection. Do not put
credentials into commands or evidence reports. Confirm the worker is healthy,
review terminal logs and notifications, inspect the source document, correct
the cause through its owning configuration/workflow, queue one replay, then
confirm `succeeded` and reconcile the projected results. Do not reset outbox
state with ad hoc SQL or edit posted financial history.

## Close consequences

Incomplete effects are critical close-readiness exceptions. Hard GL close also
checks the live outbox inside the period/book close transaction. The existing
exclusive posting fence prevents a new posting from slipping past that check.
The check is scoped to the organization, accounting period, book and relevant
legal entities; documents without an entity remain conservatively relevant.
There is no manual exception waiver that bypasses this hard-close control.

When a failure concerns an already closed period, use the existing approved
reopen workflow where the required correction needs posting authority. Review
the resulting journals and subledger reconciliations before re-closing.
