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
  /** Optimistic-concurrency token (documents.updated_at). */
  updatedAt: string
  voidRequestedAt: string | null
  subsidiaryId?: string | null
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
  voidReservations = 0
  beforeVoidCalls = 0
  beforeVoidInsideTransaction = 0
  lockAttempts = 0
  headerWrites = 0
  deleteCalls = 0
  convertCalls = 0
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
      updatedAt: '2026-08-24T12:00:00.000Z',
      voidRequestedAt: null,
      subsidiaryId: null,
    }
    this.auditLog = []
    this.flowEffects = []
    this.submitCalls = 0
    this.voidCalls = 0
    this.voidReservations = 0
    this.beforeVoidCalls = 0
    this.beforeVoidInsideTransaction = 0
    this.lockAttempts = 0
    this.headerWrites = 0
    this.deleteCalls = 0
    this.convertCalls = 0
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

    if (normalized.startsWith('select status, document_date, subsidiary_id as "subsidiaryid"')) {
      return {
        rows: this.matchesDocument(params)
          ? [{
              status: this.document.status,
              document_date: this.document.documentDate,
              updated_at: this.document.updatedAt,
            }]
          : [],
      }
    }

    // The record-boundary scope probes (PATCH/GET existence, DELETE lock,
    // convert ownership) resolve the row's subsidiary alongside org scope.
    if (normalized.startsWith('select subsidiary_id as "subsidiaryid"')) {
      if (normalized.endsWith('for update')) await this.acquireDocumentLock()
      return {
        rows: this.matchesDocument(params)
          ? [{ subsidiary_id: this.document.subsidiaryId ?? null, updated_at: this.document.updatedAt }]
          : [],
      }
    }

    if (normalized.startsWith('select status, party_id, total')) {
      if (normalized.endsWith('for update')) await this.acquireDocumentLock()
      return {
        rows: this.matchesDocument(params)
          ? [{
              status: this.document.status,
              party_id: this.document.partyId,
              total: this.document.total,
              updated_at: this.document.updatedAt,
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

    if (normalized.startsWith('select status, updated_at from documents')) {
      if (normalized.endsWith('for update')) await this.acquireDocumentLock()
      return {
        rows: this.matchesDocument(params)
          ? [{ status: this.document.status, updated_at: this.document.updatedAt }]
          : [],
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

  async requestVoid(input: { expectedUpdatedAt?: string | null } = {}): Promise<
    | { status: 'voided'; reversalEntryId: null; runId: null }
    | { failure: string }
  > {
    this.voidCalls += 1
    // Models requestDocumentVoid: load, refuse a stale exact-revision token,
    // then take the conditional UPDATE claim that owns the row before any
    // before_void effect.
    const expected = input.expectedUpdatedAt
    if (
      expected == null ||
      Number.isNaN(new Date(expected).getTime()) ||
      new Date(expected).getTime() !== new Date(this.document.updatedAt).getTime()
    ) {
      return { failure: 'this document changed after you opened it; reload and review the latest revision' }
    }
    await this.acquireDocumentLock()
    if (this.document.status !== 'approved' || this.document.voidRequestedAt) {
      return { failure: 'the order changed while the void request was being created' }
    }

    this.markTransactionDirty()
    this.voidReservations += 1
    this.document.voidRequestedAt = '2026-08-24T12:00:00.000Z'
    this.auditLog.push({ action: 'void_requested', documentId: this.document.id })
    await this.holdClaimedPause(this.voidPause)
    await this.beforeVoid()
    this.flowEffects.push({ kind: 'before_void', documentId: this.document.id })
    if (this.voidFailure) {
      // Throwing at the boundary rolls the reservation, audit, script, and
      // flow effects back as one unit.
      return { failure: this.voidFailure }
    }

    this.document.status = 'voided'
    return { status: 'voided', reversalEntryId: null, runId: null }
  }

  async beforeVoid(): Promise<void> {
    this.beforeVoidCalls += 1
    if (this.transactions.getStore()) this.beforeVoidInsideTransaction += 1
    await new Promise<void>((resolve) => setImmediate(resolve))
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
  ['mock:authz', `
    export function guardSubsidiaryScope() { return null }
  `],
  ['mock:order-cycle', `
    const state = ${stateExpression}
    export class ConversionError extends Error {
      constructor(message, status = 422) { super(message); this.status = status }
    }
    export async function convertOrder() {
      state.convertCalls += 1
      return { kind: 'sales_order', id: '60000000-0000-4000-8000-000000000001', documentNumber: 'SO-CVT-1' }
    }
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
    export async function requestDocumentVoid(input) {
      return state.transaction(async () => {
        const result = await state.requestVoid(input)
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
  ['../../../lib/authz', 'mock:authz'],
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
const { makeDELETE, makePATCH, makeConvertPOST } = await import(handlerUrl) as typeof import('./handlers.ts')
hooks.deregister()

const PATCH = makePATCH({ kind: 'quote', readPerm: 'ar.read', createPerm: 'ar.create' })
const DELETE = makeDELETE({ kind: 'quote', readPerm: 'ar.read', createPerm: 'ar.create' })
const CONVERT = makeConvertPOST({ kind: 'quote', readPerm: 'ar.read', createPerm: 'ar.create' })

/**
 * Build a mutating request. The revision token defaults to the harness
 * document's CURRENT updated_at (what a fresh UI would echo); tests opt into
 * a missing (`null`) or stale token explicitly.
 */
function revisionToken(opts: { token?: string | null } = {}): string | null {
  return opts.token === undefined ? harness.document.updatedAt : opts.token
}

function patch(body: Record<string, unknown>, opts: { token?: string | null } = {}): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/estimates/${DOCUMENT_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, expectedUpdatedAt: revisionToken(opts) }),
    }),
    { params: Promise.resolve({ id: DOCUMENT_ID }) },
  )
}

function discard(opts: { token?: string | null } = {}): Promise<Response> {
  return DELETE(
    new Request(`http://openbooks.test/api/estimates/${DOCUMENT_ID}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedUpdatedAt: revisionToken(opts) }),
    }),
    { params: Promise.resolve({ id: DOCUMENT_ID }) },
  )
}

function convert(body: Record<string, unknown>, opts: { token?: string | null } = {}): Promise<Response> {
  return CONVERT(
    new Request(`http://openbooks.test/api/estimates/${DOCUMENT_ID}/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, expectedUpdatedAt: revisionToken(opts) }),
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
  let lockAttemptsWhileIssueWasPaused = 0
  try {
    await waitForConcurrentPath(
      () => harness.lockAttempts >= 2 || harness.headerWrites > 0,
      'the stale edit to reach the lifecycle boundary',
    )
    lockAttemptsWhileIssueWasPaused = harness.lockAttempts
  } finally {
    control.release()
  }

  const [issueResult, editResult] = await Promise.allSettled([issue, staleEdit])
  const issueResponse = fulfilledResponse(issueResult, 'issue request')
  const editResponse = fulfilledResponse(editResult, 'stale edit request')
  assert.equal(lockAttemptsWhileIssueWasPaused, 2)
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
  let lockAttemptsWhileIssueWasPaused = 0
  try {
    await waitForConcurrentPath(
      () => harness.lockAttempts >= 2 || harness.deleteCalls > 0,
      'draft discard to reach the lifecycle boundary',
    )
    deleteCallsWhileIssueHeldTheLock = harness.deleteCalls
    lockAttemptsWhileIssueWasPaused = harness.lockAttempts
  } finally {
    control.release()
  }

  const settled = await Promise.allSettled([issue, deleteRequest])
  const issueResponse = fulfilledResponse(settled[0], 'issue request')
  const deleteResponse = fulfilledResponse(settled[1], 'draft discard request')
  assert.equal(lockAttemptsWhileIssueWasPaused, 2)
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
  let lockAttemptsWhileTheFirstIssueWasPaused = 0
  try {
    await waitForConcurrentPath(
      () => harness.lockAttempts >= 2 || harness.submitCalls >= 2,
      'the duplicate issue request to reach the lifecycle boundary',
    )
    lockAttemptsWhileTheFirstIssueWasPaused = harness.lockAttempts
  } finally {
    control.release()
  }

  const settled = await Promise.allSettled([first, second])
  const firstResponse = fulfilledResponse(settled[0], 'first issue request')
  const secondResponse = fulfilledResponse(settled[1], 'duplicate issue request')
  assert.equal(lockAttemptsWhileTheFirstIssueWasPaused, 2)
  assert.deepEqual([firstResponse.status, secondResponse.status], [200, 422])
  assert.deepEqual(await secondResponse.json(), { error: 'only a draft can be issued' })
  assert.equal(harness.submitCalls, 1)
  assert.equal(harness.document.status, 'approved')
})

test('concurrent void requests reserve once before any before_void effect', async () => {
  harness.reset('approved')
  const control = harness.pauseNextVoid()
  const first = patch({ status: 'voided', reason: 'customer cancelled' })
  await control.entered

  const second = patch({ status: 'voided', reason: 'duplicate request' })
  let callsWhileTheFirstLockWasHeld = 0
  let lockAttemptsWhileTheFirstVoidWasPaused = 0
  try {
    await waitForConcurrentPath(
      () => harness.lockAttempts >= 2 || harness.voidCalls >= 2,
      'the duplicate void request to reach the lifecycle boundary',
    )
    callsWhileTheFirstLockWasHeld = harness.voidCalls
    lockAttemptsWhileTheFirstVoidWasPaused = harness.lockAttempts
  } finally {
    control.release()
  }

  const settled = await Promise.allSettled([first, second])
  const firstResponse = fulfilledResponse(settled[0], 'first void request')
  const secondResponse = fulfilledResponse(settled[1], 'duplicate void request')
  assert.equal(lockAttemptsWhileTheFirstVoidWasPaused, 2)
  assert.equal(callsWhileTheFirstLockWasHeld, 2)
  assert.deepEqual([firstResponse.status, secondResponse.status], [200, 422])
  assert.deepEqual(await secondResponse.json(), {
    error: 'the order changed while the void request was being created',
  })
  assert.equal(harness.beforeVoidCalls, 1)
  assert.equal(harness.beforeVoidInsideTransaction, 1)
  assert.equal(harness.voidCalls, 2)
  assert.equal(harness.voidReservations, 1)
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
  assert.equal(harness.beforeVoidCalls, 1)
  assert.equal(harness.beforeVoidInsideTransaction, 1)
  assert.deepEqual(harness.auditLog, [])
  assert.deepEqual(harness.flowEffects, [])
})

const STALE_TOKEN = '2026-08-01T00:00:00.000Z'

async function expectRevisionRefusal(
  request: () => Promise<Response>,
  opts: { expectEngineCall?: boolean } = {},
): Promise<void> {
  const response = await request()
  assert.equal(response.status, 409)
  assert.deepEqual(
    await response.json(),
    { error: 'this order changed after you opened it; reload and review the latest revision' },
  )
  // No side effect may fire from a view the server never issued.
  assert.equal(harness.headerWrites, 0)
  assert.equal(harness.submitCalls, 0)
  assert.equal(harness.deleteCalls, 0)
  assert.equal(harness.convertCalls, 0)
  if (!opts.expectEngineCall) assert.equal(harness.voidCalls, 0)
}

test('every mutating order request requires an exact revision token', async () => {
  harness.reset('draft')

  await expectRevisionRefusal(() => patch({ memo: 'tokenless memo' }, { token: null }))
  await expectRevisionRefusal(() => patch({ status: 'approved' }, { token: null }))
  await expectRevisionRefusal(() => discard({ token: null }))
  await expectRevisionRefusal(() => convert({ targetKind: 'sales_order' }, { token: null }))
  assert.equal(harness.document.status, 'draft')
  assert.equal(harness.document.memo, 'original memo')

  harness.reset('approved')
  await expectRevisionRefusal(() =>
    patch({ status: 'voided', reason: 'customer cancelled' }, { token: null }))
  assert.equal(harness.document.status, 'approved')
})

test('a stale revision token rejects every mutation before any side effect', async () => {
  harness.reset('draft')

  await expectRevisionRefusal(() => patch({ memo: 'stale memo' }, { token: STALE_TOKEN }))
  await expectRevisionRefusal(() => patch({ status: 'approved' }, { token: STALE_TOKEN }))
  await expectRevisionRefusal(() => discard({ token: STALE_TOKEN }))
  await expectRevisionRefusal(() =>
    convert({ targetKind: 'sales_order' }, { token: STALE_TOKEN }))
  assert.equal(harness.document.status, 'draft')
  assert.equal(harness.document.memo, 'original memo')

  harness.reset('approved')
  // The route's probe fences the stale void before the engine claim runs.
  await expectRevisionRefusal(() =>
    patch({ status: 'voided', reason: 'customer cancelled' }, { token: STALE_TOKEN }))
  assert.equal(harness.document.status, 'approved')
  assert.equal(harness.document.voidRequestedAt, null)
  assert.deepEqual(harness.auditLog, [])
})

test('an exact revision token admits draft save, issue, and discard', async () => {
  harness.reset('draft')
  const saved = await patch({ memo: 'freshly saved memo' })
  assert.equal(saved.status, 200)
  assert.equal(harness.headerWrites, 1)

  const issued = await patch({ status: 'approved' })
  assert.equal(issued.status, 200)
  assert.equal(harness.submitCalls, 1)
  assert.equal(harness.document.status, 'approved')

  harness.reset('draft')
  const discarded = await discard()
  assert.equal(discarded.status, 200)
  assert.deepEqual(await discarded.json(), { ok: true })
  assert.equal(harness.deleteCalls, 1)
  assert.equal(harness.deleted, true)
})

test('void and convert honor the exact revision of their source', async () => {
  harness.reset('approved')
  const voided = await patch({ status: 'voided', reason: 'customer cancelled' })
  assert.equal(voided.status, 200)
  assert.equal(harness.voidReservations, 1)
  assert.equal(harness.beforeVoidCalls, 1)
  assert.equal(harness.beforeVoidInsideTransaction, 1)
  assert.equal(harness.document.status, 'voided')
  assert.equal(harness.auditLog.length, 1)
  assert.equal(harness.flowEffects.length, 1)

  harness.reset('draft')
  const converted = await convert({ targetKind: 'sales_order' })
  assert.equal(converted.status, 200)
  assert.equal(harness.convertCalls, 1)
})

interface PoolIssueDocument {
  id: string
  orgId: string
  kind: 'quote'
  status: 'draft' | 'approved'
  documentNumber: string
  documentDate: string
  partyId: string
  total: string
  createdBy: string
  updatedAt: string
}

interface PoolIssueTransaction {
  orgId: string
  bypass: false
  txDb: Record<string, never>
  documentId: string | null
  lockedDocumentIds: Set<string>
  snapshot: Map<string, PoolIssueDocument>
}

/**
 * Production-shaped request-pool model for the real
 * handlers -> submit -> QuickJS ob.query path below. Every outer transaction
 * pins one of the same ten clients used by production. Governed script reads
 * either use isolated capacity or deterministically expose an eleventh request
 * checkout.
 */
class IssuePoolHarness {
  readonly capacity = 10
  readonly documentId = '10000000-0000-4000-8000-000000000001'
  readonly requestDocumentIds = Array(this.capacity).fill(this.documentId) as string[]
  documents = new Map<string, PoolIssueDocument>()
  activeConnections = 0
  peakConnections = 0
  overflowAttempts = 0
  requestPoolSqlCheckoutAttempts = 0
  governedPoolCheckouts = 0
  governedPoolReleases = 0
  governedReads = 0
  scriptRuns = 0
  governedReadOnlyTransactions = 0
  governedRollbacks = 0
  readRoleSelections = 0

  private readonly transactions = new AsyncLocalStorage<PoolIssueTransaction>()
  private readonly lockedDocumentIds = new Set<string>()
  private readonly lockWaiters = new Map<string, Array<() => void>>()

  constructor() {
    this.reset()
  }

  reset(): void {
    assert.equal(this.activeConnections, 0, 'the prior pool test must release every client')
    assert.equal(this.lockedDocumentIds.size, 0, 'the prior pool test must release every row lock')
    this.documents = new Map([[this.documentId, {
      id: this.documentId,
      orgId: ORG_ID,
      kind: 'quote' as const,
      status: 'draft' as const,
      documentNumber: 'Q-POOL-1',
      documentDate: '2026-08-24',
      partyId: PARTY_ID,
      total: '100.00',
      createdBy: USER_ID,
      updatedAt: '2026-08-24T09:00:00.000Z',
    }]])
    this.peakConnections = 0
    this.overflowAttempts = 0
    this.requestPoolSqlCheckoutAttempts = 0
    this.governedPoolCheckouts = 0
    this.governedPoolReleases = 0
    this.governedReads = 0
    this.scriptRuns = 0
    this.governedReadOnlyTransactions = 0
    this.governedRollbacks = 0
    this.readRoleSelections = 0
    this.lockWaiters.clear()
  }

  sql(strings: TemplateStringsArray, values: unknown[]): SqlQuery {
    return { __orderTestSql: true, strings: Array.from(strings), values }
  }

  rawSql(text: string): SqlQuery {
    return { __orderTestSql: true, strings: [text], values: [] }
  }

  activeTransaction(): PoolIssueTransaction | undefined {
    return this.transactions.getStore()
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactions.getStore()) return work()
    if (this.activeConnections >= this.capacity) {
      this.overflowAttempts += 1
      throw new Error('issuance attempted an eleventh request-pool checkout')
    }
    this.activeConnections += 1
    this.peakConnections = Math.max(this.peakConnections, this.activeConnections)
    const context: PoolIssueTransaction = {
      orgId: ORG_ID,
      bypass: false,
      txDb: {},
      documentId: null,
      lockedDocumentIds: new Set(),
      snapshot: new Map(
        [...this.documents].map(([id, document]) => [id, { ...document }]),
      ),
    }

    return this.transactions.run(context, async () => {
      try {
        return await work()
      } catch (error) {
        this.documents = new Map(
          [...context.snapshot].map(([id, document]) => [id, { ...document }]),
        )
        throw error
      } finally {
        for (const id of context.lockedDocumentIds) this.releaseDocument(id)
        this.activeConnections -= 1
      }
    })
  }

  async execute(query: SqlQuery): Promise<{
    rows: Record<string, unknown>[]
    fields: { name: string }[]
  }> {
    const { text, params } = this.compile(query)
    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()

    if (normalized.startsWith('select status, document_date from documents')) {
      const document = this.documentFromParams(params)
      return this.result(document
        ? [{ status: document.status, document_date: document.documentDate }]
        : [])
    }
    if (normalized.startsWith('select status, document_date, subsidiary_id as "subsidiaryid"')) {
      const document = this.documentFromParams(params)
      return this.result(document
        ? [{ status: document.status, document_date: document.documentDate, updated_at: document.updatedAt }]
        : [])
    }
    if (normalized.startsWith('select status, party_id, total')) {
      const document = this.documentFromParams(params)
      if (document && normalized.endsWith('for update')) await this.lockDocument(document.id)
      return this.result(document
        ? [{ status: document.status, party_id: document.partyId, total: document.total, updated_at: document.updatedAt }]
        : [])
    }
    if (normalized.startsWith('select source.document_number')) return this.result([])
    if (normalized.startsWith("select settings #>> '{features,scripts}'")) {
      return this.result([{ enabled: 'true' }])
    }
    if (normalized.startsWith('update user_scripts set last_run_at = now()')) return this.result([])
    throw new Error(`unexpected pool-contention query: ${normalized}`)
  }

  selectRows(table: { __table: string }, projection?: Record<string, unknown>): Record<string, unknown>[] {
    const context = this.requireTransaction()
    if (table.__table === 'documents') {
      const document = context.documentId ? this.documents.get(context.documentId) : undefined
      if (!document) return []
      if (projection && Object.keys(projection).length === 1 && 'orgId' in projection) {
        return [{ orgId: document.orgId }]
      }
      return [{ ...document }]
    }
    if (table.__table === 'orgs') {
      return [{ id: ORG_ID, name: 'Pool Test Org', baseCurrency: 'CAD' }]
    }
    if (table.__table === 'documentLines') return []
    if (table.__table === 'userScripts') {
      return [{
        id: '20000000-0000-4000-8000-000000000001',
        name: 'Pool-safe before submit query',
        source: 'function main() { const rows = ob.query("SELECT 42 AS answer"); if (rows[0].answer !== 42) ob.abort("query failed"); }',
        triggerPoint: 'before_submit',
        isActive: true,
        documentKind: 'quote',
        sortOrder: 1,
        timeoutMs: 5_000,
      }]
    }
    throw new Error(`unexpected pool-contention select table: ${table.__table}`)
  }

  updateRows(
    table: { __table: string },
    values: Record<string, unknown>,
    returning: boolean,
  ): Record<string, unknown>[] {
    if (table.__table === 'userScripts') return []
    if (table.__table !== 'documents') {
      throw new Error(`unexpected pool-contention update table: ${table.__table}`)
    }
    const context = this.requireTransaction()
    const document = context.documentId ? this.documents.get(context.documentId) : undefined
    if (!document) return []
    if (values.status === 'approved' && document.status !== 'draft') return []
    if (values.status === 'approved') document.status = 'approved'
    return returning ? [{ id: document.id }] : []
  }

  insertRows(table: { __table: string }): Record<string, unknown>[] {
    if (table.__table !== 'scriptRuns') {
      throw new Error(`unexpected pool-contention insert table: ${table.__table}`)
    }
    this.scriptRuns += 1
    return []
  }

  async connectGovernedReadClient(): Promise<{
    query: (text: string, params?: unknown[]) => Promise<{
      rows: Record<string, unknown>[]
      fields: { name: string }[]
      rowCount: number
    }>
    release: (error?: Error) => void
  }> {
    await this.awaitPoolSaturation()
    this.governedPoolCheckouts += 1
    return {
      query: (text, params) => this.governedQuery(text, params),
      release: () => {
        this.governedPoolReleases += 1
      },
    }
  }

  async connectRequestReadClient(): Promise<never> {
    this.requestPoolSqlCheckoutAttempts += 1
    await this.awaitPoolSaturation()
    if (this.activeConnections >= this.capacity) {
      this.overflowAttempts += 1
      throw new Error('before_submit attempted an eleventh request-pool checkout')
    }
    throw new Error('request-pool mutation unexpectedly found spare capacity')
  }

  loadOrder(id: string): Record<string, unknown> {
    const document = this.documents.get(id)
    return { doc: document ? { id: document.id, status: document.status } : null, lines: [], links: [] }
  }

  private async awaitPoolSaturation(): Promise<void> {
    for (let turn = 0; turn < 2_000; turn += 1) {
      if (this.peakConnections === this.capacity) return
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    throw new Error('timed out waiting for ten pinned issuance connections')
  }

  private async governedQuery(
    text: string,
    params?: unknown[],
  ): Promise<{
    rows: Record<string, unknown>[]
    fields: { name: string }[]
    rowCount: number
  }> {
    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()
    if (normalized === 'begin transaction read only') {
      this.governedReadOnlyTransactions += 1
      return { ...this.result([]), rowCount: 0 }
    }
    if (normalized.startsWith("select set_config('app.current_org'")) {
      assert.deepEqual(params, [ORG_ID])
      return { ...this.result([]), rowCount: 0 }
    }
    if (normalized === 'set local role openbooks_read') {
      this.readRoleSelections += 1
      return { ...this.result([]), rowCount: 0 }
    }
    if (
      normalized.startsWith('create temporary table if not exists openbooks_query_context')
      || normalized === 'truncate table pg_temp.openbooks_query_context'
      || normalized.startsWith('insert into pg_temp.openbooks_query_context')
      || normalized === 'set local search_path = openbooks_query, pg_catalog'
      || normalized.startsWith('set local statement_timeout = ')
      || normalized === 'set local enable_nestloop = off'
    ) {
      return { ...this.result([]), rowCount: 0 }
    }
    if (normalized === 'rollback') {
      this.governedRollbacks += 1
      return { ...this.result([]), rowCount: 0 }
    }
    if (normalized.startsWith('select * from (select 42 as answer) __q limit 5001')) {
      this.governedReads += 1
      return { ...this.result([{ answer: 42 }], ['answer']), rowCount: 1 }
    }
    throw new Error(`unexpected governed read query: ${normalized}`)
  }

  private async lockDocument(id: string): Promise<void> {
    const context = this.requireTransaction()
    if (this.lockedDocumentIds.has(id)) {
      await new Promise<void>((resolve) => {
        const waiters = this.lockWaiters.get(id) ?? []
        waiters.push(resolve)
        this.lockWaiters.set(id, waiters)
      })
    } else {
      this.lockedDocumentIds.add(id)
    }
    context.lockedDocumentIds.add(id)
    context.documentId = id
  }

  private releaseDocument(id: string): void {
    const waiters = this.lockWaiters.get(id)
    const next = waiters?.shift()
    if (next) {
      if (waiters?.length === 0) this.lockWaiters.delete(id)
      next()
      return
    }
    this.lockWaiters.delete(id)
    this.lockedDocumentIds.delete(id)
  }

  private requireTransaction(): PoolIssueTransaction {
    const context = this.transactions.getStore()
    if (!context) throw new Error('pool-contention operation requires the route transaction')
    return context
  }

  private documentFromParams(params: unknown[]): PoolIssueDocument | undefined {
    const [id, kind, orgId] = params
    const document = this.documents.get(String(id))
    return document && document.kind === kind && document.orgId === orgId ? document : undefined
  }

  private result(
    rows: Record<string, unknown>[],
    columns = rows[0] ? Object.keys(rows[0]) : [],
  ): { rows: Record<string, unknown>[]; fields: { name: string }[] } {
    return { rows, fields: columns.map((name) => ({ name })) }
  }

  private compile(query: SqlQuery): { text: string; params: unknown[] } {
    const params: unknown[] = []
    const render = (fragment: SqlQuery): string => {
      let text = fragment.strings[0] ?? ''
      for (let index = 0; index < fragment.values.length; index += 1) {
        const value = fragment.values[index]
        if (
          value
          && typeof value === 'object'
          && (value as Partial<SqlQuery>).__orderTestSql
        ) {
          text += render(value as SqlQuery)
        } else {
          text += `__P${params.push(value) - 1}__`
        }
        text += fragment.strings[index + 1] ?? ''
      }
      return text
    }
    return { text: render(query), params }
  }
}

const poolHarnessKey = Symbol.for('openbooks.order-issue-pool-contention-test')
const poolHarness = new IssuePoolHarness()
;(globalThis as typeof globalThis & Record<symbol, unknown>)[poolHarnessKey] = poolHarness
const poolStateExpression = `globalThis[Symbol.for('openbooks.order-issue-pool-contention-test')]`
const poolHandlerUrl = new URL('./handlers.ts?order-issue-pool-contention-test', import.meta.url).href
const poolSubmitUrl = new URL('../../../../engine/src/flows/submit.ts?order-issue-pool-contention-test', import.meta.url).href
const poolScriptingUrl = new URL('../../../../engine/src/scripting.ts?order-issue-pool-contention-test', import.meta.url).href
const poolSqlapiUrl = new URL('../../../../engine/src/sqlapi.ts?order-issue-pool-contention-test', import.meta.url).href

const poolMockSources = new Map<string, string>([
  ['pool:drizzle', `
    const state = ${poolStateExpression}
    export function sql(strings, ...values) { return state.sql(strings, values) }
    sql.raw = (text) => state.rawSql(text)
    export const and = (...values) => ({ op: 'and', values })
    export const asc = (value) => ({ op: 'asc', value })
    export const eq = (left, right) => ({ op: 'eq', left, right })
    export const isNull = (value) => ({ op: 'isNull', value })
    export const or = (...values) => ({ op: 'or', values })
  `],
  ['pool:db', `
    const state = ${poolStateExpression}
    const table = (name, columns) => Object.assign({ __table: name }, columns)
    export const schema = {
      documents: table('documents', { id: 'documents.id', orgId: 'documents.orgId', status: 'documents.status' }),
      documentLines: table('documentLines', { documentId: 'document_lines.document_id', orgId: 'document_lines.org_id' }),
      orgs: table('orgs', { id: 'orgs.id' }),
      userScripts: table('userScripts', {
        orgId: 'user_scripts.org_id', triggerPoint: 'user_scripts.trigger_point',
        isActive: 'user_scripts.is_active', documentKind: 'user_scripts.document_kind',
        sortOrder: 'user_scripts.sort_order', id: 'user_scripts.id',
      }),
      scriptRuns: table('scriptRuns', { id: 'script_runs.id' }),
    }
    const thenable = (load) => ({
      then(resolve, reject) { return Promise.resolve().then(load).then(resolve, reject) },
    })
    export const db = {
      execute(query) { return state.execute(query) },
      select(projection) {
        let selectedTable
        const builder = {
          from(value) { selectedTable = value; return builder },
          where() { return builder },
          orderBy() { return builder },
          then(resolve, reject) {
            return Promise.resolve().then(() => state.selectRows(selectedTable, projection)).then(resolve, reject)
          },
        }
        return builder
      },
      update(selectedTable) {
        let values = {}
        let returning = false
        const builder = {
          set(value) { values = value; return builder },
          where() { return builder },
          returning() { returning = true; return builder },
          then(resolve, reject) {
            return Promise.resolve().then(() => state.updateRows(selectedTable, values, returning)).then(resolve, reject)
          },
        }
        return builder
      },
      insert(selectedTable) {
        return { values() { return thenable(() => state.insertRows(selectedTable)) } }
      },
      transaction(callback) { return state.transaction(() => callback(db)) },
    }
    export const orgContext = { getStore() { return state.activeTransaction() } }
    export function withOrgTransaction(_orgId, callback) { return state.transaction(callback) }
    export function connectGovernedReadClient() { return state.connectGovernedReadClient() }
    export const pool = { connect() { return state.connectRequestReadClient() } }
  `],
  ['pool:flow-run', `
    export async function runRecordFlows() { return { runs: [], gatesCreated: 0, failed: false } }
  `],
  ['pool:journal-writes', `export async function createScriptJournal() { return {} }`],
  ['pool:order-lib', `
    const state = ${poolStateExpression}
    export function computeOrderTotals() { return { lines: [], subtotal: '0', taxTotal: '0', total: '0' } }
    export function exactOrderMoney(value) { return String(value) }
    export function exactOrderQuantity(value) { return String(value) }
    export function loadOrder(id) { return state.loadOrder(id) }
    export async function orderTaxProfileMap() { return new Map() }
  `],
  ['pool:document-delete', `export class DeleteError extends Error {}; export async function deleteDocument() { return {} }`],
  ['pool:document-void', `export class DocumentVoidError extends Error {}; export async function requestDocumentVoid() { return {} }`],
])

const poolHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'drizzle-orm') return { url: 'pool:drizzle', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/db.ts') return { url: 'pool:db', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/flows/index.ts') {
      return { url: poolSubmitUrl, shortCircuit: true }
    }
    if (specifier === '@openbooks/engine/src/document-delete.ts') {
      return { url: 'pool:document-delete', shortCircuit: true }
    }
    if (specifier === '@openbooks/engine/src/document-void.ts') {
      return { url: 'pool:document-void', shortCircuit: true }
    }
    if (specifier === './lib' && context.parentURL === poolHandlerUrl) {
      return { url: 'pool:order-lib', shortCircuit: true }
    }
    if (context.parentURL === poolSubmitUrl) {
      if (specifier === '../db.ts') return { url: 'pool:db', shortCircuit: true }
      if (specifier === '../scripting.ts') return { url: poolScriptingUrl, shortCircuit: true }
      if (specifier === './run.ts') return { url: 'pool:flow-run', shortCircuit: true }
    }
    if (context.parentURL === poolScriptingUrl) {
      if (specifier === './db.ts') return { url: 'pool:db', shortCircuit: true }
      if (specifier === './sqlapi.ts') return { url: poolSqlapiUrl, shortCircuit: true }
      if (specifier === './journal-writes.ts') return { url: 'pool:journal-writes', shortCircuit: true }
    }
    if (context.parentURL === poolSqlapiUrl && specifier === './db.ts') {
      return { url: 'pool:db', shortCircuit: true }
    }
    const existing = resolutionMocks.get(specifier)
    return existing
      ? { url: existing, shortCircuit: true }
      : nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = poolMockSources.get(url) ?? mockSources.get(url)
    return source === undefined
      ? nextLoad(url, context)
      : { format: 'module', source, shortCircuit: true }
  },
})

const { makePATCH: makePoolPATCH } = await import(poolHandlerUrl) as typeof import('./handlers.ts')
poolHooks.deregister()
const POOL_PATCH = makePoolPATCH({ kind: 'quote', readPerm: 'ar.read', createPerm: 'ar.create' })

function poolPatch(id: string): Promise<Response> {
  return POOL_PATCH(
    new Request(`http://openbooks.test/api/estimates/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'approved',
        expectedUpdatedAt: poolHarness.documents.get(id)?.updatedAt,
      }),
    }),
    { params: Promise.resolve({ id }) },
  )
}

test('before_submit uses isolated governed capacity when duplicate issuers saturate the request pool', async () => {
  poolHarness.reset()

  const settled = await Promise.allSettled(poolHarness.requestDocumentIds.map(poolPatch))
  const responses = settled.map((result, index) =>
    fulfilledResponse(result, `pool-saturated issue request ${index + 1}`))

  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, ...Array(9).fill(422)].sort(),
  )
  assert.equal(poolHarness.documents.get(poolHarness.documentId)?.status, 'approved')
  assert.equal(poolHarness.peakConnections, 10)
  assert.equal(poolHarness.governedPoolCheckouts, 1)
  assert.equal(poolHarness.governedPoolReleases, 1)
  assert.equal(poolHarness.governedReads, 1)
  assert.equal(poolHarness.requestPoolSqlCheckoutAttempts, 0)
  assert.equal(poolHarness.overflowAttempts, 0)
  assert.equal(poolHarness.scriptRuns, 1)
  assert.equal(poolHarness.governedReadOnlyTransactions, 1)
  assert.equal(poolHarness.governedRollbacks, 1)
  assert.equal(poolHarness.readRoleSelections, 1)
  assert.equal(poolHarness.activeConnections, 0)
})
