import type { DocArticle } from '../types'

export const appApiReference: DocArticle = {
  slug: 'app-api-reference',
  title: 'App API Reference',
  category: 'apps',
  order: 3,
  summary:
    'Function-by-function reference for the app frontend bridge, backend host API, endpoint contract, permissions, limits, and governance.',
  updated: '2026-07-31',
  keywords: [
    'app API',
    'frontend SDK',
    'backend API',
    'openbooks',
    'ob',
    'storage',
    'records',
    'journal',
    'governance',
    'record API',
  ],
  related: ['app-builder', 'apps', 'scripting-api-reference', 'rest-api'],
  body: `# App API Reference

This article defines the complete public programming contract for installed
Apps. It covers the **openbooks** SDK injected into an App frontend and the
**ob** host object injected into an App backend endpoint.

## Complete host surface

The App API is a self-describing, governed platform API rather than a collection
of table-specific shortcuts. **openbooks.platform.schema()** reports every
record type, field, operation, and permission available to the current App and
user. The matching **list**, **get**, **create**, **update**, and **delete**
functions cover built-in and published custom record types through the same
domain services used by the UI and REST API.

The host surface includes:

- frontend context and backend endpoint invocation;
- searchable, filterable, sortable, paginated platform records;
- live per-organization record and field metadata;
- governed record creation, update, deletion, and document lifecycle actions;
- app-private namespaced storage;
- custom-record convenience functions;
- balanced journal creation and governed posting; and
- permission intersection, audit/run history, limits, and unit governance.

Direct database, filesystem, process, environment, and network access are not
available. All platform access uses the documented host functions, which enforce
tenant scope, validation, audit requirements, and accounting invariants.

## Execution model

An App has two isolated halves:

1. The **frontend** is the package's HTML entry plus inlined JS, CSS, images,
   and fonts. It runs in an opaque-origin iframe with scripts enabled, but no
   cookies, parent DOM access, forms, or direct network access.
2. A **backend endpoint** is a JavaScript file named by the manifest. It runs
   in a QuickJS WebAssembly sandbox with no Node.js, database connection,
   filesystem, process, or network. Host functions are the only I/O surface.

Frontend SDK functions are asynchronous and return Promises. Backend host
functions appear synchronous inside the endpoint sandbox.

## Manifest API contract

The package manifest controls which code can run and which capabilities may be
granted.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| **key** | string | yes | Stable lowercase slug beginning with a letter; maximum 64 characters. |
| **name** | string | yes | App name; 1–120 characters. |
| **version** | string | yes | Numeric version such as **1**, **1.2**, or **1.2.3-beta**. |
| **description** | string | no | Description; maximum 2,000 characters. |
| **icon** | string | no | Host icon-registry key. |
| **permissions** | string[] | no | Requested capabilities. The administrator may grant a subset. |
| **frontend.entry** | string | yes | Bundle-relative HTML entry path. Traversal and absolute paths are rejected. |
| **endpoints** | object[] | no | Named backend endpoint declarations; maximum 50. |
| **nav.label** | string | no | Navigation label override. |
| **nav.icon** | string | no | Navigation icon override. |

Each endpoint declaration has:

| Field | Type | Meaning |
| --- | --- | --- |
| **name** | slug | Name passed to **openbooks.callBackend**. Names must be unique. |
| **file** | path | Bundle-relative JavaScript file that defines **handler**. |
| **method** | **GET**, **POST**, or **ANY** | Value exposed as **request.method**. **ANY** is invoked as **POST** by the frontend bridge. |

Example:

~~~json
{
  "key": "expense-helper",
  "name": "Expense Helper",
  "version": "1.0.0",
  "permissions": ["records.read", "gl.post"],
  "frontend": { "entry": "frontend/index.html" },
  "endpoints": [
    { "name": "summary", "file": "backend/summary.js", "method": "POST" }
  ],
  "nav": { "label": "Expense Helper", "icon": "receipt" }
}
~~~

## Permission evaluation

Access is the intersection of three gates:

1. the capability requested in the active manifest;
2. the capability granted by the installing administrator; and
3. the effective permissions of the user making the call.

Installation by an administrator does not transfer the administrator's
authority to the App. A frontend records call and the same records call
inside a backend endpoint both require the App grant and the calling user's
permission.

| Capability | Functions enabled |
| --- | --- |
| **records.read** | **openbooks.records.list**, **openbooks.records.get**, **ob.records.list**, **ob.records.get** |
| A record type's read permission | **platform.schema**, **platform.list**, and **platform.get** for that type |
| A record type's write permission | **platform.create**, **platform.update**, and **platform.delete** when the type advertises them |
| **ap.post** or **ar.post** | **action: post** for the corresponding bill or invoice writer |
| **gl.post** | **ob.journal.create**, for both draft and post requests |
| none | Context, **callBackend**, logging, and the App's own storage |

# Frontend SDK: window.openbooks

The host injects **window.openbooks** before the App's entry scripts execute.

## openbooks.context

~~~text
openbooks.context: {
  app: { id: string, key: string, name: string },
  user: { id: string, name: string, role: string } | null
}
~~~

The embedded context value. Treat it as informational identity, not as an
authorization grant. Server-side permission checks still apply to every call.

## openbooks.getContext()

~~~text
openbooks.getContext(): Promise<BridgeContext>
~~~

Returns a resolved Promise containing the same value as **openbooks.context**.
It performs no server call and requires no capability.

Example:

~~~javascript
const context = await openbooks.getContext();
document.querySelector('#title').textContent = context.app.name;
document.querySelector('#user').textContent = context.user
  ? context.user.name
  : 'Unknown user';
~~~

## openbooks.callBackend(endpoint, payload)

~~~text
openbooks.callBackend(endpoint: string, payload?: any):
  Promise<{ status: number, body: any }>
~~~

Runs one endpoint declared in the active manifest.

Parameters:

- **endpoint** — exact endpoint name from **manifest.endpoints**.
- **payload** — JSON-serializable value exposed as **request.body**. An omitted
  or undefined payload becomes **null** after transport.

Returns the normalized endpoint response. A bare handler return becomes
**{ status: 200, body: value }**. A handler may explicitly return
**{ status, body }**.

Rejects with an Error when the endpoint does not exist, its source is missing,
the App is disabled, a host capability is forbidden, the unit budget is
exceeded, execution times out, or the handler throws.

The manifest does not need a special capability merely to call its own
backend. Capabilities are checked when that backend uses protected host
functions.

Example:

~~~javascript
try {
  const response = await openbooks.callBackend('summary', {
    status: 'submitted'
  });
  if (response.status >= 400) throw new Error('Endpoint refused the request');
  renderSummary(response.body);
} catch (error) {
  showError(error.message);
}
~~~

## openbooks.records.list(typeKey, filters)

~~~text
openbooks.records.list(
  typeKey: string,
  filters?: { status?: string }
): Promise<Array<{
  id: string,
  recordNumber: string | null,
  status: string,
  data: object
}>>
~~~

Lists up to 200 custom records for one custom-record type, newest first.

Parameters:

- **typeKey** — stable key of the custom record type.
- **filters.status** — optional exact status match. Other filter keys are
  currently ignored; this is not a general search API.

Requires **records.read** for both the App and calling user. Returns an empty
array when no records match. Rejects on a missing grant.

Example:

~~~javascript
const requests = await openbooks.records.list('expense-request', {
  status: 'submitted'
});
~~~

## openbooks.records.get(typeKey, id)

~~~text
openbooks.records.get(typeKey: string, id: string): Promise<{
  id: string,
  recordNumber: string | null,
  status: string,
  data: object
} | null>
~~~

Loads one custom record by type key and UUID. Returns **null** when it does not
exist in the current organization or does not belong to the requested type.
Requires **records.read** for both the App and calling user.

Example:

~~~javascript
const request = await openbooks.records.get('expense-request', requestId);
if (!request) showNotFound();
~~~

# Frontend platform record API: openbooks.platform

The platform record API is the primary integration surface. Record type keys
and writable fields must come from **schema()** rather than being inferred or
hard-coded.

## openbooks.platform.schema()

~~~text
openbooks.platform.schema(): Promise<Array<RecordTypeSchema>>
~~~

Returns the live schema for every record type on which both the App and current
user have at least one operation. Record types with no effective operations are
omitted. Each element contains:

~~~text
{
  key: string,
  label: string,
  description: string,
  table: string,
  dynamic: boolean,
  operations: Array<'list' | 'get' | 'create' | 'update' | 'delete'>,
  readPermission: string,
  writePermission: string | null,
  fields: Array<{
    name: string,
    type: string,
    required: boolean,
    writable: boolean,
    description: string | null,
    custom: boolean
  }>
}
~~~

The returned **operations** array is already reduced by App grants and user
permissions. A type may therefore be read-only for one caller and writable for
another. Custom fields and published custom record types are included from the
current organization's live configuration.

~~~javascript
const schema = await openbooks.platform.schema();
const invoices = schema.find((type) => type.key === 'invoices');
if (invoices && invoices.operations.includes('create')) {
  enableInvoiceCreation(invoices.fields);
}
~~~

## openbooks.platform.list(typeKey, options)

~~~text
openbooks.platform.list(
  typeKey: string,
  options?: {
    q?: string,
    page?: number,
    perPage?: number,
    filters?: Array<{
      field: string,
      operator?: 'eq' | 'ne' | 'contains' | 'startsWith' | 'in' | 'isNull',
      value?: any
    }>,
    sort?: { field?: string, direction?: 'asc' | 'desc' }
  }
): Promise<{
  records: object[],
  total: number,
  page: number,
  perPage: number
}>
~~~

Returns an organization-scoped record page. When the caller is restricted to
specific subsidiaries, record types carrying **subsidiary_id** are filtered to
that same scope.

Parameters:

- **typeKey** — key from **platform.schema()**.
- **q** — case-insensitive search against the record type's declared search
  field; maximum 500 characters.
- **page** — one-based page, clamped to 1–10,000; default 1.
- **perPage** — records per page, clamped to 1–100; default 25.
- **filters** — up to 20 field filters. Fields must exist in the live schema.
- **sort.field** — a live schema field or supported custom-record base field;
  default **created_at**.
- **sort.direction** — **asc** or **desc**; default **desc**.

Filter operators:

| Operator | Value | Behavior |
| --- | --- | --- |
| **eq** | scalar | Exact equality; the default operator. |
| **ne** | scalar | Exact inequality. |
| **contains** | scalar | Case-insensitive substring match. |
| **startsWith** | scalar | Case-insensitive prefix match. |
| **in** | array | Match one of 1–100 values. |
| **isNull** | boolean | True or omitted means null; false means not null. |

Physical fields, built-in custom fields, and custom-record data fields use the
same filter contract. Unknown fields and malformed filters reject the Promise.
Requires the record type's effective read permission.

~~~javascript
const page = await openbooks.platform.list('invoices', {
  q: 'ACME',
  page: 1,
  perPage: 50,
  filters: [
    { field: 'status', operator: 'in', value: ['draft', 'submitted'] },
    { field: 'document_date', operator: 'startsWith', value: '2026-07' }
  ],
  sort: { field: 'document_date', direction: 'desc' }
});
~~~

## openbooks.platform.get(typeKey, id)

~~~text
openbooks.platform.get(typeKey: string, id: string): Promise<object | null>
~~~

Returns one organization- and subsidiary-scoped record by UUID, or **null** when no record of
that type exists. Document kinds and custom-record type keys are enforced in
addition to tenant scope, so an ID cannot cross into another logical type.
Requires the type's effective read permission. An invalid UUID rejects the
Promise.

~~~javascript
const invoice = await openbooks.platform.get('invoices', invoiceId);
~~~

## openbooks.platform.create(typeKey, body)

~~~text
openbooks.platform.create(typeKey: string, body: object): Promise<object>
~~~

Creates a record through its registered domain writer. Requires **create** in
the live schema and the type's effective write permission. The body is
validated against live fields; tenant IDs, audit stamps, and other read-only
columns cannot be supplied.

Behavior depends on the record type:

- built-in entities use typed columns plus validated **cf_** custom fields;
- custom records use their published form schema, formulas, required-field
  validation, lifecycle transitions, and trigger scripts; and
- bills and invoices create numbered drafts, apply header/line edits, and may
  include **action: draft**, **submit**, or **post**. Submit/post uses configured
  approval flows and the posting kernel. Posting also requires the App and user
  to hold the matching **ap.post** or **ar.post** permission.

Validation, lifecycle, permission, or accounting errors reject the Promise
with their host error message.

~~~javascript
const item = await openbooks.platform.create('items', {
  name: 'Field service hour',
  kind: 'service',
  is_active: true
});
~~~

## openbooks.platform.update(typeKey, id, body)

~~~text
openbooks.platform.update(
  typeKey: string,
  id: string,
  body: object
): Promise<object>
~~~

Updates one record through the same registered writer and validation rules as
**create**. Requires **update** and the effective write permission. Only
writable supplied fields change. Documents retain lifecycle and optimistic
domain checks; custom records retain status-transition, formula, and trigger
behavior. Unknown/read-only fields, invalid values, missing records, and
forbidden lifecycle transitions reject the Promise.

~~~javascript
const project = await openbooks.platform.update('projects', projectId, {
  name: 'North facility expansion',
  cf_delivery_lead: ownerId
});
~~~

## openbooks.platform.delete(typeKey, id)

~~~text
openbooks.platform.delete(typeKey: string, id: string):
  Promise<{ ok: true }>
~~~

Deletes through the registered domain writer. Requires **delete** and the
effective write permission. Referential integrity and record lifecycle rules
remain active: referenced entities, non-draft custom records, and documents
that cannot be safely removed are refused. Posted ledger projections are
read-only and never advertise delete.

~~~javascript
await openbooks.platform.delete('items', unusedItemId);
~~~

# Backend endpoint contract

Every endpoint file must define one global function named **handler**.

## handler(request)

~~~text
function handler(request: AppRequest): any
~~~

The function may return a JSON-serializable value or
**{ status: number, body: any }**. The handler is called once per frontend
request. Async Promise-returning handlers are not part of the public contract;
host functions are synchronous within the sandbox.

The request is recursively frozen before the handler receives it:

~~~text
{
  method: string,
  endpoint: string,
  path?: string,
  query: Record<string, string>,
  body: any,
  user: { id: string, name: string, role: string } | null
}
~~~

- **method** comes from the endpoint declaration; **ANY** becomes **POST** for
  calls made through the frontend SDK.
- **endpoint** is the declared endpoint name.
- **path** is currently undefined for bridge calls.
- **query** is currently an empty object for bridge calls.
- **body** is the frontend payload or **null**.
- **user** is the attributable caller.

Example:

~~~javascript
function handler(request) {
  if (!request.body || !request.body.status) {
    return { status: 400, body: { error: 'status is required' } };
  }
  return {
    status: 200,
    body: { requestedBy: request.user.name, status: request.body.status }
  };
}
~~~

## ob.request

~~~text
ob.request: AppRequest
~~~

The same recursively frozen object passed to **handler**. Prefer the function
parameter when practical. No capability or governance units are required.

## ob.log(...values)

~~~text
ob.log(...values: any[]): void
~~~

Appends one line to the endpoint run log. Each argument is JSON-serialized and
the serialized values are joined with spaces. Logs are visible in App Builder
under **Runs**. Logging costs 1 governance unit per call.

Do not log secrets, personal data, access tokens, or full accounting records.
Run logging is best-effort: a failure to persist the audit row does not change
the endpoint response.

Example:

~~~javascript
ob.log('processing', request.endpoint, { actor: request.user.id });
~~~

# Backend storage API: ob.storage

Storage is scoped to the current organization and App. This isolation prevents
one App from reading or overwriting another App's keys. Storage requires no
manifest capability.

The optional **namespace** argument defaults to **default**. Values must be
JSON-serializable.

## ob.storage.get(key, namespace)

~~~text
ob.storage.get(key: string, namespace?: string): any | null
~~~

Returns the stored JSON value, or **null** when the key is absent. Costs 5
governance units.

~~~javascript
const settings = ob.storage.get('settings') || { currency: 'CAD' };
~~~

## ob.storage.set(key, value, namespace)

~~~text
ob.storage.set(key: string, value: any, namespace?: string): void
~~~

Creates or replaces the key. An undefined value is normalized to JSON null.
Costs 10 governance units.

~~~javascript
ob.storage.set('settings', { currency: 'CAD', compact: true });
ob.storage.set('last-run', request.body, 'operations');
~~~

## ob.storage.list(prefix, namespace)

~~~text
ob.storage.list(prefix?: string, namespace?: string):
  Array<{ key: string, value: any }>
~~~

Returns at most 500 entries in key order whose keys begin with **prefix**.
The default prefix is the empty string, which lists the namespace. SQL wildcard
characters in the prefix are escaped and treated literally. Costs 5 governance
units.

~~~javascript
const drafts = ob.storage.list('draft:', 'requests');
~~~

## ob.storage.delete(key, namespace)

~~~text
ob.storage.delete(key: string, namespace?: string): void
~~~

Deletes the key if present. Deleting a missing key succeeds. Costs 10 governance
units.

~~~javascript
ob.storage.delete('draft:' + request.body.id, 'requests');
~~~

# Backend custom-record API: ob.records

These functions expose the same org-scoped custom-record reads as the frontend
SDK. They require **records.read** for the App and caller.

## ob.records.list(typeKey, filters)

~~~text
ob.records.list(typeKey: string, filters?: { status?: string }):
  Array<{ id, recordNumber, status, data }>
~~~

Returns up to 200 records, newest first. Only **filters.status** is currently
implemented. Costs 10 governance units.

~~~javascript
const submitted = ob.records.list('expense-request', {
  status: 'submitted'
});
~~~

## ob.records.get(typeKey, id)

~~~text
ob.records.get(typeKey: string, id: string):
  { id, recordNumber, status, data } | null
~~~

Returns one record or **null**. Costs 5 governance units.

~~~javascript
const row = ob.records.get('expense-request', request.body.id);
if (!row) return { status: 404, body: { error: 'not found' } };
~~~

# Backend platform record API: ob.platform

The backend platform functions have the same parameters, permission model,
validation, and return shapes as **openbooks.platform**. They are synchronous
inside **handler** and consume governance units.

## ob.platform.schema()

~~~text
ob.platform.schema(): RecordTypeSchema[]
~~~

Returns the caller-filtered live schema described under
**openbooks.platform.schema()**. Costs 20 governance units.

~~~javascript
const writable = ob.platform.schema()
  .filter(function(type) { return type.operations.indexOf('create') >= 0; });
~~~

## ob.platform.list(typeKey, options)

~~~text
ob.platform.list(typeKey: string, options?: ListOptions): {
  records: object[], total: number, page: number, perPage: number
}
~~~

Runs the searchable, filterable, sortable, paginated list operation documented
for the frontend API. Requires the record type's effective read permission.
Costs 20 governance units.

~~~javascript
const overdue = ob.platform.list('invoices', {
  filters: [
    { field: 'status', operator: 'eq', value: 'posted' },
    { field: 'due_date', operator: 'startsWith', value: '2026-07' }
  ],
  perPage: 100
});
~~~

## ob.platform.get(typeKey, id)

~~~text
ob.platform.get(typeKey: string, id: string): object | null
~~~

Returns one typed, organization-scoped record or **null**. Requires the
effective read permission. Costs 10 governance units.

~~~javascript
const party = ob.platform.get('parties', request.body.partyId);
~~~

## ob.platform.create(typeKey, body)

~~~text
ob.platform.create(typeKey: string, body: object): object
~~~

Creates through the record type's domain writer, including custom-field,
trigger, approval, document, and posting behavior documented for the frontend
function. Requires **create** plus the effective write permission. Costs 50
governance units.

~~~javascript
const created = ob.platform.create('expense-request', {
  data: { employee: request.user.id, amount: request.body.amount }
});
~~~

## ob.platform.update(typeKey, id, body)

~~~text
ob.platform.update(typeKey: string, id: string, body: object): object
~~~

Updates writable supplied fields through the domain writer. Requires
**update** plus the effective write permission. Costs 50 governance units.

~~~javascript
const active = ob.platform.update('expense-request', request.body.id, {
  status: 'active'
});
~~~

## ob.platform.delete(typeKey, id)

~~~text
ob.platform.delete(typeKey: string, id: string): { ok: true }
~~~

Runs governed deletion with lifecycle and referential-integrity enforcement.
Requires **delete** plus the effective write permission. Costs 50 governance
units.

~~~javascript
ob.platform.delete('expense-request', request.body.id);
~~~

# Backend journal API: ob.journal

## ob.journal.create(input, options)

~~~text
ob.journal.create(
  input: {
    documentDate?: string,
    memo?: string,
    referenceNumber?: string,
    lines: Array<{
      accountId?: string,
      accountCode?: string,
      amount: string | number,
      description?: string,
      departmentId?: string,
      projectId?: string
    }>
  },
  options?: { post?: boolean }
): {
  id: string,
  documentNumber: string,
  entryId?: string,
  approvalPending?: boolean
}
~~~

Creates a governed journal document through the same accounting write path as
the UI. Requires **gl.post** for both the App and calling user, even when
creating a draft.

Input rules:

- **lines** must contain 2–200 lines.
- Each line needs **accountId** or **accountCode**. The account must be active,
  non-summary, and belong to the organization.
- **amount** is signed base-currency value: positive is a debit and negative is
  a credit. Zero is rejected. Precision is limited to four decimal places.
- Signed line amounts must sum exactly to zero at four-decimal precision.
- **documentDate** is **YYYY-MM-DD** and defaults to today.
- **description** is truncated to 500 characters, **memo** to 2,000, and
  **referenceNumber** to 100.
- Valid department and project UUIDs are stored as dimensions. Malformed
  optional dimension UUIDs are ignored.

With **post: false** or no options, the function creates a balanced draft and
returns its ID and JE document number. This costs 100 governance units.

With **post: true**, the journal follows configured approval flows. If gated,
the result contains **approvalPending: true**. Otherwise the real posting
engine validates open periods, balance, accounts, and other invariants and the
result contains **entryId**. This costs 200 governance units.

A posting failure can leave the already-created balanced draft in place, but it
does not produce a partially posted ledger entry.

Example:

~~~javascript
const result = ob.journal.create({
  documentDate: '2026-07-31',
  memo: 'App-generated reclassification',
  referenceNumber: request.body.reference,
  lines: [
    { accountCode: '6100', amount: '125.0000', description: 'Reclass debit' },
    { accountCode: '6200', amount: '-125.0000', description: 'Reclass credit' }
  ]
}, { post: false });

return { status: 201, body: result };
~~~

# Responses, errors, and run history

## Response normalization

- A handler returning **value** produces **{ status: 200, body: value }**.
- A handler returning **{ status, body }** preserves the numeric status.
- A handler returning undefined or null produces a null body.
- Return values and host arguments must be JSON-serializable.

An endpoint's response status is application data returned to
**openbooks.callBackend**. A 400 response from the handler does not itself make
the frontend Promise reject. Sandbox, bridge, permission, timeout, governance,
and missing-endpoint failures do reject it.

## Run statuses

Each backend invocation records:

- endpoint and timestamp;
- **ok**, **error**, **timeout**, or **forbidden** status;
- governance units used and duration;
- **ob.log** output;
- error message when present; and
- attributable user.

## Runtime limits

| Limit | Value |
| --- | --- |
| Default execution timeout | 3 seconds |
| Maximum internal timeout | 15 seconds |
| Governance budget | 1,000 units per endpoint call |
| Sandbox memory | 64 MiB |
| Sandbox stack | 1 MiB |
| Custom records returned by list | 200 |
| Storage entries returned by list | 500 |
| Platform records returned per page | 100 |
| Platform filters per list call | 20 |
| Values in one **in** filter | 100 |
| Journal lines | 200 |
| Manifest endpoints | 50 |

## Governance costs

| Function | Units |
| --- | ---: |
| **ob.log** | 1 |
| **ob.storage.get** | 5 |
| **ob.storage.list** | 5 |
| **ob.storage.set** | 10 |
| **ob.storage.delete** | 10 |
| **ob.records.get** | 5 |
| **ob.records.list** | 10 |
| **ob.platform.schema** | 20 |
| **ob.platform.list** | 20 |
| **ob.platform.get** | 10 |
| **ob.platform.create** | 50 |
| **ob.platform.update** | 50 |
| **ob.platform.delete** | 50 |
| **ob.journal.create** draft | 100 |
| **ob.journal.create** post request | 200 |

# Security boundary

- Frontend CSP uses **default-src none** and **connect-src none**. Scripts,
  styles, images, and fonts are limited to the inlined package and data URLs.
- The iframe has **allow-scripts** but deliberately lacks
  **allow-same-origin**.
- Frontend bridge messages are accepted only from the host's own iframe.
- Backend code has no ambient database, network, filesystem, environment, or
  Node.js access.
- App storage, record reads, and journal writes are organization-scoped by the
  host; the App never supplies an organization ID.
- Subsidiary-aware record types enforce the calling user's allowed subsidiary
  set on reads and writes.
- Every protected call is rechecked against the active App grants and current
  user permissions.

These constraints are part of the API contract. New platform capabilities
extend the governed host surface with
explicit record types, operations, permissions, schemas, audit behavior, and
unit costs rather than granting sandbox code ambient access.
`,
}
