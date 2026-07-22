import type { DocArticle } from '../types'

// Automation & integration admin tools, in the Apps & Extensions category:
// Flows, the Query Console, API keys + REST API, and Sandboxes.

export const flows: DocArticle = {
  slug: 'flows',
  title: 'Flows and Approvals',
  category: 'apps',
  order: 5,
  summary:
    'Build visual workflows that validate, route for approval, notify, and act on records when they are created, submitted, posted, or voided.',
  updated: '2026-07-21',
  keywords: [
    'flows',
    'workflow',
    'approval',
    'gate',
    'trigger',
    'automation',
    'notification',
    'segregation of duties',
    'escalation',
  ],
  related: ['scripting-engine', 'roles-and-permissions', 'purchasing-workflow'],
  body: `# Flows and Approvals

**Settings → Automate → Flows** (route **/admin/flows**, permission **Manage
flows**) is a visual, no-code engine for both automation and human approvals. A
flow watches one kind of record and runs a graph of steps when something happens
to it. Flows is an optional feature; when it is off, the menu and routes are
hidden.

## What a flow is made of

You build a flow on a canvas from four kinds of node:

- **Trigger** — what starts the flow. Triggers fire on record events —
  **create**, **update**, **submit**, **before post**, **after post**, **before
  void**, and **status change** — as well as on a **schedule**, on a **field
  value** condition, or from a **manual** button placed on the record.
- **Condition** — branches the flow **then** or **else** based on a rule over the
  record's fields.
- **Action** — does something: **send email**, **notify** in-app, **set a field**,
  **change status**, **post the document**, or **lock / unlock** the record.
- **Gate** — pauses for human **approval**.

Flows can watch transaction documents of every kind, as well as bank accounts,
budget scenarios, and close runs.

## Approvals

A **gate** routes the record to approvers. Assignees can be a specific **user**,
a **role**, the **submitter's supervisor**, or a user named in a field. A gate
sets its quorum — **any** approver or **all** of them — and can require
**separation of duties** (the submitter cannot approve their own record), demand
a typed **e-signature** to approve, send **reminders**, and **escalate** to
someone else after a set time. A signature-required gate must be approved in the
app, one at a time — it cannot be cleared by bulk approve or a one-click email
link.

When a record is submitted and a flow produces gates, the flow takes ownership of
the submission and moves the record to **pending approval**. Approvers act from
the **Approvals** worklist or from one-click links in their notification emails.
A rejection returns the record to draft and cancels the sibling gates; the record
is released only once every gate across the flow is approved. Approval routing
**fails closed** — if a flow cannot resolve an approver, the record stays in draft
rather than slipping through unapproved.

## Build and enable

Create a flow, pick the record kind it watches, and lay out the graph. Drafts
save with non-blocking warnings so you can work incrementally, but **turning a
flow on requires a clean validation** — the wiring must be complete and valid
before it can run. Each flow's run history is available from the builder so you
can see what fired and why.

Flows and the **Scripting Engine** overlap in when they run; reach for a flow when
you want a visual, approval-centric process, and a script when you need arbitrary
server-side logic.
`,
}

export const queryConsole: DocArticle = {
  slug: 'query-console',
  title: 'Query Console',
  category: 'apps',
  order: 6,
  summary: 'Run read-only SQL against your organization data safely, with a schema browser and CSV export.',
  updated: '2026-07-21',
  keywords: ['query console', 'SQL', 'read-only', 'select', 'schema browser', 'CSV export', 'reporting', 'ad hoc'],
  related: ['financial-reports', 'analytics-and-saved-views', 'scripting-api-reference'],
  body: `# Query Console

**Settings → Extend → Query Console** (route **/query**, permission **Run SQL**)
is a read-only SQL workbench for ad-hoc questions the standard reports do not
answer. It is safe by construction — the safety comes from the database, not from
a text filter.

## How it stays safe

- Every query runs as a **read-only database role** inside a **read-only
  transaction**, so inserts, updates, and schema changes are refused by the
  database itself.
- The connection is scoped to your organization by row-level security, so you can
  only ever see your own organization's data.
- A query must be a single **SELECT** (or **WITH**) statement; anything else is
  rejected before it runs.
- Results are capped (up to 5,000 rows per run) and a query is stopped if it runs
  longer than ten seconds.

## Working in the console

Write a query and run it with Cmd/Ctrl-Enter, or run just the selected text.
Choose the row limit (100 to 5,000). The **schema browser** lists the tables and
columns your role can see, so you can explore the model without guessing names.
Save reusable **snippets** and revisit recent queries from **history** — both are
kept in your browser. Export a result with **Copy CSV** or **Download CSV**.

The Query Console is for reading. To write data safely from automation, use the
**Scripting Engine** or a **Flow**, both of which post through the governed
transaction path.
`,
}

