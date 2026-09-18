import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

type CancelBehavior =
  | { mode: 'cancelled' }
  | { mode: 'pending' }
  | { mode: 'cancelError'; message: string }
  | { mode: 'voidError'; message: string }

interface RouteState {
  featureEnabled: boolean
  allowedSubsidiaryIds: Set<string> | null
  doc: { kind: string; subsidiaryId: string | null } | null
  kindEnabled: boolean
  behavior: CancelBehavior
  calls: { documentId: string; reason: string; reversalDate: string }[]
}

const stateKey = Symbol.for('openbooks.cancel-recognition-route-test')
const state: RouteState = {
  featureEnabled: true,
  allowedSubsidiaryIds: null,
  doc: { kind: 'customer_invoice', subsidiaryId: 'sub-1' },
  kindEnabled: true,
  behavior: { mode: 'cancelled' },
  calls: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockSources = new Map<string, string>([
  [
    'authz',
    `
      import { NextResponse } from 'next/server'
      const state = globalThis[Symbol.for('openbooks.cancel-recognition-route-test')]
      export async function guardPermission() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
      export function guardSubsidiaryScope(authz, subsidiaryId) {
        const allowed = authz.allowedSubsidiaryIds
        if (allowed === null) return null
        if (subsidiaryId !== null && allowed.has(subsidiaryId)) return null
        return NextResponse.json({ error: 'not found' }, { status: 404 })
      }
    `,
  ],
  [
    'features',
    `
      const state = globalThis[Symbol.for('openbooks.cancel-recognition-route-test')]
      export async function isFeatureEnabled() { return state.featureEnabled }
    `,
  ],
  [
    'documents',
    `
      const state = globalThis[Symbol.for('openbooks.cancel-recognition-route-test')]
      export async function isDocKindEnabled() { return state.kindEnabled }
    `,
  ],
  [
    'business-date',
    `export async function businessToday() { return '2026-08-31' }`,
  ],
  [
    'json',
    `
      import { NextResponse } from 'next/server'
      import { z } from 'zod'
      export const uuidId = z.string().uuid()
      export function isoDate() { return z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/) }
      export async function parseJsonBody(req, schema, opts) {
        const raw = await req.json().catch(() => undefined)
        const parsed = schema.safeParse(raw)
        if (!parsed.success) return { ok: false, response: NextResponse.json({ error: 'invalid request body' }, { status: opts?.status ?? 400 }) }
        return { ok: true, data: parsed.data }
      }
    `,
  ],
  [
    'revenue-recognition',
    `
      const state = globalThis[Symbol.for('openbooks.cancel-recognition-route-test')]
      export class RevenueRecognitionCancellationError extends Error {}
      export async function cancelRevenueRecognitionForInvoice(input) {
        state.calls.push({ documentId: input.documentId, reason: input.reason, reversalDate: input.reversalDate })
        const behavior = state.behavior
        if (behavior.mode === 'cancelError') throw new RevenueRecognitionCancellationError(behavior.message)
        if (behavior.mode === 'voidError') {
          const { DocumentVoidError } = globalThis[Symbol.for('openbooks.cancel-recognition-void-error')]
          throw new DocumentVoidError(behavior.message, 409, 'conflict')
        }
        if (behavior.mode === 'pending') {
          return { status: 'pending_approval', recognitionReversalEntryIds: [], invoiceReversalEntryId: null, runId: 'run-1' }
        }
        return { status: 'cancelled', recognitionReversalEntryIds: ['rev-1'], invoiceReversalEntryId: 'inv-rev-1', runId: null }
      }
    `,
  ],
  [
    'document-void',
    `
      export class DocumentVoidError extends Error {
        constructor(message, status = 500, code) {
          super(message)
          this.status = status
          this.code = code
        }
      }
      globalThis[Symbol.for('openbooks.cancel-recognition-void-error')] = { DocumentVoidError }
    `,
  ],
  [
    'db',
    `
      const state = globalThis[Symbol.for('openbooks.cancel-recognition-route-test')]
      export const db = {
        async execute() {
          return { rows: state.doc ? [state.doc] : [] }
        },
      }
    `,
  ],
])

const selfUrl = new URL(import.meta.url).href
const mockUrl = (name: string) => `${selfUrl}?cancel-mock=${name}`
const mockUrls = new Map<string, string>([
  ['../../../../lib/authz', mockUrl('authz')],
  ['../../../../lib/features', mockUrl('features')],
  ['../../../../lib/documents', mockUrl('documents')],
  ['@openbooks/engine/src/business-date.ts', mockUrl('business-date')],
  ['@openbooks/engine/src/revenue-recognition.ts', mockUrl('revenue-recognition')],
  ['@openbooks/engine/src/document-void.ts', mockUrl('document-void')],
  ['@openbooks/engine/src/db.ts', mockUrl('db')],
  ['../../../../lib/api/json', mockUrl('json')],
])

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { shortCircuit: true, url: mocked }
    return nextResolve(specifier, _context)
  },
  load(url, context, nextLoad) {
    const name = new URL(url).searchParams.get('cancel-mock')
    const source = name ? mockSources.get(name) : undefined
    if (source !== undefined) return { shortCircuit: true, format: 'module', source }
    return nextLoad(url, context)
  },
})

