# Service dispatch

Service dispatch (`engine/src/service`, feature `serviceDispatch`) runs field
service work: requests, assessment visits, quotes, jobs, visits, recurring
agreements, completion, sign-off and invoicing, dispatched on Scheduling
boards of the `dispatch` type.

## Records and why they are native records

| Record | Table | Lifecycle |
| --- | --- | --- |
| Service request | `service_requests` | new → assessment scheduled → assessed → quoted → converted, or declined / cancelled |
| Service job | `service_jobs`, `service_job_lines` | open → completed (reopenable) or cancelled |
| Visit | `service_visits` (+ `service_visit_events`) | unscheduled → scheduled → dispatched → en route → on site → completed or unable to complete; cancelled |
| Agreement | `service_agreements`, `service_agreement_versions`, `service_agreement_lines` | active → ended or cancelled |
| Dispatch policy | `service_dispatch_policies` | append-only versions, effective-dated |

Service records are a record family of their own rather than a new document
kind or a project. They post nothing: every financial effect is made by a
native document through its native writer, so the ledger never learns a new
posting path. They are not projects because service work is short,
customer-site work with visits rather than budgets, phases and progress
billing, and putting it on projects would make every service call depend on
the Projects gate and its costing machinery.

Each record carries `revision` for optimistic concurrency; commands lock the
row, compare the revision the caller loaded and refuse a stale write. Status
moves are checked by the engine state machines (`status.ts`) and again by the
database guards (`service_status_guard`), and every move of a visit is
recorded in `service_visit_events` with actor, worker, reason and time.
Material changes are audited with before and after state.

## Reuse of native machinery

| Need | Native machinery |
| --- | --- |
| Quotes | Native estimates (`documents` kind `quote`) edited, priced, taxed and issued in the estimate drawer. `service_quotes` adds only the service terms: the request quoted, optional add-on lines and the deposit. |
| Customer acceptance (e-sign) | Native `signature_requests` with possession tokens and a document hash; a quote changed after sending refuses acceptance. |
| Bookings | `schedule_entries` rows carrying `service_visit_id` on a `dispatch` board. The shared exclusion constraint, leave and qualification guards apply across every board. |
| Labor | Native `time_entries` with `service_visit_id`, submitted for timesheet approval; the weekly grid treats them as source-owned. |
| Parts | Native inventory issue at completion from the stock location recorded on the part. |
| Invoices | Native draft invoices created through `createDocument`, then reviewed, approved and posted in the invoice drawer. `service_billings` links each invoice to its job or visit; voiding releases the link. |
| Deposits | Native customer payments left on account, linked as job deposits and applied to the job's posted invoice as native credit settlements. |
| Photos, signatures | File Cabinet attachments on the visit; the drawn signature image is stored in the same transaction that records the signature. |
| Customer notices | Native email delivery and email log, opt-in per organization in the dispatch policy. |
| Completion review | Optional Flows subject `service_visit_completion`; without an enabled Flow completion applies at once. |
| Customer portal | The native portal session; the Service requests section shows while Service dispatch is on and the portal setting allows it. |

## Pricing and money

Line amounts are exact decimals (`mulDecimalFactors`), never floating point.
Parts take the customer's native selling price for the job currency and date
(`resolveItemPrice`); a billed part with no price refuses rather than billing
at zero. Labor bills at the job's labor rate or the labor item's price.
Missing configuration (an item without an income account, a legal entity
without a base currency) refuses with the remedy.

## Agreements

Agreement terms are effective-dated versions. Occurrences are computed
deterministically from the version in force on each date
(`recurrence.ts`, `versionedOccurrences`) and generated idempotently through
the policy horizon: an occurrence key is unique per agreement, so a repeated
or concurrent run creates nothing twice, and a new version supersedes only
unbooked future occurrences. The worker runs generation daily.

## Dispatch rules

`dispatch-rules.ts` evaluates an assignment against the technician's day:
overlapping bookings on any board, recorded leave and missing verified
qualifications block; a day off, hours outside the working day, booking
beyond scheduled hours, a start outside the customer's arrival window and a
start after the response target warn and need an override reason, which is
recorded with the change. The database guards repeat the blocking rules.

## Permissions and gates

`service.read`, `service.manage` and `service.dispatch` are staff grants;
`service.self` lets a technician see and work only the visits booked on them,
without prices. Built-in roles: Service Dispatcher and Field Technician;
Controller reads and manages service records. Service dispatch is a child of
Scheduling (which is a child of Human Resources) on Company Settings →
Features, and every route, page, job and command enforces it. Turning it off
preserves all records and history.
