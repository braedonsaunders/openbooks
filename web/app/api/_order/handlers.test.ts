import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { registerHooks } from 'node:module'
import test from 'node:test'

const ORG_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = '00000000-0000-4000-8000-000000000002'
const DOCUMENT_ID = '00000000-0000-4000-8000-000000000003'
const PARTY_ID = '00000000-0000-4000-8000-000000000004'

interface SqlQuery {
  readonly __orderTestSql: true
  readonly strings: string[]
  readonly values: unknown[]
}

interface OrderDocument {
  id: string
  orgId: string
  kind: 'quote'
  status: string
  documentNumber: string
  documentDate: string
  partyId: string
  total: string
  memo: string
  voidRequestedAt: string | null
}

interface TransactionContext {
  ownsLock: boolean
  dirty: boolean
  snapshot: {
    document: OrderDocument
    auditLog: Record<string, unknown>[]
    flowEffects: Record<string, unknown>[]
    deleted: boolean
  }
}

interface PauseControl {
  entered: Promise<void>
  release: () => void
}

interface InternalPauseControl extends PauseControl {
  claimed: boolean
  signalEntered: () => void
  waitForRelease: Promise<void>
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class OrderRouteHarness {
  document!: OrderDocument
  auditLog: Record<string, unknown>[] = []
  flowEffects: Record<string, unknown>[] = []
  submitCalls = 0
  voidCalls = 0
  lockAttempts = 0
  headerWrites = 0
  deleteCalls = 0
  deleted = false
  voidFailure: string | null = null

  private readonly transactions = new AsyncLocalStorage<TransactionContext>()
  private lockHeld = false
  private readonly lockWaiters: Array<() => void> = []
  private submitPause: InternalPauseControl | null = null
  private voidPause: InternalPauseControl | null = null

  constructor() {
    this.reset('draft')
  }

  reset(status: 'draft' | 'approved'): void {
    assert.equal(this.lockHeld, false, 'the prior route request must release its document lock')
    assert.equal(this.lockWaiters.length, 0, 'the prior route request must release every waiter')
    this.document = {
      id: DOCUMENT_ID,
      orgId: ORG_ID,
      kind: 'quote',
      status,
      documentNumber: 'Q-LOCK-001',
      documentDate: '2026-08-24',
      partyId: PARTY_ID,
      total: '100.00',
      memo: 'original memo',
      voidRequestedAt: null,
    }
    this.auditLog = []
    this.flowEffects = []
    this.submitCalls = 0
    this.voidCalls = 0
    this.lockAttempts = 0
    this.headerWrites = 0
    this.deleteCalls = 0
    this.deleted = false
    this.voidFailure = null
    this.submitPause = null
    this.voidPause = null
  }

  sql(strings: TemplateStringsArray, values: unknown[]): SqlQuery {
    return {
      __orderTestSql: true,
      strings: Array.from(strings),
      values,
    }
  }

  async execute(query: SqlQuery): Promise<{ rows: Record<string, unknown>[] }> {
    const { text, params } = this.compile(query)
    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.startsWith('select status, document_date from documents')) {
      return {
        rows: this.matchesDocument(params)
          ? [{ status: this.document.status, document_date: this.document.documentDate }]
          : [],
      }
    }

    if (normalized.startsWith('select status, party_id, total from documents')) {
      if (normalized.endsWith('for update')) await this.acquireDocumentLock()
      return {
        rows: this.matchesDocument(params)
          ? [{
              status: this.document.status,
              party_id: this.document.partyId,
              total: this.document.total,
            }]
          : [],
      }
    }

    // Pre-fix handlers loaded issue eligibility in a separate unlocked query.
    // Supporting it here lets the mutation check reach the race itself instead
    // of failing merely because that obsolete query shape is unknown.
    if (normalized.startsWith('select party_id, total from documents')) {
      return {
        rows: params[0] === this.document.id && params[1] === this.document.orgId
          ? [{ party_id: this.document.partyId, total: this.document.total }]
          : [],
      }
    }

    if (normalized.startsWith('select status from documents')) {
      if (normalized.endsWith('for update')) await this.acquireDocumentLock()
      return {
        rows: this.matchesDocument(params) ? [{ status: this.document.status }] : [],
      }
    }

    if (normalized.startsWith('select 1 from documents')) {
      if (normalized.endsWith('for update')) await this.acquireDocumentLock()
      return { rows: this.matchesDocument(params) ? [{ exists: 1 }] : [] }
    }

    if (normalized.startsWith('update documents set')) {
      this.markTransactionDirty()
      const memo = normalized.match(/\bmemo = __p(\d+)__/)
      if (memo) this.document.memo = String(params[Number(memo[1])])
      this.headerWrites += 1
      return { rows: [] }
    }

    throw new Error(`unexpected order handler query: ${normalized}`)
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactions.getStore()) return work()

