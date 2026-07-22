import type { DocArticle } from '../types'

export const scriptingEngine: DocArticle = {
  slug: 'scripting-engine',
  title: 'Scripting Engine',
  category: 'apps',
  order: 3,
  summary:
    'Author server-side automation: trigger, scheduled, endpoint, bulk, and client scripts that run in a governed sandbox.',
  updated: '2026-07-21',
  keywords: [
    'scripts',
    'scripting',
    'automation',
    'trigger',
    'before submit',
    'before post',
    'after post',
    'scheduled',
    'endpoint',
    'bulk',
    'client script',
    'sandbox',
  ],
  related: ['scripting-api-reference', 'app-builder', 'record-customization', 'audit-log'],
  body: `# Scripting Engine

**Settings → Extend → Scripts** (route **/admin/scripts**) lets an administrator
attach server-side automation to the platform. Scripts run in an isolated
WebAssembly JavaScript sandbox with no filesystem, network, or database
connection — they touch data only through the governed **ob** host API. Authoring
requires the **Manage scripts** permission.

## Script kinds

Choose a kind by *when* the code should run. Every kind except **client** shares
one entry point — a global **function main(ctx)** — and receives a frozen
context object.

| Kind | Runs | Typical use |
| --- | --- | --- |
| **before_submit** | When a document (or custom record) is submitted | Validate or default fields before save |
| **before_post** | Just before a document posts to the ledger | Enforce a posting rule; veto a bad post |
| **after_post** | After a document has posted | Side effects — logging, notifications, follow-on data |
| **before_void** | Before a document is voided | Guard against voiding the wrong thing |
| **scheduled** | On a cron schedule | Recurring maintenance and reports |
| **endpoint** | On an HTTP call to /api/scripts/e/&lt;slug&gt; | A small custom API |
| **bulk** | On demand via Run now | One-off batch processing |
| **client** | In the browser as a record is saved | Fast inline validation and warnings |

A script can be scoped to **all kinds**, a specific document kind (for example a
vendor bill), or a custom record type. Active scripts for the same trigger run in
their configured order, and the chain **stops at the first script that aborts or
errors**.

## The context object

For trigger scripts, **ctx** carries **trigger**, the **document** and its
**lines**, and read-only **org** and **user** information. Endpoint scripts also
receive **request** (method, query, body). Scheduled and bulk scripts are
document-less — they get **trigger** and **org** only. The context is frozen, so
scripts read it and describe their intended changes rather than mutating it
directly.

## Changing a document

A **before_** trigger returns its changes as data:

~~~js
function main(ctx) {
  if (!ctx.document.memo) {
    return { set: { memo: 'Imported ' + ctx.document.referenceNumber } }
  }
}
~~~

Only a whitelist of fields may be set: **memo**, **internalNotes**,
**expectedPayDate**, **paymentHoldReason**, **dueDate**, **departmentId**,
**projectId**, **locationId**, **classId**, and **custom**. Attempting to set any
other field fails the run. To veto the operation outright, call **ob.abort(reason)**
— the submit, post, or void is refused and the reason is recorded.

## Client scripts are different

Client scripts run in the browser as the user saves a record. Their context is
just **{ kind, doc }**, and there is **no ob API** — only the data passed in.
Return **{ abort: "reason" }** to block the save or **{ warnings: [...] }** to
warn and continue. Client scripts fail open: if one throws or times out, the save
proceeds. Use them for fast feedback, and enforce anything that must not be
bypassed in a **before_submit** or **before_post** server script.

## Deploying each kind

- **Scheduled** scripts run from a cron expression you supply, dispatched by the
  background worker (and inline when the worker is unavailable).
- **Endpoint** scripts are called at **/api/scripts/e/&lt;slug&gt;** with a unique
  per-organization slug; calling one requires the **Execute scripts** permission.
  The value **main** returns becomes the JSON response body.
- **Bulk** scripts run from the **Run now** action.
- **Client** scripts are delivered to the browser for their document kind and
  cached briefly.

## Limits and logging

Scripts run under a memory cap, a stack cap, and a time limit (a stored per-script
timeout, capped when saved; bulk runs get a longer fixed budget). Read queries
are capped in rows and time. Exceeding a limit ends the run as a timeout or error.

Every run is written to the script log with its status (**ok**, **aborted**,
**error**, or **timeout**), duration, and the lines the script emitted with
**ob.log(...)**. Review the log to see why a trigger vetoed an operation or why a
scheduled job failed.

For the complete host API, the available language features, and the exact
entry-point contracts, see **Scripting API Reference**.
`,
}