const routeUrl = new URL('./route.ts?cancel-recognition-test', import.meta.url).href
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.featureEnabled = true
  state.allowedSubsidiaryIds = null
  state.doc = { kind: 'customer_invoice', subsidiaryId: 'sub-1' }
  state.kindEnabled = true
  state.behavior = { mode: 'cancelled' }
  state.calls.length = 0
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/revenue/cancel-recognition', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

test('cancelling a posted invoice reaches the engine with reason and date', async () => {
  reset()
  const documentId = randomUUID()

  const response = await post({ documentId, reason: 'customer terminated early', reversalDate: '2026-08-31' })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    ok: true,
    status: 'cancelled',
    recognitionReversalEntryIds: ['rev-1'],
    invoiceReversalEntryId: 'inv-rev-1',
    runId: null,
  })
  assert.deepEqual(state.calls, [{ documentId, reason: 'customer terminated early', reversalDate: '2026-08-31' }])
})

test('an omitted reversal date defaults to the business day', async () => {
  reset()
  const documentId = randomUUID()

  const response = await post({ documentId, reason: 'customer terminated early' })

  assert.equal(response.status, 200)
  assert.equal(state.calls[0]?.reversalDate, '2026-08-31')
})

test('an approval-gated void surfaces as accepted, not created', async () => {
  reset()
  state.behavior = { mode: 'pending' }

  const response = await post({ documentId: randomUUID(), reason: 'customer terminated early' })

  assert.equal(response.status, 202)
  assert.equal((await response.json()).status, 'pending_approval')
})

test('a too-short reason is rejected before reaching the engine', async () => {
  reset()

  const response = await post({ documentId: randomUUID(), reason: 'no' })

  assert.equal(response.status, 422)
  assert.deepEqual(state.calls, [])
})

test('an engine cancellation refusal maps to unprocessable', async () => {
  reset()
  state.behavior = { mode: 'cancelError', message: 'invoice has no revenue-recognition obligations' }

  const response = await post({ documentId: randomUUID(), reason: 'customer terminated early' })

  assert.equal(response.status, 422)
  assert.equal((await response.json()).error, 'invoice has no revenue-recognition obligations')
})

test('a downstream void refusal keeps its own status and code', async () => {
  reset()
  state.behavior = { mode: 'voidError', message: 'this transaction feeds downstream' }

  const response = await post({ documentId: randomUUID(), reason: 'customer terminated early' })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'this transaction feeds downstream', code: 'conflict' })
})

test('an unknown invoice is not found', async () => {
  reset()
  state.doc = null

  const response = await post({ documentId: randomUUID(), reason: 'customer terminated early' })

  assert.equal(response.status, 404)
  assert.deepEqual(state.calls, [])
})

test('a subsidiary outside the caller scope never reaches the engine', async () => {
  reset()
  state.allowedSubsidiaryIds = new Set(['other-sub'])

  const response = await post({ documentId: randomUUID(), reason: 'customer terminated early' })

  assert.equal(response.status, 404)
  assert.deepEqual(state.calls, [])
})

test('a disabled feature stays hidden', async () => {
  reset()
  state.featureEnabled = false

  const response = await post({ documentId: randomUUID(), reason: 'customer terminated early' })

  assert.equal(response.status, 404)
  assert.deepEqual(state.calls, [])
})