    const context: TransactionContext = {
      ownsLock: false,
      dirty: false,
      snapshot: {
        document: { ...this.document },
        auditLog: this.auditLog.map((row) => ({ ...row })),
        flowEffects: this.flowEffects.map((row) => ({ ...row })),
        deleted: this.deleted,
      },
    }

    return this.transactions.run(context, async () => {
      try {
        return await work()
      } catch (error) {
        if (context.dirty) {
          this.document = { ...context.snapshot.document }
          this.auditLog = context.snapshot.auditLog.map((row) => ({ ...row }))
          this.flowEffects = context.snapshot.flowEffects.map((row) => ({ ...row }))
          this.deleted = context.snapshot.deleted
        }
        throw error
      } finally {
        if (context.ownsLock) this.releaseDocumentLock()
      }
    })
  }

  pauseNextSubmit(): PauseControl {
    const entered = deferred()
    const released = deferred()
    this.submitPause = {
      claimed: false,
      entered: entered.promise,
      signalEntered: entered.resolve,
      release: released.resolve,
      waitForRelease: released.promise,
    }
    return this.submitPause
  }

  pauseNextVoid(): PauseControl {
    const entered = deferred()
    const released = deferred()
    this.voidPause = {
      claimed: false,
      entered: entered.promise,
      signalEntered: entered.resolve,
      release: released.resolve,
      waitForRelease: released.promise,
    }
    return this.voidPause
  }

  async submit(): Promise<{
    gated: false
    runId: null
    flowError: null
    autoApproved: true
  }> {
    this.submitCalls += 1
    await this.holdClaimedPause(this.submitPause)
    if (this.document.status !== 'draft') {
      throw new Error(`document is ${this.document.status}, not draft`)
    }
    this.markTransactionDirty()
    this.document.status = 'approved'
    return { gated: false, runId: null, flowError: null, autoApproved: true }
  }

  async requestVoid(): Promise<
    | { status: 'voided'; reversalEntryId: null; runId: null }
    | { failure: string }
  > {
    this.voidCalls += 1
    await this.holdClaimedPause(this.voidPause)
    if (this.document.status !== 'approved' || this.document.voidRequestedAt) {
      return { failure: 'the order changed while the void request was being created' }
    }

    this.markTransactionDirty()
    this.document.voidRequestedAt = '2026-08-24T12:00:00.000Z'
    this.auditLog.push({ action: 'void_requested', documentId: this.document.id })
    this.flowEffects.push({ kind: 'before_void', documentId: this.document.id })
    if (this.voidFailure) {
      // Production clears the reservation before surfacing a flow failure.
      // Audit/flow rows still rely on the surrounding transaction rollback.
      this.document.voidRequestedAt = null
      return { failure: this.voidFailure }
    }

    this.document.status = 'voided'
    return { status: 'voided', reversalEntryId: null, runId: null }
  }

  async deleteDocument(): Promise<
    | { documentId: string }
    | { failure: string }
  > {
    this.deleteCalls += 1
    if (this.deleted) return { failure: 'document not found' }
    if (this.document.status !== 'draft') {
      return {
        failure: `${this.document.documentNumber} is ${this.document.status} and cannot be deleted — use the controlled void/cancel action`,
      }
    }

    // Production checks draft status in an unlocked SELECT, then its DELETE
    // statement acquires the row lock. Without the route-level lock, issuance
    // can commit while this command waits and the unconditional DELETE wins.
    await this.acquireDocumentLock()
    this.markTransactionDirty()
    this.deleted = true
    return { documentId: this.document.id }
  }

  loadOrder(): Record<string, unknown> {
    return {
      doc: {
        id: this.document.id,
        status: this.document.status,
        document_date: this.document.documentDate,
        party_id: this.document.partyId,
        total: this.document.total,
        memo: this.document.memo,
      },
      lines: [],
      links: [],
    }
  }

  private compile(query: SqlQuery): { text: string; params: unknown[] } {
    const params: unknown[] = []
    const render = (fragment: SqlQuery): string => {
      let text = fragment.strings[0] ?? ''
      for (let index = 0; index < fragment.values.length; index += 1) {
        const value = fragment.values[index]
        if (this.isSqlQuery(value)) {
          text += render(value)
        } else {
          text += `__P${params.push(value) - 1}__`
        }
        text += fragment.strings[index + 1] ?? ''
      }
      return text
    }
    return { text: render(query), params }
  }

  private isSqlQuery(value: unknown): value is SqlQuery {
    return Boolean(
      value
      && typeof value === 'object'
      && (value as Partial<SqlQuery>).__orderTestSql,
    )
  }

  private matchesDocument(params: unknown[]): boolean {
    return !this.deleted
      && params[0] === this.document.id
      && params[1] === this.document.kind
      && params[2] === this.document.orgId
  }

  private async acquireDocumentLock(): Promise<void> {
    const context = this.transactions.getStore()
    if (!context) throw new Error('SELECT FOR UPDATE must run inside the route transaction')
    if (context.ownsLock) return

    this.lockAttempts += 1
    if (this.lockHeld) {
      await new Promise<void>((resolve) => this.lockWaiters.push(resolve))
    } else {
      this.lockHeld = true
    }
    context.ownsLock = true
  }

  private releaseDocumentLock(): void {
    const next = this.lockWaiters.shift()
    if (next) next()
    else this.lockHeld = false
  }

  private markTransactionDirty(): void {
    const context = this.transactions.getStore()
    if (context) context.dirty = true
  }

  private async holdClaimedPause(pause: InternalPauseControl | null): Promise<void> {
    if (!pause || pause.claimed) return
    pause.claimed = true
    pause.signalEntered()
    await pause.waitForRelease
  }
}