export const restApi: DocArticle = {
  slug: 'rest-api',
  title: 'API Keys and the REST API',
  category: 'apps',
  order: 7,
  summary: 'Create scoped API keys and integrate with the REST API, with each key bounded by its owner’s permissions.',
  updated: '2026-07-21',
  keywords: ['API key', 'REST API', 'integration', 'scope', 'bearer token', 'OpenAPI', 'api docs', 'authentication'],
  related: ['app-builder', 'roles-and-permissions', 'audit-log'],
  body: `# API Keys and the REST API

**Settings → Extend → API Keys** (route **/admin/api-keys**, permission **Manage
API keys**) issues the credentials that let external systems integrate with your
organization over the REST API. **API Docs** (route **/api-docs**) documents the
endpoints and includes an interactive console.

## Create and scope a key

Create a key with a name and, optionally, an expiry and a set of **scopes**.
Scopes are chosen from the permission catalogue — the same permissions that gate
the app. Two rules keep keys safe:

- a key's effective access is always its **scopes intersected with its owner's own
  permissions**, so a key can never do more than the person who created it; and
- a key left with **no scopes inherits the owner's full permissions** — grant
  explicit scopes for anything that should be limited.

The full key value (an **ob_live_** token) is shown **once** at creation — copy it
then, because only a hash is stored afterward. The list shows each key's prefix,
owner, scope count, and last use. Revoking a key deactivates it while preserving
its history, and every key change is recorded in the audit log.

## Authenticate and call the API

Send the key as a **Bearer** token in the **Authorization** header, or in an
**X-API-Key** header. Each request is scoped to the key's organization and checked
against its effective permissions, and each call is logged.

The REST API exposes core records — **bills**, **invoices**, **parties**,
**items**, **projects**, and **assets** for read and write, and **journal
entries**, **payments**, and **accounts** for reading — plus any custom record
types you have published. Writes go through the same domain rules as the app
(documents are drafted, applied, and posted), so the API cannot bypass posting
invariants. A generated **OpenAPI** description is served for tooling.

Keep integration keys narrowly scoped, rotate them on a schedule, and revoke any
key that is no longer in use. Note that keys are automatically disabled inside a
**Sandbox**, so integrations never fire from a test environment.

## Rate limits

Each key has a **requests-per-minute** limit — 120 by default, adjustable per key
when you create or edit it, or left blank for no limit. When a key exceeds its
limit the API responds with **429 Too Many Requests** and a **Retry-After**
header telling the caller how many seconds until the window resets. The counter
is per key and rolls over every minute.
`,
}

export const sandboxes: DocArticle = {
  slug: 'sandboxes',
  title: 'Sandboxes',
  category: 'apps',
  order: 8,
  summary: 'Create isolated copies of your organization to test configuration and train safely, with PII masking and no outbound side effects.',
  updated: '2026-07-21',
  keywords: ['sandbox', 'test environment', 'clone', 'masking', 'PII', 'refresh', 'promote', 'UAT', 'training'],
  related: ['roles-and-permissions', 'company-settings', 'migrate-with-a-connector'],
  body: `# Sandboxes

**Settings → Administration → Sandboxes** (route **/admin/sandboxes**, permission
**Manage sandboxes**) creates isolated copies of your organization for testing
configuration changes, trialing an upgrade, or training staff — without touching
production. Sandboxes are managed **from production**; you cannot create or
refresh one from inside a sandbox.

## Choose a tier

A sandbox is a full tenant of its own, isolated by row-level security. Pick a tier
for what you need:

- **Dev** — copies only the customization layer (scripts, custom fields, forms,
  roles, and the like). Fast, with no business data.
- **Masked** — a full copy with personal information masked. The recommended
  default for most testing.
- **Full** — a complete, unmasked copy for user-acceptance testing.
- **As-of** — the ledger cloned through a chosen period close, for point-in-time
  work.

**Masking** replaces sensitive values — names, emails, phone numbers, addresses,
and bank details — deterministically, so a value masks the same way on every
refresh but cannot be reversed.

## Safe by isolation

A newly cloned sandbox is **neutered**: outbound email, payment files, SFTP, and
exchange-rate credentials are stripped, and any copied API keys are disabled. On
top of that, every outbound side effect checks that it is not running in a
sandbox. Together this guarantees a sandbox cannot email a customer, move money,
or reach an external system.

## Create, enter, refresh, and remove

Creating or refreshing a sandbox runs in the background; its status moves through
**provisioning** to **ready**. From the sandbox list you can:

- **Enter** a ready sandbox — you switch into it for your session and switch back
  out when done;
- **Refresh** it — re-copy business data while, by default, keeping the
  customizations you have been testing;
- **Reset** it — a full re-clone that discards sandbox changes;
- schedule automatic refreshes; and
- **Delete** it.

## Promote configuration back

When a configuration change tests well in a sandbox, **Promote** captures the
differences in the promotable configuration (scripts, custom fields, forms, list
views, saved reports, account groups, roles, and similar) into a change set to
apply to production. Only configuration flows upward — business and ledger data
never promote from a sandbox to production.
`,
}

export const platformArticles: DocArticle[] = [flows, queryConsole, restApi, sandboxes]
