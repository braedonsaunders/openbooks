import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

interface ImportCall {
  options: {
    dryRun?: boolean
    lines: unknown[]
  }
  context: {
    orgId: string
    userId: string
  }
}

const stateKey = Symbol.for('openbooks.bank-import-route-test')
const importState = { calls: [] as ImportCall[] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = importState

const mockSources = new Map<string, string>([
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  [
    'mock:feature-gates',
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
  ],
  [
    'mock:banking',
    `
      const state = globalThis[Symbol.for('openbooks.bank-import-route-test')]
      const line = {
        postedOn: '2026-08-23',
        amount: '10.0000',
        description: 'Deposit',
        bankTransactionId: 'bank-line-1',
      }

      export class BankingError extends Error {
        constructor(message, status = 422) {
          super(message)
          this.status = status
        }
      }

      export function parseCsvRows() {
        return [
          ['date', 'amount', 'description'],
          ['2026-08-23', '10.00', 'Deposit'],
        ]
      }

      export function parseCsv() {
        return [line]
      }

      export function parseOfx() {
        return { lines: [line] }
      }

      export function parseCamt053() {
        return { lines: [line] }
      }

      export function parseBai2() {
        return { lines: [line] }
      }

      export function parseMt940() {
        return { lines: [line] }
      }

      export async function importStatement(options, context) {
        state.calls.push({ options, context })
        return {
          statementId: options.dryRun ? null : 'statement-1',
          imported: options.lines.length,
          duplicates: 0,
          lines: options.lines,
        }
      }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/api/json') {
      return { url: 'mock:json', shortCircuit: true }
    }
    if (specifier === '@openbooks/engine/src/banking.ts') {
      return { url: 'mock:banking', shortCircuit: true }
    }
    if (specifier === '../../../../lib/feature-gates') {
      return { url: 'mock:feature-gates', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) {
      return { format: 'module', source, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?mode-validation-test'
const { POST } = await import(routeUrl) as typeof import('./route.ts')
hooks.deregister()

const validBody = {
  accountId: 'account-1',
  source: 'csv',
  text: 'date,amount,description\n2026-08-23,10.00,Deposit',
  mapping: { date: 0, amount: 1, description: 2 },
}

async function postMode(mode: string): Promise<Response> {
  return POST(new Request('http://openbooks.test/api/banking/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...validBody, mode }),
  }))
}

test('columns mode returns CSV metadata without persisting', async () => {
  importState.calls.length = 0

  const response = await postMode('columns')

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    header: ['date', 'amount', 'description'],
    sample: [['2026-08-23', '10.00', 'Deposit']],
    rowCount: 2,
  })
  assert.equal(importState.calls.length, 0)
})

test('preview mode invokes the importer in dry-run mode', async () => {
  importState.calls.length = 0

  const response = await postMode('preview')

  assert.equal(response.status, 200)
  assert.equal(importState.calls.length, 1)
  assert.equal(importState.calls[0]?.options.dryRun, true)
  assert.deepEqual(importState.calls[0]?.context, { orgId: 'org-1', userId: 'user-1' })
  assert.equal((await response.json()).statementId, null)
})

test('import mode invokes the importer with persistence enabled', async () => {
  importState.calls.length = 0

  const response = await postMode('import')
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(importState.calls.length, 1)
  assert.equal(importState.calls[0]?.options.dryRun, false)
  assert.equal(body.statementId, 'statement-1')
  assert.equal('lines' in body, false)
})

test('an invalid mode is rejected before persistence', async () => {
  importState.calls.length = 0

  const response = await postMode('unexpected')

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'mode must be columns, preview or import' })
  assert.equal(importState.calls.length, 0)
})
