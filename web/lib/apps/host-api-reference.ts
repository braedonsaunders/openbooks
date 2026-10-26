/**
 * The app backend host API as an author reads it: every `ob.*` call the
 * sandbox installs, its arguments, what it returns, its governance cost and
 * the grant it needs. `backend-check.ts` refuses calls outside this surface
 * when a draft is saved, so the two must list the same members; the drift
 * test compares them.
 */

export interface HostCallDoc {
  call: string
  returns: string
  units: number
  /** Grant the app must hold (intersected with the signed-in user's permissions). */
  requires?: string
  notes?: string
}

export const APP_HOST_API_REFERENCE = {
  contract: 'Each endpoint file defines function handler(request) and returns a JSON value (the response body) or { status, body }. request = { method, endpoint, body, query, user: { id, name, roles } }. Throw new Error("message") to refuse: the message reaches the user and every write in the invocation rolls back. Calls are synchronous; there is no async/await, fetch, timer or module system. Budget: 1000 units and 3 seconds per invocation.',
  calls: {
    'ob.log': [
      { call: 'ob.log(...values)', returns: 'undefined', units: 1, notes: 'Lines appear in test_app_endpoint and list_app_runs.' },
    ],
    'ob.settings': [
      { call: 'ob.settings.get(key)', returns: 'the setting\'s current value (stored value, else its defaultValue, else null)', units: 0, notes: 'Only keys this app declares as setting contributions; another key throws.' },
      { call: 'ob.settings.all()', returns: '{ [key]: value } for every declared setting', units: 0 },
    ],
    'ob.storage': [
      { call: 'ob.storage.get(key, namespace?)', returns: 'the stored JSON value, or null', units: 5 },
      { call: 'ob.storage.set(key, value, namespace?)', returns: 'undefined', units: 10, notes: 'Package-private key/value state; namespace defaults to "default". Refused in read-only data endpoints.' },
      { call: 'ob.storage.list(prefix?, namespace?)', returns: '{ key, value }[]', units: 5 },
      { call: 'ob.storage.delete(key, namespace?)', returns: 'undefined', units: 10 },
    ],
    'ob.platform': [
      { call: 'ob.platform.schema()', returns: 'the record types this app and user may use, with fields and operations (the list_record_types inventory)', units: 20 },
      { call: 'ob.platform.list(typeKey, { page?, perPage? (≤100), q?, filters?: { field, operator?: "eq"|"ne"|"in"|"contains"|"startsWith"|"isNull", value }[] (≤20), sort?: { field, direction: "asc"|"desc" } })', returns: '{ records: Row[], total, page, perPage }', units: 20, requires: 'the type\'s read permission (records.read for custom records)' },
      { call: 'ob.platform.get(typeKey, id)', returns: 'Row, or null when absent or out of scope', units: 10 },
      { call: 'ob.platform.query({ from: { type, as }, joins?: [{ type, as, kind: "left"|"inner", on: { left: { source, field }, right: { source, field } } }] (≤4), select: [{ source, field }] (≥1), filters?: { combinator: "and"|"or", rules: [{ field: "<alias>.<field>", op: "eq"|"neq"|"in"|"not_in"|"gte"|"lte"|"is_null"|"is_not_null"|"contains", value }] }, sorts?: [{ column: "<alias>.<field>", direction }] (≤3), limit?: ≤1000 (default 100) })', returns: '{ columns: string[], records: { "<alias>.<field>": value }[], hasMore: boolean, limit }', units: 80, notes: 'Record keys are "<alias>.<field>", e.g. row["p.code"]. Read rows from .records — there is no .rows.' },
      { call: 'ob.platform.create(typeKey, body)', returns: 'the created record envelope; custom records return { record: { id, record_number, status, data, … } }', units: 50, requires: 'the type\'s write permission (records.create for custom records)', notes: 'Custom-record body: { data: { <field id>: value }, status: "active" }. Core types take the writable fields list_record_types reports.' },
      { call: 'ob.platform.update(typeKey, id, body)', returns: 'the updated record envelope', units: 50, notes: 'Documents and data-replacing custom-record updates need expectedUpdatedAt copied from a read.' },
      { call: 'ob.platform.delete(typeKey, id)', returns: 'the deletion result', units: 50 },
    ],
    'ob.records': [
      { call: 'ob.records.list(typeKey, filters?)', returns: 'custom records of one published type', units: 10, requires: 'records.read' },
      { call: 'ob.records.get(typeKey, id)', returns: 'one custom record, or null', units: 5, requires: 'records.read' },
    ],
    'ob.journal': [
      { call: 'ob.journal.create({ documentDate?: "YYYY-MM-DD", memo?, referenceNumber?, subsidiaryId?, lines: [{ accountCode | accountId, amount: "<signed decimal string; + debit, − credit>", description?, departmentId?, projectId? }] (2–200) }, { post?: boolean })', returns: '{ id, documentNumber, entryId? (when posted), approvalPending? }', units: 100, requires: 'gl.post', notes: 'Lines must balance to zero at 4 decimal places; amounts are decimal strings, never floats. post: true runs the posting engine (200 units); a configured approval flow returns approvalPending instead. Summary accounts refuse postings.' },
    ],
  } satisfies Record<string, HostCallDoc[]>,
} as const