const harnessKey = Symbol.for('openbooks.order-route-concurrency-test')
const harness = new OrderRouteHarness()
;(globalThis as typeof globalThis & Record<symbol, unknown>)[harnessKey] = harness

const stateExpression = `globalThis[Symbol.for('openbooks.order-route-concurrency-test')]`
const mockSources = new Map<string, string>([
  ['mock:next-server', `
    export class NextResponse extends Response {
      static json(body, init = {}) {
        const headers = new Headers(init.headers)
        if (!headers.has('content-type')) headers.set('content-type', 'application/json')
        return new NextResponse(JSON.stringify(body), { ...init, headers })
      }
    }
  `],
  ['mock:drizzle', `
    const state = ${stateExpression}
    export function sql(strings, ...values) { return state.sql(strings, values) }
  `],
  ['mock:db', `
    const state = ${stateExpression}
    export const db = {
      execute(query) { return state.execute(query) },
      transaction(callback) { return state.transaction(() => callback(db)) },
    }
    export function withOrgTransaction(_orgId, callback) {
      return state.transaction(callback)
    }
  `],
  ['mock:document-delete', `
    const state = ${stateExpression}
    export class DeleteError extends Error {}
    export async function deleteDocument() {
      return state.transaction(async () => {
        const result = await state.deleteDocument()
        if ('failure' in result) throw new DeleteError(result.failure)
        return result
      })
    }
  `],
  ['mock:feature-gates', `
    export async function guardFeaturePermission() {
      return { user: { orgId: '${ORG_ID}', id: '${USER_ID}' } }
    }
  `],
  ['mock:order-cycle', `
    export class ConversionError extends Error {
      constructor(message, status = 422) { super(message); this.status = status }
    }
    export async function convertOrder() { return {} }
  `],
  ['mock:order-lib', `
    const state = ${stateExpression}
    export function computeOrderTotals() {
      return { lines: [], subtotal: '0', taxTotal: '0', total: '0' }
    }
    export function exactOrderMoney(value) { return String(value) }
    export function exactOrderQuantity(value) { return String(value) }
    export function loadOrder() { return state.loadOrder() }
    export async function orderTaxProfileMap() { return new Map() }
  `],
  ['mock:money', `
    export function cmp(left, right) { return Math.sign(Number(left) - Number(right)) }
    export function toUnits(value) { return BigInt(Math.round(Number(value) * 100000000)) }
  `],
  ['mock:exact-decimal', `
    export function compareDecimal(left, right) { return Math.sign(Number(left) - Number(right)) }
  `],
  ['mock:bills', `export async function persistLineTaxComponents() { return undefined }`],
  ['mock:segments', `
    export async function segmentRegistry() { return [] }
    export function validateExtraDims(value) { return { ok: true, cleaned: value ?? {} } }
  `],
  ['mock:crm', `export async function promoteCrmAccount() { return undefined }`],
  ['mock:features', `
    export async function isFeatureEnabled() { return true }
    export async function subsidiaryFeatureEnabled() { return true }
  `],
  ['mock:flows', `
    const state = ${stateExpression}
    export async function submitAndReleaseIfUngated() { return state.submit() }
  `],
  ['mock:document-void', `
    const state = ${stateExpression}
    export class DocumentVoidError extends Error {}
    export async function requestDocumentVoid() {
      return state.transaction(async () => {
        const result = await state.requestVoid()
        if ('failure' in result) throw new DocumentVoidError(result.failure)
        return result
      })
    }
  `],
  ['mock:json', `
    export const jsonObject = {}
    export async function parseJsonBody(request) {
      try { return { ok: true, data: await request.json() } }
      catch { return { ok: false, response: Response.json({ error: 'invalid JSON' }, { status: 400 }) } }
    }
  `],
])

