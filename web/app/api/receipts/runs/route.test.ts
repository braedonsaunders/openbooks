import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextResponse } from 'next/server'

const stateKey = Symbol.for('openbooks.receipts-runs-route-test')
const SUB_A = '00000000-0000-4000-8000-00000000a001'
const SUB_B = '00000000-0000-4000-8000-00000000b001'
const PROFILE = '00000000-0000-4000-8000-00000000c001'
const INVOICE_A = '00000000-0000-4000-8000-00000000d001'
const INVOICE_B = '00000000-0000-4000-8000-00000000e001'

interface RunOptions {
  orgId: string
  createdBy: string
  paymentBankProfileId: string
  invoiceDocumentIds: string[]
  scheduledFor: string | null
  allowedSubsidiaryIds: Set<string> | null
}

interface RouteState {
  allowedSubsidiaryIds: Set<string> | null
  calls: RunOptions[]
}

const routeState: RouteState = { allowedSubsidiaryIds: null, calls: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksReceiptsRunsNextResponse = NextResponse

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.receipts-runs-route-test')]
      export async function guardPermission() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
    `,
  ],
  [
    'mock:json',
    `
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
      export function isoDate() {
        return { nullable() { return { optional() { return {} } } } }
      }
      export const uuidId = { safeParse() { return { success: true } } }
    `,
  ],
  [
    'mock:payment-errors',
    `
      const NextResponse = globalThis.openbooksReceiptsRunsNextResponse
      export function paymentErrorResponse(error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 422 })
      }
    `,
  ],
  [
    '@openbooks/engine/src/direct-debit.ts',
    `
      const state = globalThis[Symbol.for('openbooks.receipts-runs-route-test')]
      const SUB_A = '${SUB_A}'
      const SUB_B = '${SUB_B}'
      const PROFILE = '${PROFILE}'
      const INVOICE_A = '${INVOICE_A}'
      const INVOICE_B = '${INVOICE_B}'
      export async function createDirectDebitRun(options) {
        state.calls.push(options)
        const scope = options.allowedSubsidiaryIds
        const profileSubsidiary = options.paymentBankProfileId === PROFILE ? SUB_A : SUB_B
        const invoiceSubsidiaries = new Map([
          [INVOICE_A, SUB_A],
          [INVOICE_B, SUB_B],
        ])
        if (scope !== null) {
          if (scope.size === 0 || !scope.has(profileSubsidiary)
              || options.invoiceDocumentIds.some((id) => !scope.has(invoiceSubsidiaries.get(id)))) {
            throw new Error('some invoices are closed, outside the profile scope, or have no active debit mandate')
          }
        }
        return { id: 'run-1', runNumber: 'COLL-1' }
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/authz', 'mock:authz'],
  ['@/lib/api/json', 'mock:json'],
  ['@/app/api/payments/lib', 'mock:payment-errors'],
  ['@openbooks/engine/src/direct-debit.ts', '@openbooks/engine/src/direct-debit.ts'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?receipts-runs-scope-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(allowedSubsidiaryIds: Set<string> | null): void {
  routeState.allowedSubsidiaryIds = allowedSubsidiaryIds
  routeState.calls = []
}

function post(invoiceDocumentIds: string[], paymentBankProfileId = PROFILE): Promise<Response> {
  return POST(new Request('http://openbooks.test/api/receipts/runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ paymentBankProfileId, invoiceDocumentIds }),
  }))
}

test('hidden invoice is refused and the route forwards the restricted scope', async () => {
  reset(new Set([SUB_A]))

  const response = await post([INVOICE_B])

  assert.equal(response.status, 422)
  assert.deepEqual(routeState.calls[0]?.allowedSubsidiaryIds, new Set([SUB_A]))
})

test('mixed in-scope and hidden invoices are refused as one atomic selection', async () => {
  reset(new Set([SUB_A]))

  const response = await post([INVOICE_A, INVOICE_B])

  assert.equal(response.status, 422)
  assert.deepEqual(routeState.calls[0]?.invoiceDocumentIds, [INVOICE_A, INVOICE_B])
})

test('an empty restricted scope fails closed before collection', async () => {
  reset(new Set())

  const response = await post([INVOICE_A])

  assert.equal(response.status, 422)
  assert.deepEqual(routeState.calls[0]?.allowedSubsidiaryIds, new Set())
})

test('an unrestricted scope preserves cross-subsidiary collection behavior', async () => {
  reset(null)

  const response = await post([INVOICE_B], 'profile-in-other-subsidiary')

  assert.equal(response.status, 200)
  assert.equal(routeState.calls[0]?.allowedSubsidiaryIds, null)
})
