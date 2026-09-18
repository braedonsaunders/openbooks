import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { DOC_KINDS } from './document-kinds.ts'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../${specifier.slice(2)}`, import.meta.url).href, context)
    }
    return nextResolve(specifier, context)
  },
})

// tsx compiles neighboring legacy JSX modules with the classic runtime when
// this test starts from the repository root; provide that runtime explicitly.
const React = await import('react')
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const {
  DOCUMENT_CHANGED_AFTER_OPEN,
  buildDocumentSaveRequest,
  loadDraftDocumentSnapshot,
  persistedDocumentRevision,
  readDocumentSaveFailure,
  reconcileCanonicalDraftRead,
  reconcilePersistedDocumentSnapshot,
  revisionFromSuccessfulDocumentSave,
} = await import('../components/document-drawer.tsx')

const DRAWER_SOURCE = readFileSync(new URL('../components/document-drawer.tsx', import.meta.url), 'utf8')
const EXPENSE_DRAWER_SOURCE = readFileSync(new URL('../app/(app)/expenses/ExpenseDrawer.tsx', import.meta.url), 'utf8')
const JOURNAL_DRAWER_SOURCE = readFileSync(new URL('../app/(app)/journal/JournalDrawer.tsx', import.meta.url), 'utf8')
const FIELD_TICKET_DRAWER_SOURCE = readFileSync(new URL('../app/(app)/field-tickets/FieldTicketDrawer.tsx', import.meta.url), 'utf8')
const OPENED_REVISION = '2026-08-24T12:34:56.123001Z'
const SAVED_REVISION = '2026-08-24T12:34:56.123999Z'
const CONCURRENT_REVISION = '2026-08-24T12:34:56.124777Z'
const FALLBACK_MESSAGE = 'save failed fallback'

// The three real interactive editors this slice fences. Their save routines
// are the exact functions the drawers' Save buttons execute.
const { saveExpenseReport } = await import('../app/(app)/expenses/ExpenseDrawer.tsx')
const { saveJournalDraft } = await import('../app/(app)/journal/JournalDrawer.tsx')
const { sendFieldTicketMutation } = await import('../app/(app)/field-tickets/FieldTicketDrawer.tsx')

type RecordedRequest = { path: string; method: string; body: Record<string, unknown> }

/** A fetch double standing in for the API's revision fence. Each handler gets
 *  the parsed request and answers with a status + JSON body. */
function scriptedServer(
  handlers: { match: (request: RecordedRequest) => boolean; respond: (request: RecordedRequest) => { status: number; body: unknown } }[],
): { transport: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  const transport = (async (path: string, init?: RequestInit) => {
    const request: RecordedRequest = {
      path: String(path),
      method: String(init?.method ?? 'GET'),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    }
    requests.push(request)
    const handler = handlers.find((candidate) => candidate.match(request))
    if (!handler) throw new Error(`unscripted request: ${request.method} ${request.path}`)
    const response = handler.respond(request)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { transport, requests }
}

/** The exact conflict contract every fenced route returns on a stale token
 *  (mirrors lib/documents DOCUMENT_EDIT_REVISION_CONFLICT). */
function staleConflict(): { status: number; body: unknown } {
  return { status: 409, body: { error: DOCUMENT_CHANGED_AFTER_OPEN } }
}

test('the drawer retains the exact persisted revision without wall-clock synthesis', () => {
  assert.equal(persistedDocumentRevision(OPENED_REVISION), OPENED_REVISION)
  for (const invalid of [
    undefined,
    null,
    '',
    '2026-08-24T12:34:56.123Z',
    new Date(OPENED_REVISION),
  ]) {
    assert.throws(() => persistedDocumentRevision(invalid), /DOCUMENT_REVISION_REQUIRED/)
  }
})

test('draft and correction saves forward the persisted revision as the sole token', () => {
  const payload = { memo: 'edited', expectedUpdatedAt: 'payload-must-not-override-persisted-state' }
  const draft = buildDocumentSaveRequest('doc-1', OPENED_REVISION, payload, false)
  assert.equal(draft.path, '/api/documents/doc-1')
  assert.equal(draft.method, 'PATCH')
  assert.equal(draft.body.expectedUpdatedAt, OPENED_REVISION)

  const correction = buildDocumentSaveRequest('doc-1', OPENED_REVISION, payload, true, 'controller reason')
  assert.equal(correction.path, '/api/documents/doc-1/correct')
  assert.equal(correction.method, 'POST')
  assert.equal(correction.body.expectedUpdatedAt, OPENED_REVISION)
  assert.equal(correction.body.amendmentReason, 'controller reason')
})

test('a successful draft save refreshes the next write revision from the persisted response', () => {
  const refreshed = revisionFromSuccessfulDocumentSave({
    doc: { updated_at: SAVED_REVISION },
  })
  assert.equal(refreshed, SAVED_REVISION)
  assert.equal(
    buildDocumentSaveRequest('doc-1', refreshed, { memo: 'second edit' }, false).body.expectedUpdatedAt,
    SAVED_REVISION,
  )
  assert.throws(() => revisionFromSuccessfulDocumentSave({ doc: {} }), /DOCUMENT_REVISION_REQUIRED/)
})

test('a clean refresh rehydrates form data and its exact token as one snapshot', () => {
  const opened = new Set([OPENED_REVISION])
  const current = { documentId: 'doc-1', revision: OPENED_REVISION, payload: { memo: 'A' } }
  const incoming = { documentId: 'doc-1', revision: SAVED_REVISION, payload: { memo: 'B' } }
  const refreshed = reconcilePersistedDocumentSnapshot(current, incoming, false, opened)
  assert.deepEqual(refreshed, { snapshot: incoming, rehydrate: true })
  assert.deepEqual(
    buildDocumentSaveRequest('doc-1', refreshed.snapshot.revision, refreshed.snapshot.payload, false).body,
    { memo: 'B', expectedUpdatedAt: SAVED_REVISION },
    'the next save cannot pair stale A form values with the newer B token',
  )
})

test('a dirty refresh retains its opened snapshot so a stale save conflicts', () => {
  const current = { documentId: 'doc-1', revision: OPENED_REVISION, payload: { memo: 'A' } }
  const incoming = { documentId: 'doc-1', revision: SAVED_REVISION, payload: { memo: 'external B' } }
  const retained = reconcilePersistedDocumentSnapshot(
    current,
    incoming,
    true,
    new Set([OPENED_REVISION]),
  )
  assert.deepEqual(retained, { snapshot: current, rehydrate: false })
  assert.equal(
    buildDocumentSaveRequest('doc-1', retained.snapshot.revision, { memo: 'local edit' }, false)
      .body.expectedUpdatedAt,
    OPENED_REVISION,
    'the stale editor must send the token it opened, not bless itself with the external token',
  )
})

test('cancel restores the saved baseline across delayed props and adopts an unseen refresh', () => {
  const saved = { documentId: 'doc-1', revision: SAVED_REVISION, payload: { memo: 'saved B' } }
  const delayed = { documentId: 'doc-1', revision: OPENED_REVISION, payload: { memo: 'old A' } }
  const retained = reconcilePersistedDocumentSnapshot(
    saved,
    delayed,
    false,
    new Set([OPENED_REVISION, SAVED_REVISION]),
  )
  assert.deepEqual(retained, { snapshot: saved, rehydrate: false })

  const externalRevision = '2026-08-24T12:34:56.124001Z'
  const external = { documentId: 'doc-1', revision: externalRevision, payload: { memo: 'external C' } }
  const adopted = reconcilePersistedDocumentSnapshot(
    saved,
    external,
    false,
    new Set([OPENED_REVISION, SAVED_REVISION]),
  )
  assert.deepEqual(adopted, { snapshot: external, rehydrate: true })
})

test('a stale save surfaces the server conflict instead of manufacturing a new token', async () => {
  const failure = await readDocumentSaveFailure(
    {
      status: 409,
      json: async () => ({ error: 'this document changed after you opened it' }),
    },
    'fallback',
  )
  assert.deepEqual(failure, {
    message: 'this document changed after you opened it',
    isConflict: true,
  })

  const save = DRAWER_SOURCE.slice(
    DRAWER_SOURCE.indexOf('async function save()'),
    DRAWER_SOURCE.indexOf('function cancel()'),
  )
  assert.match(save, /buildDocumentSaveRequest\([\s\S]*?documentRevision/)
  assert.match(
    save,
    /savedRevision = revisionFromSuccessfulDocumentSave\(data\)[\s\S]*?setDocumentRevision\(savedRevision\)/,
  )
  // Fleet-8 m1: save() runs on the shared action path — the never-throwing
  // read, the pin and the toast live in the package now. Same contract: the
  // server conflict surfaces verbatim and the save state goes 'error',
  // render-proved in document-drawer-save-refusal.test.tsx.
  assert.match(save, /await execute\([\s\S]*?fetchAction\(request\.path/)
  assert.match(save, /onRefused: \(\) => \{[\s\S]*?setSaveState\('error'\)/)
  assert.doesNotMatch(save, /readDocumentSaveFailure/)
  assert.doesNotMatch(save, /Date\.now|new Date\(/)
  assert.match(
    DRAWER_SOURCE,
    /reconcilePersistedDocumentSnapshot\([\s\S]*?resetForm\(decision\.snapshot\.payload\)/,
  )
  assert.match(
    DRAWER_SOURCE,
    /persistedBaseline\.current = \{[\s\S]*?payload: data[\s\S]*?resetForm\(data\)/,
  )
  assert.match(
    DRAWER_SOURCE,
    /function cancel\(\)[\s\S]*?reconcilePersistedDocumentSnapshot\([\s\S]*?resetForm\(decision\.snapshot\.payload\)/,
  )
})

// ---------------------------------------------------------------------------
// Interactive editors: the three real saves, driven end to end.
//
// fnd_mt8occ_ui01 — after OCC enforcement landed on the API routes, the
// expense/journal/field-ticket drawers kept saving without revision tokens,
// so every interactive save failed loudly with 409. Each test below drives
// the exact routine the drawer's Save button executes against a scripted
// transport that mirrors the routes' fence contract.
// ---------------------------------------------------------------------------

test('the expense drawer save sends its opened token and refreshes it from the save response', async () => {
  let storedRevision = OPENED_REVISION
  const { transport, requests } = scriptedServer([
    {
      match: (request) => request.method === 'PATCH' && request.path === '/api/expenses/exp-1',
      respond: (request) => {
        if (request.body.expectedUpdatedAt !== storedRevision) return staleConflict()
        storedRevision = SAVED_REVISION
        return {
          status: 200,
          body: { doc: { id: 'exp-1', memo: String(request.body.memo), updated_at: SAVED_REVISION }, lines: [] },
        }
      },
    },
  ])

  const first = await saveExpenseReport({
    documentId: 'exp-1',
    revision: OPENED_REVISION,
    payload: { memo: 'client lunch', lines: [{ accountId: 'acc-1', amount: '42.00' }] },
    fallbackMessage: FALLBACK_MESSAGE,
    transport,
  })

  assert.equal(first.status, 'saved')
  if (first.status !== 'saved') return
  assert.equal(first.revision, SAVED_REVISION, 'the next write token comes from the save response')
  assert.deepEqual(first.saved.doc.updated_at, SAVED_REVISION)
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.body.expectedUpdatedAt, OPENED_REVISION, 'the opened exact token rides the PATCH')
  assert.equal(requests[0]!.body.memo, 'client lunch')

  // A second save chains the refreshed token — never the one it opened with.
  const second = await saveExpenseReport({
    documentId: 'exp-1',
    revision: first.revision,
    payload: { memo: 'second edit' },
    fallbackMessage: FALLBACK_MESSAGE,
    transport,
  })
  assert.equal(second.status, 'saved')
  assert.equal(requests[1]!.body.expectedUpdatedAt, SAVED_REVISION)
})

test('the journal drawer save sends its opened token and refreshes it from the save response', async () => {
  let storedRevision = OPENED_REVISION
  const { transport, requests } = scriptedServer([
    {
      match: (request) => request.method === 'PATCH' && request.path === '/api/journals/je-1',
      respond: (request) => {
        if (request.body.expectedUpdatedAt !== storedRevision) return staleConflict()
        storedRevision = SAVED_REVISION
        return {
          status: 200,
          body: { doc: { id: 'je-1', memo: String(request.body.memo), updated_at: SAVED_REVISION }, lines: [] },
        }
      },
    },
  ])

  const first = await saveJournalDraft({
    documentId: 'je-1',
    revision: OPENED_REVISION,
    payload: { memo: 'accrual', referenceNumber: 'REF-9' },
    fallbackMessage: FALLBACK_MESSAGE,
    transport,
  })

  assert.equal(first.status, 'saved')
  if (first.status !== 'saved') return
  assert.equal(first.revision, SAVED_REVISION, 'the next write token comes from the save response')
  assert.equal(requests[0]!.method, 'PATCH')
  assert.equal(requests[0]!.path, '/api/journals/je-1')
  assert.equal(requests[0]!.body.expectedUpdatedAt, OPENED_REVISION)

  const second = await saveJournalDraft({
    documentId: 'je-1',
    revision: first.revision,
    payload: { memo: 'accrual v2' },
    fallbackMessage: FALLBACK_MESSAGE,
    transport,
  })
  assert.equal(second.status, 'saved')
  assert.equal(requests[1]!.body.expectedUpdatedAt, SAVED_REVISION)
})

test('the field-ticket drawer sends expectedRevision on header and grid saves and refreshes from each response', async () => {
  let storedRevision = OPENED_REVISION
  const ticketBody = () => ({
    id: 'ft-1',
    documentNumber: 'FT-0001',
    status: 'draft',
    documentDate: '2026-08-24',
    referenceNumber: null,
    memo: null,
    customerName: 'Customer',
    projectId: 'proj-1',
    projectName: 'Project',
    foremanName: 'Foreman',
    revision: storedRevision,
    fieldTicket: { period: 'weekly', periodStart: '2026-08-24', periodEnd: '2026-08-30', foremanPartyId: null },
    entries: [],
    lines: [],
    laborTotal: '0',
    linesTotal: '0',
    grandTotal: '0',
    links: [],
    billingRequests: [],
  })
  const { transport, requests } = scriptedServer([
    {
      match: (request) => request.path === '/api/field-tickets/ft-1',
      respond: (request) => {
        if (request.body.expectedRevision !== storedRevision) return staleConflict()
        storedRevision = SAVED_REVISION
        return { status: 200, body: ticketBody() }
      },
    },
  ])

  const header = await sendFieldTicketMutation({
    ticketId: 'ft-1',
    revision: OPENED_REVISION,
    method: 'PATCH',
    body: { memo: 'poured footings' },
    fallbackMessage: FALLBACK_MESSAGE,
    transport,
  })
  assert.equal(header.status, 'saved')
  assert.equal(header.revision, SAVED_REVISION, 'refreshed from the top-level revision the route returns')
  assert.equal(requests[0]!.method, 'PATCH')
  assert.equal(requests[0]!.path, '/api/field-tickets/ft-1')
  assert.equal(requests[0]!.body.expectedRevision, OPENED_REVISION, 'header save carries the exact token')
  assert.equal(requests[0]!.body.memo, 'poured footings')

  const grid = await sendFieldTicketMutation({
    ticketId: 'ft-1',
    revision: header.saved.revision,
    method: 'POST',
    body: { action: 'save-grid', rows: [] },
    fallbackMessage: FALLBACK_MESSAGE,
    transport,
  })
  assert.equal(grid.status, 'saved')
  assert.equal(requests[1]!.method, 'POST')
  assert.equal(requests[1]!.body.action, 'save-grid')
  assert.equal(requests[1]!.body.expectedRevision, SAVED_REVISION, 'grid save chains the refreshed token')
})

test('field-ticket multi-section saves fence each request with the prior response revision', () => {
  const call = FIELD_TICKET_DRAWER_SOURCE.slice(
    FIELD_TICKET_DRAWER_SOURCE.indexOf('async function call('),
    FIELD_TICKET_DRAWER_SOURCE.indexOf('async function saveHeader('),
  )
  assert.match(call, /revision: latestRevisionRef\.current/)
  assert.match(call, /latestRevisionRef\.current = result\.revision/)
  assert.doesNotMatch(call, /revision: ticket\.revision/)

  const saveAll = FIELD_TICKET_DRAWER_SOURCE.slice(
    FIELD_TICKET_DRAWER_SOURCE.indexOf('async function saveAll('),
    FIELD_TICKET_DRAWER_SOURCE.indexOf('async function submit('),
  )
  assert.match(saveAll, /await saveHeader\(\)[\s\S]*await saveGrid\(\)/)
})

test('a refused send-for-signature hands the server reason back instead of a fallback (F-t04-001)', async () => {
  // SIM Northstar has no email transport: the route 422s with the typed
  // FieldTicketError reason. The mutation must carry that reason to the
  // caller (toast + pinned dialog alert), never the generic fallback.
  const refusal = 'Email delivery is not configured — set it up in Admin → Email'
  const { transport, requests } = scriptedServer([
    {
      match: (request) => request.path === '/api/field-tickets/ft-1',
      respond: () => ({ status: 422, body: { error: refusal } }),
    },
  ])
  const result = await sendFieldTicketMutation({
    ticketId: 'ft-1',
    revision: OPENED_REVISION,
    method: 'POST',
    body: { action: 'send-signature', to: 'customer@example.test', message: null },
    fallbackMessage: FALLBACK_MESSAGE,
    transport,
  })
  assert.deepEqual(result, { status: 'error', message: refusal })
  assert.equal(requests[0]!.body.action, 'send-signature')
})

test('a refused send-for-signature pins as an alert in the send dialog (F-t04-001)', () => {
  // The toast alone expires and the failure read as silent: the send form
  // must pin the refused reason past it, and a retry must clear the stale pin.
  const sendForm = FIELD_TICKET_DRAWER_SOURCE.slice(
    FIELD_TICKET_DRAWER_SOURCE.indexOf('ft-send-to'),
    FIELD_TICKET_DRAWER_SOURCE.indexOf('editor.cancel'),
  )
  assert.match(
    sendForm,
    /\{ onErrorMessage: setSendError \}/,
    'a refused send must pin the server reason into dialog state',
  )
  assert.match(
    sendForm,
    /\{sendError \? \(\s*<p role="alert"/,
    'the pinned send refusal must render as a persistent alert in the send form',
  )
  assert.match(
    sendForm,
    /setSendError\(null\)/,
    'retrying the send must clear the stale refusal pin',
  )
  const call = FIELD_TICKET_DRAWER_SOURCE.slice(
    FIELD_TICKET_DRAWER_SOURCE.indexOf('async function call('),
    FIELD_TICKET_DRAWER_SOURCE.indexOf('async function saveHeader('),
  )
  assert.match(
    call,
    /options\.onErrorMessage\?\.?\(result\.message\)/,
    'call must forward the refused reason to the pinning sink as well as the toast',
  )
})

test('each editor surfaces a genuinely stale token as the server 409 and never retries or re-mints a token', async () => {
  // The server holds CONCURRENT_REVISION; every editor only holds OPENED_REVISION.
  const { transport: conflictTransport } = scriptedServer([
    {
      match: () => true,
      respond: (request) =>
        request.body.expectedUpdatedAt === CONCURRENT_REVISION || request.body.expectedRevision === CONCURRENT_REVISION
          ? { status: 200, body: {} }
          : staleConflict(),
    },
  ])

  const expense = await saveExpenseReport({
    documentId: 'exp-1',
    revision: OPENED_REVISION,
    payload: { memo: 'stale' },
    fallbackMessage: FALLBACK_MESSAGE,
    transport: conflictTransport,
  })
  assert.deepEqual(expense, { status: 'conflict', message: DOCUMENT_CHANGED_AFTER_OPEN })

  const journal = await saveJournalDraft({
    documentId: 'je-1',
    revision: OPENED_REVISION,
    payload: { memo: 'stale' },
    fallbackMessage: FALLBACK_MESSAGE,
    transport: conflictTransport,
  })
  assert.deepEqual(journal, { status: 'conflict', message: DOCUMENT_CHANGED_AFTER_OPEN })

  const ticket = await sendFieldTicketMutation({
    ticketId: 'ft-1',
    revision: OPENED_REVISION,
    method: 'PATCH',
    body: { memo: 'stale' },
    fallbackMessage: FALLBACK_MESSAGE,
    transport: conflictTransport,
  })
  assert.deepEqual(ticket, { status: 'conflict', message: DOCUMENT_CHANGED_AFTER_OPEN })

  // A missing token can never be manufactured client-side either.
  assert.throws(
    () =>
      buildDocumentSaveRequest('exp-1', '2026-08-24T12:34:56.123Z', { memo: 'lossy' }, false),
    /DOCUMENT_REVISION_REQUIRED/,
  )
})

test('the canonical snapshot loader pins the exact GET token and refuses lossy ones', async () => {
  const good = scriptedServer([
    {
      match: (request) => request.method === 'GET' && request.path === '/api/expenses/exp-1',
      respond: () => ({
        status: 200,
        body: { doc: { id: 'exp-1', memo: 'server state', updated_at: CONCURRENT_REVISION }, lines: [] },
      }),
    },
  ])
  const snapshot = await loadDraftDocumentSnapshot('/api/expenses/exp-1', FALLBACK_MESSAGE, good.transport)
  assert.deepEqual(snapshot, {
    documentId: 'exp-1',
    revision: CONCURRENT_REVISION,
    payload: { doc: { id: 'exp-1', memo: 'server state', updated_at: CONCURRENT_REVISION }, lines: [] },
  })

  const lossy = scriptedServer([
    {
      match: () => true,
      respond: () => ({ status: 200, body: { doc: { id: 'exp-1', updated_at: new Date(CONCURRENT_REVISION) }, lines: [] } }),
    },
  ])
  await assert.rejects(
    loadDraftDocumentSnapshot('/api/expenses/exp-1', FALLBACK_MESSAGE, lossy.transport),
    /DOCUMENT_REVISION_REQUIRED/,
  )

  const broken = scriptedServer([{ match: () => true, respond: () => ({ status: 500, body: {} }) }])
  await assert.rejects(
    loadDraftDocumentSnapshot('/api/expenses/exp-1', FALLBACK_MESSAGE, broken.transport),
    new RegExp(`^Error: ${FALLBACK_MESSAGE}$`),
  )
})

test('a canonical read adopts clean editors, pins unchanged dirty content, and conflicts on drifted content', () => {
  const current = {
    documentId: 'exp-1',
    revision: OPENED_REVISION,
    payload: { doc: { id: 'exp-1', memo: 'opened', updated_at: new Date(OPENED_REVISION) }, lines: [] },
  }
  const sameContent = {
    documentId: 'exp-1',
    revision: CONCURRENT_REVISION,
    payload: { doc: { id: 'exp-1', memo: 'opened', updated_at: CONCURRENT_REVISION }, lines: [] },
  }
  const movedOn = {
    documentId: 'exp-1',
    revision: CONCURRENT_REVISION,
    payload: { doc: { id: 'exp-1', memo: 'edited elsewhere', updated_at: CONCURRENT_REVISION }, lines: [] },
  }

  assert.deepEqual(
    reconcileCanonicalDraftRead({ current, incoming: movedOn, isDirty: false }),
    { action: 'adopt', snapshot: movedOn },
  )
  // Dirty but nothing actually changed server-side (only Date→token shape):
  // keep the edits, take the exact token.
  assert.deepEqual(
    reconcileCanonicalDraftRead({ current, incoming: sameContent, isDirty: true }),
    { action: 'pin', revision: CONCURRENT_REVISION },
  )
  // Dirty AND the record moved: blessing stale edits with the newer token
  // would recreate silent last-write-wins.
  assert.deepEqual(
    reconcileCanonicalDraftRead({ current, incoming: movedOn, isDirty: true }),
    { action: 'conflict', snapshot: movedOn },
  )
})

test('every interactive editor wires the shared fence through its real Save path', () => {
  // Expense + journal go through the shared builder; the field ticket names
  // its route's own expectedRevision key.
  for (const [source, routine] of [
    [EXPENSE_DRAWER_SOURCE, 'saveExpenseReport'],
    [JOURNAL_DRAWER_SOURCE, 'saveJournalDraft'],
  ] as const) {
    assert.match(source, new RegExp(`buildDocumentSaveRequest\\([\\s\\S]*?revision`), `${routine} builds through the shared builder`)
    assert.match(source, new RegExp(`${routine}\\(`), 'the Save button executes the exported fenced routine')
  }
  assert.match(FIELD_TICKET_DRAWER_SOURCE, /expectedRevision: persistedDocumentRevision\(input\.revision\)/)
  assert.match(FIELD_TICKET_DRAWER_SOURCE, /sendFieldTicketMutation\(/)
  assert.match(
    FIELD_TICKET_DRAWER_SOURCE,
    /result\.status === 'conflict'[\s\S]{0,120}reloadTicketAfterConflict/,
    '409 triggers the reload flow',
  )
})

test('the check form exposes an optional payee and the funding bank without mandating a party', () => {
  // F-t05-008: the standalone check form had no payee and no bank-account
  // field although the record model has both. The payee must stay optional
  // (partyRole null: the submit gate and the server edit guard key off it),
  // so anonymous expense checks keep saving and posting.
  assert.equal(DOC_KINDS.check!.partyRole, null)
  assert.equal(DOC_KINDS.check!.optionalPartyRole, 'vendor')
  assert.equal(DOC_KINDS.check!.fundingSource, 'bank')
  // The fallback party picker renders from the optional-aware role, while
  // the submit requirement stays on the mandatory role alone.
  assert.match(DRAWER_SOURCE, /\{pickerPartyRole \? \(/)
  assert.match(DRAWER_SOURCE, /disabled=\{busy \|\| \(config\.partyRole \? !partyId : false\)/)
  // The funding-bank block covers every bank-funded kind (check + deposit),
  // labelled per kind from existing catalog copy.
  assert.match(DRAWER_SOURCE, /\{config\.fundingSource === 'bank' \? \(/)
  assert.ok(!DRAWER_SOURCE.includes("{config.kind === 'deposit' ? ("))
})

test('the card picker falls back to the card-liability account when no instruments exist', () => {
  // F-t05-020: the card picker lists payment_cards instruments, but no UI
  // creates one — with zero instruments the picker is unfillable. When no
  // instruments exist the drawer must offer the reconcilable card-liability
  // accounts (the controlAccountId override the engine cardRule reads
  // first), with an explicit empty state naming what qualifies when those
  // are absent too.
  assert.match(DRAWER_SOURCE, /cardAccounts/)
  assert.match(DRAWER_SOURCE, /controlAccountId/)
  assert.match(DRAWER_SOURCE, /drawer\.cardAccountHelp/)
  assert.match(DRAWER_SOURCE, /drawer\.noCardAccounts/)
  assert.match(DRAWER_SOURCE, /<Link href="\/accounts"/)
})

test('the funding-bank picker names the empty-data state with a Banking link', () => {
  // F-t05-008 follow-up: SIM Northstar has zero bank accounts, so the
  // From-account picker opened with only a disabled 'No matches' and no
  // search — indistinguishable from a broken source. An empty bank list
  // must render an explicit empty state pointing at Banking instead.
  assert.match(DRAWER_SOURCE, /\(bankAccounts \?\? accounts\)\.length > 0 \? \(/)
  assert.match(DRAWER_SOURCE, /drawer\.noBankAccounts/)
  assert.match(DRAWER_SOURCE, /drawer\.noBankAccountsCta/)
  assert.match(DRAWER_SOURCE, /<Link href="\/banking"/)
})