const resolutionMocks = new Map<string, string>([
  ['next/server', 'mock:next-server'],
  ['drizzle-orm', 'mock:drizzle'],
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@openbooks/engine/src/document-delete.ts', 'mock:document-delete'],
  ['../../../lib/feature-gates', 'mock:feature-gates'],
  ['../../../lib/order-cycle', 'mock:order-cycle'],
  ['./lib', 'mock:order-lib'],
  ['@openbooks/engine/src/money.ts', 'mock:money'],
  ['../../../lib/exact-decimal', 'mock:exact-decimal'],
  ['../../../lib/bills', 'mock:bills'],
  ['../../../lib/segments', 'mock:segments'],
  ['@openbooks/engine/src/crm.ts', 'mock:crm'],
  ['../../../lib/features', 'mock:features'],
  ['@openbooks/engine/src/flows/index.ts', 'mock:flows'],
  ['@openbooks/engine/src/document-void.ts', 'mock:document-void'],
  ['@/lib/api/json', 'mock:json'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mock = resolutionMocks.get(specifier)
    return mock ? { url: mock, shortCircuit: true } : nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    return source === undefined
      ? nextLoad(url, context)
      : { format: 'module', source, shortCircuit: true }
  },
})

const handlerUrl = './handlers.ts?order-route-concurrency-test'
const { makeDELETE, makePATCH } = await import(handlerUrl) as typeof import('./handlers.ts')
hooks.deregister()

const PATCH = makePATCH({ kind: 'quote', readPerm: 'ar.read', createPerm: 'ar.create' })
const DELETE = makeDELETE({ kind: 'quote', readPerm: 'ar.read', createPerm: 'ar.create' })

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/estimates/${DOCUMENT_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: DOCUMENT_ID }) },
  )
}

function discard(): Promise<Response> {
  return DELETE(
    new Request(`http://openbooks.test/api/estimates/${DOCUMENT_ID}`, {
      method: 'DELETE',
    }),
    { params: Promise.resolve({ id: DOCUMENT_ID }) },
  )
}

async function waitForConcurrentPath(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail(`timed out waiting for ${description}`)
}

function fulfilledResponse(result: PromiseSettledResult<Response>, label: string): Response {
  assert.equal(
    result.status,
    'fulfilled',
    `${label} rejected: ${result.status === 'rejected' ? String(result.reason) : ''}`,
  )
  return result.value
}

test('issuing serializes a stale draft replacement and rejects it after approval', async () => {
  harness.reset('draft')
  const control = harness.pauseNextSubmit()
  const issue = patch({ status: 'approved' })
  await control.entered

  const staleEdit = patch({ memo: 'stale concurrent memo' })
  try {
    await waitForConcurrentPath(
      () => harness.lockAttempts >= 2 || harness.headerWrites > 0,
      'the stale edit to reach the lifecycle boundary',
    )
  } finally {
    control.release()
  }

  const [issueResult, editResult] = await Promise.allSettled([issue, staleEdit])
  const issueResponse = fulfilledResponse(issueResult, 'issue request')
  const editResponse = fulfilledResponse(editResult, 'stale edit request')
  assert.equal(issueResponse.status, 200)
  assert.equal(editResponse.status, 422)
  assert.deepEqual(await editResponse.json(), { error: 'only draft orders can be edited' })
  assert.equal(harness.document.status, 'approved')
  assert.equal(harness.document.memo, 'original memo')
  assert.equal(harness.headerWrites, 0)
})