export const scriptingApiReference: DocArticle = {
  slug: 'scripting-api-reference',
  title: 'Scripting API Reference',
  category: 'apps',
  order: 4,
  summary:
    'The ob host API, available language features, entry-point contracts, and governed journal writes for scripts and app backends.',
  updated: '2026-07-21',
  keywords: [
    'ob',
    'api reference',
    'ob.query',
    'ob.journal',
    'ob.record',
    'ob.search',
    'ob.log',
    'ob.storage',
    'ob.records',
    'libraries',
    'sandbox',
    'quickjs',
    'governance units',
  ],
  related: ['scripting-engine', 'app-builder'],
  body: `# Scripting API Reference

Scripts and app backends run in a bare JavaScript sandbox with a single injected
global, **ob**. This page enumerates what **ob** exposes, the language features
available, and the exact entry-point contracts.

There are two runtimes. They share an engine but expose **different host APIs** —
do not assume a method from one exists in the other:

- **User scripts** — the trigger, scheduled, endpoint, and bulk scripts authored
  in **Scripts**. Entry point: **function main(ctx)**.
- **App backends** — the endpoint handlers bundled inside an app. Entry point:
  **function handler(request)**.

## Available language features and libraries

The sandbox is a current-standard JavaScript engine (roughly ES2023). The only
globals are the language built-ins — **Object**, **Array**, **Map**, **Set**,
**JSON**, **Math**, **Date**, **Promise**, string and number methods, and so on —
plus the injected **ob** object.

**No third-party libraries are provided, and there is deliberately no way to add
them.** There is no **fetch**, no network, no filesystem, no **crypto**, no module
loader, and no date or utility library such as lodash. Everything a script needs
comes through **ob**. This is what keeps a script from reaching outside its
organization's data or making unauthorized calls.

## User-script entry point

~~~js
function main(ctx) {
  // ctx is frozen: { trigger, document?, lines?, request?, org, user? }
  const rows = ob.query('select count(*) as n from documents')
  ob.log('documents:', rows[0].n)
  return { set: { memo: 'reviewed' } } // before_* triggers only
}
~~~

Return values by kind: **before_** triggers may return **{ set: {...} }** (see the
field whitelist in **Scripting Engine**); **endpoint** scripts return any
JSON-serializable value, which becomes the response body; **after_post**,
**scheduled**, and **bulk** returns are logged but otherwise ignored. Call
**ob.abort(reason)** to veto a **before_** operation.

## The ob host API — user scripts

| Method | Signature | What it does |
| --- | --- | --- |
| **ob.log** | log(...args) | Append a log line (stored on the run) |
| **ob.abort** | abort(reason) | Veto the current before_ operation |
| **ob.runtime** | property { org, trigger, user } | Frozen context info |
| **ob.query** | query(sqlText) → rows[] | Run a read-only **SELECT** and return rows |
| **ob.record.load** | record.load(table, id) → row \\| null | Load one row by id |
| **ob.search** | search(table, filters) → rows[] | Rows matching key=value filters (up to 1000) |
| **ob.journal.create** | journal.create(input, opts?) → { id, documentNumber, entryId? } | Create a governed balanced journal; opts.post posts it |

**ob.query** runs raw PostgreSQL through a read-only database role inside a
read-only transaction — standard SQL, no proprietary dialect — and is capped in
rows and statement time. **ob.record.load** and **ob.search** validate the table
name and scope reads to your organization.

## Governed journal writes

**ob.journal.create** is the single path from a sandbox into the ledger. Its
input is a balanced entry:

~~~js
ob.journal.create({
  documentDate: ctx.document.date,
  memo: 'Accrual',
  lines: [
    { accountCode: '6000', amount: 100.00, description: 'Expense' },  // debit +
    { accountCode: '2100', amount: -100.00, description: 'Accrual' }, // credit -
  ],
}, { post: true })
~~~

Rules the engine enforces: line amounts are signed (**+** debit, **−** credit) and
must **sum to zero**; there must be between 2 and 200 lines; accounts resolve to
active, non-summary accounts in your organization. When **post** is true the entry
runs through the posting engine and every posting invariant (balance, open period,
account validity) applies. Posting is refused from inside a **before_** trigger —
create the draft there and post it from **after_post** or a later run. A sandbox
can never write ledger tables directly.

## The ob host API — app backends

App endpoint handlers receive a frozen **request** of
**{ method, endpoint, path, query, body, user }** and return either a bare value
(HTTP 200) or **{ status, body }**. Their **ob** API differs from user scripts:

| Method | Signature | Capability | What it does |
| --- | --- | --- | --- |
| **ob.log** | log(...args) | — | Append a log line |
| **ob.request** | property | — | The frozen request |
| **ob.storage.get** | get(key, ns?) | — | Read the app's private key-value store |
| **ob.storage.set** | set(key, value, ns?) | — | Write to the store |
| **ob.storage.list** | list(prefix, ns?) | — | List entries by prefix |
| **ob.storage.delete** | delete(key, ns?) | — | Delete an entry |
| **ob.records.list** | list(typeKey, filters?) | records.read | Read custom records |
| **ob.records.get** | get(typeKey, id) | records.read | Read one custom record |
| **ob.journal.create** | create(input, opts?) | gl.post | Governed journal (same rules as above) |

The private storage methods are always available. The records and journal methods
work only when the app was granted the matching capability **and** the calling
user holds the same permission; otherwise the call is forbidden.

## App frontend SDK

An app's frontend talks to its backend through an injected **window.openbooks**
object (not **ob**): **openbooks.getContext()**, **openbooks.callBackend(endpoint,
payload)**, and read-only **openbooks.records.list / get**. The frontend cannot
reach the database or network directly — every call is relayed and re-checked on
the server.

## Governance units (app backends)

App endpoints run under a per-run **unit budget** (default 1000). Each host call
costs units — a log line costs 1, a storage read 5, a storage write 10, a record
list 10, creating a draft journal 100, and posting one 200. Exceeding the budget
ends the run. The **Runs** tab shows units consumed per call, which is the signal
to watch when an app does more work than expected. User scripts have no unit
budget — they are bounded by time, memory, and row caps instead.

## Error outcomes

- **User scripts** end as **ok**, **aborted**, **error**, or **timeout**. An
  endpoint script maps a timeout to HTTP 504 and other failures to 422; a trigger
  failure vetoes the underlying operation.
- **App backends** end as **ok**, **error**, **timeout**, or **forbidden**, which
  the bridge maps to HTTP 400, 504, and 403 respectively.

Every outcome, along with the script's log lines, is recorded on the run so you
can diagnose it after the fact.
`,
}
