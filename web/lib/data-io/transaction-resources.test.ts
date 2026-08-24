import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { DOC_KINDS } from '../document-kinds.ts'

interface TransactionImportState {
  failLineInsert: boolean
  transactionCalls: number
  rootInsertCalls: number
  transactionInsertTargets: string[]
  rollbacks: number
  documents: Record<string, unknown>[]
  lines: Record<string, unknown>[]
  attemptedLines: Record<string, unknown>[]
}

const stateKey = Symbol.for('openbooks.transaction-import-test')
const importState: TransactionImportState = {
  failLineInsert: false,
  transactionCalls: 0,
  rootInsertCalls: 0,
  transactionInsertTargets: [],
  rollbacks: 0,
  documents: [],
  lines: [],
  attemptedLines: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = importState

const mockSources = new Map<string, string>([
  [
    'mock:drizzle',
    `
      export function sql(strings, ...values) {
        return { strings, values }
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.transaction-import-test')]
      const documentId = 'document-1'

      export const schema = {
        documents: Symbol.for('openbooks.transaction-import-test.documents'),
        documentLines: Symbol.for('openbooks.transaction-import-test.document-lines'),
      }

      function insertTargetName(target) {
        if (target === schema.documents) return 'documents'
        if (target === schema.documentLines) return 'documentLines'
        throw new Error('unexpected insert target')
      }

      function insertInto(target, pending) {
        return {
          values(values) {
            if (target === schema.documents) {
              return {
                async returning() {
                  pending.documents.push({ ...values, id: documentId })
                  return [{ id: documentId }]
                },
              }
            }
            if (target === schema.documentLines) {
              return Promise.resolve().then(() => {
                const lines = Array.isArray(values) ? values : [values]
                state.attemptedLines.push(...lines)
                if (state.failLineInsert) {
                  throw new Error('forced document line insert failure')
                }
                pending.lines.push(...lines)
              })
            }
            throw new Error('unexpected insert target')
          },
        }
      }

      export const db = {
        async execute() {
          return { rows: [{ base_currency: 'CAD' }] }
        },
        insert(target) {
          state.rootInsertCalls++
          return insertInto(target, state)
        },
        async transaction(callback) {
          state.transactionCalls++
          const pending = { documents: [], lines: [] }
          try {
            const result = await callback({
              insert(target) {
                state.transactionInsertTargets.push(insertTargetName(target))
                return insertInto(target, pending)
              },
            })
            state.documents.push(...pending.documents)
            state.lines.push(...pending.lines)
            return result
          } catch (error) {
            state.rollbacks++
            throw error
          }
        },
      }
    `,
  ],
  [
    'mock:posting',
    `
      export async function postDocument() {
        throw new Error('postDocument is not expected in this test')
      }
    `,
  ],
  [
    'mock:documents',
    `
      export async function controlDeps() {
        throw new Error('controlDeps is not expected in this test')
      }

      export async function nextDocumentNumber() {
        return 'CC-000001'
      }
    `,
  ],
  [
    'mock:resource-core',
    `
      export const MAX_EXPORT_ROWS = 50_000

      export async function orgFeatureEnabled() {
        return false
      }

      export class RefResolver {
        async resolveId(target, human) {
          if (target.resource === 'accounts' && String(human) === '5000') {
            return 'account-1'
          }
          return null
        }
      }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { url: 'data:text/javascript,export {}', format: 'module', shortCircuit: true }
    }
    const mockUrl = new Map([
      ['drizzle-orm', 'mock:drizzle'],
      ['@openbooks/engine/src/db.ts', 'mock:db'],
      ['@openbooks/engine/src/posting.ts', 'mock:posting'],
      ['../documents', 'mock:documents'],
      ['./resource-core', 'mock:resource-core'],
    ]).get(specifier)
    if (mockUrl) return { url: mockUrl, shortCircuit: true }
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

const resourceUrl = './transaction-resources.ts?atomic-import-test'
const { transactionResource } = await import(resourceUrl) as typeof import('./transaction-resources.ts')
hooks.deregister()

function resetImportState(failLineInsert: boolean): void {
  importState.failLineInsert = failLineInsert
  importState.transactionCalls = 0
  importState.rootInsertCalls = 0
  importState.transactionInsertTargets.length = 0
  importState.rollbacks = 0
  importState.documents.length = 0
  importState.lines.length = 0
  importState.attemptedLines.length = 0
}

async function importCardCharge() {
  const cfg = DOC_KINDS.card_charge
  assert.ok(cfg)
  return transactionResource(cfg, 'org-1').write(
    [
      {
        documentDate: '2026-08-24',
        account: '5000',
        amount: '999999999999999.1234',
      },
    ],
    'insert',
    { orgId: 'org-1', actorId: 'actor-1', dryRun: false },
  )
}

test('transaction import rolls back its draft when line persistence fails', async () => {
  resetImportState(true)

  const outcome = await importCardCharge()

  assert.deepEqual(outcome, {
    created: 0,
    updated: 0,
    failed: 1,
    errors: [{ row: 1, message: 'forced document line insert failure' }],
  })
  assert.equal(importState.transactionCalls, 1)
  assert.equal(importState.rootInsertCalls, 0)
  assert.deepEqual(
    importState.transactionInsertTargets,
    ['documents', 'documentLines'],
  )
  assert.equal(importState.rollbacks, 1)
  assert.equal(importState.attemptedLines[0]?.amount, '999999999999999.1234')
  assert.deepEqual(
    importState.documents,
    [],
    'the failed row must not leave an orphan draft',
  )
  assert.deepEqual(importState.lines, [])
})

test('transaction import commits its draft and lines together', async () => {
  resetImportState(false)

  const outcome = await importCardCharge()

  assert.deepEqual(outcome, { created: 1, updated: 0, failed: 0, errors: [] })
  assert.equal(importState.transactionCalls, 1)
  assert.equal(importState.rootInsertCalls, 0)
  assert.deepEqual(
    importState.transactionInsertTargets,
    ['documents', 'documentLines'],
  )
  assert.equal(importState.rollbacks, 0)
  assert.deepEqual(importState.documents, [
    {
      orgId: 'org-1',
      kind: 'card_charge',
      documentNumber: 'CC-000001',
      partyId: null,
      documentDate: '2026-08-24',
      dueDate: null,
      currency: 'CAD',
      referenceNumber: null,
      memo: null,
      status: 'draft',
      createdBy: 'actor-1',
      id: 'document-1',
    },
  ])
  assert.deepEqual(importState.lines, [
    {
      orgId: 'org-1',
      documentId: 'document-1',
      lineNumber: 1,
      accountId: 'account-1',
      description: null,
      amount: '999999999999999.1234',
      taxCodeId: null,
      createdBy: 'actor-1',
    },
  ])
})