test('issuing serializes draft discard and prevents deletion of the issued order', async () => {
  harness.reset('draft')
  const control = harness.pauseNextSubmit()
  const issue = patch({ status: 'approved' })
  await control.entered

  const deleteRequest = discard()
  let deleteCallsWhileIssueHeldTheLock = 0
  try {
    await waitForConcurrentPath(
      () => harness.lockAttempts >= 2 || harness.deleteCalls > 0,
      'draft discard to reach the lifecycle boundary',
    )
    deleteCallsWhileIssueHeldTheLock = harness.deleteCalls
  } finally {
    control.release()
  }

  const settled = await Promise.allSettled([issue, deleteRequest])
  const issueResponse = fulfilledResponse(settled[0], 'issue request')
  const deleteResponse = fulfilledResponse(settled[1], 'draft discard request')
  assert.equal(deleteCallsWhileIssueHeldTheLock, 0)
  assert.deepEqual([issueResponse.status, deleteResponse.status], [200, 422])
  assert.deepEqual(await deleteResponse.json(), {
    error: 'Q-LOCK-001 is approved and cannot be deleted — use the controlled void/cancel action',
  })
  assert.equal(harness.deleteCalls, 1)
  assert.equal(harness.deleted, false)
  assert.equal(harness.document.status, 'approved')
})

test('two concurrent issue requests perform one lifecycle transition', async () => {
  harness.reset('draft')
  const control = harness.pauseNextSubmit()
  const first = patch({ status: 'approved' })
  await control.entered

  const second = patch({ status: 'approved' })
  try {
    await waitForConcurrentPath(
      () => harness.lockAttempts >= 2 || harness.submitCalls >= 2,
      'the duplicate issue request to reach the lifecycle boundary',
    )
  } finally {
    control.release()
  }

  const settled = await Promise.allSettled([first, second])
  const firstResponse = fulfilledResponse(settled[0], 'first issue request')
  const secondResponse = fulfilledResponse(settled[1], 'duplicate issue request')
  assert.deepEqual([firstResponse.status, secondResponse.status], [200, 422])
  assert.deepEqual(await secondResponse.json(), { error: 'only a draft can be issued' })
  assert.equal(harness.submitCalls, 1)
  assert.equal(harness.document.status, 'approved')
})

test('two concurrent void requests serialize before the void command and reject the duplicate', async () => {
  harness.reset('approved')
  const control = harness.pauseNextVoid()
  const first = patch({ status: 'voided', reason: 'customer cancelled' })
  await control.entered

  const second = patch({ status: 'voided', reason: 'duplicate request' })
  let callsWhileTheFirstLockWasHeld = 0
  try {
    await waitForConcurrentPath(
      () => harness.lockAttempts >= 2 || harness.voidCalls >= 2,
      'the duplicate void request to reach the lifecycle boundary',
    )
    callsWhileTheFirstLockWasHeld = harness.voidCalls
  } finally {
    control.release()
  }

  const settled = await Promise.allSettled([first, second])
  const firstResponse = fulfilledResponse(settled[0], 'first void request')
  const secondResponse = fulfilledResponse(settled[1], 'duplicate void request')
  assert.equal(callsWhileTheFirstLockWasHeld, 1)
  assert.deepEqual([firstResponse.status, secondResponse.status], [200, 422])
  assert.deepEqual(await secondResponse.json(), { error: 'already voided' })
  assert.equal(harness.voidCalls, 1)
  assert.equal(harness.document.status, 'voided')
  assert.equal(harness.auditLog.length, 1)
  assert.equal(harness.flowEffects.length, 1)
})

test('a caught void failure rolls back its audit and flow effects before returning 422', async () => {
  harness.reset('approved')
  harness.voidFailure = 'void approval routing failed; the document was not voided'

  const response = await patch({ status: 'voided', reason: 'customer cancelled' })

  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), { error: harness.voidFailure })
  assert.equal(harness.document.status, 'approved')
  assert.equal(harness.document.voidRequestedAt, null)
  assert.deepEqual(harness.auditLog, [])
  assert.deepEqual(harness.flowEffects, [])
})
