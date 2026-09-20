import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Member routes must refuse a non-UUID [id] with HTTP 400 naming that the id
// must be a UUID, before any uuid-column bind. A 404 is the unknown-id
// contract and is the wrong refusal — this test fails if the status is 404.
// Auth, gates, and the database are stubbed so the only thing under test is
// that response contract.

const root = pathToFileURL(process.cwd() + '/').href
const stateKey = Symbol.for('openbooks.customization-id-uuid-guard')
const MALFORMED = ['not-a-uuid', 'new', '-'.repeat(36)] as const
const CANONICAL = '019f68a5-6a24-78ec-bed6-cc04e06f2078'

interface QueryState {
  statements: unknown[]
}
const state: QueryState = { statements: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

function collectPrimitives(node: unknown, out: unknown[]): void {
  if (node == null) return
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean' || typeof node === 'bigint') {
    out.push(node)
    return
  }
  if (typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) collectPrimitives(item, out)
    return
  }
  const record = node as Record<string, unknown>
  if (Array.isArray(record.queryChunks)) {
    collectPrimitives(record.queryChunks, out)
    return
  }
  if ('value' in record && (typeof record.value === 'string' || typeof record.value === 'number')) {
    out.push(record.value)
    return
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') collectPrimitives(value, out)
  }
}

function boundValues(): unknown[] {
  const out: unknown[] = []
  collectPrimitives(state.statements, out)
  return out
}

function resetQueries(): void {
  state.statements = []
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@/')) {
      return nextResolve(root + 'web/' + specifier.slice(2) + '.ts', context)
    }
    if (specifier === '@openbooks/engine/src/platform/db.ts') {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-id-db' }
    }
    if (specifier.endsWith('lib/authz')) {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-id-authz' }
    }
    if (specifier.endsWith('lib/customization/gates')) {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-id-gates' }
    }
    if (specifier.endsWith('lib/features')) {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-id-features' }
    }
    if (specifier.endsWith('lib/custom-fields')) {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-id-fields' }
    }
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-id-nav' }
    }
    if (specifier === 'next-intl/server') {
      return { shortCircuit: true, format: 'module', url: 'mock:customization-id-intl' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:customization-id-db') {
      return {
        format: 'module',
        source: `
          const state = globalThis[Symbol.for('openbooks.customization-id-uuid-guard')]
          const malformed = new Set(${JSON.stringify([...MALFORMED])})
          function refuse(query) {
            state.statements.push(query)
            const values = []
            const visit = (node) => {
              if (node == null) return
              if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
                values.push(node)
                return
              }
              if (typeof node !== 'object') return
              if (Array.isArray(node)) { for (const item of node) visit(item); return }
              if (Array.isArray(node.queryChunks)) { visit(node.queryChunks); return }
              if ('value' in node && (typeof node.value === 'string' || typeof node.value === 'number')) {
                values.push(node.value)
                return
              }
              for (const value of Object.values(node)) if (value && typeof value === 'object') visit(value)
            }
            visit(query)
            for (const value of values) {
              if (malformed.has(value)) throw new Error('uuid column bound a non-UUID string: ' + value)
            }
            return { rows: [] }
          }
          export const db = {
            execute: async (query) => refuse(query),
            transaction: async (fn) => fn({ execute: async (query) => refuse(query) }),
          }
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:customization-id-authz') {
      return {
        format: 'module',
        source: `
          export async function getAuthz() {
            return {
              user: { orgId: '00000000-0000-4000-8000-00000000a001', id: '00000000-0000-4000-8000-00000000a002' },
              permissions: new Set(['*']),
              allowedSubsidiaryIds: null,
            }
          }
          export function can() { return true }
          export async function guardPermission() {
            return {
              user: { orgId: '00000000-0000-4000-8000-00000000a001', id: '00000000-0000-4000-8000-00000000a002' },
              permissions: new Set(['*']),
              allowedSubsidiaryIds: null,
            }
          }
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:customization-id-gates') {
      return {
        format: 'module',
        source: `
          export async function refuseDisabledRecordType() { return null }
          export async function disabledRecordTypes() { return [] }
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:customization-id-features') {
      return {
        format: 'module',
        source: `
          export async function isFeatureEnabled() { return true }
          export async function subsidiaryFeatureEnabled() { return true }
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:customization-id-fields') {
      return { format: 'module', source: 'export async function loadFieldDefs() { return [] }', shortCircuit: true }
    }
    if (url === 'mock:customization-id-nav') {
      return {
        format: 'module',
        source: `
          export function redirect(url) { throw new Error('REDIRECT:' + url) }
          export function notFound() { throw new Error('NOT_FOUND') }
        `,
        shortCircuit: true,
      }
    }
    if (url === 'mock:customization-id-intl') {
      return {
        format: 'module',
        source: `
          export async function getTranslations() {
            return (key, vars) => vars ? key + ':' + JSON.stringify(vars) : key
          }
        `,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

const listViews = (await import('../../../../app/api/customization/list-views/[id]/route.ts')) as typeof import('../../../../app/api/customization/list-views/[id]/route.ts')
const formLayouts = (await import('../../../../app/api/customization/form-layouts/[id]/route.ts')) as typeof import('../../../../app/api/customization/form-layouts/[id]/route.ts')
const { loadCustomization } = (await import('./view.ts')) as typeof import('./view.ts')

type Verb = 'GET' | 'PATCH' | 'DELETE'

async function call(
  handlers: { GET: typeof listViews.GET; PATCH: typeof listViews.PATCH; DELETE: typeof listViews.DELETE },
  verb: Verb,
  id: string,
): Promise<{ status: number; json: unknown; thrown?: string }> {
  const handler = handlers[verb]
  try {
    const response = await handler(
      new Request(`http://custom.test/api/customization/${id}`, {
        method: verb,
        headers: { 'content-type': 'application/json' },
        body: verb === 'GET' ? undefined : JSON.stringify({}),
      }),
      { params: Promise.resolve({ id }) },
    )
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: null, thrown: error instanceof Error ? error.message : String(error) }
  }
}

for (const [label, handlers] of [
  ['list-views', listViews],
  ['form-layouts', formLayouts],
] as const) {
  for (const verb of ['GET', 'PATCH', 'DELETE'] as const) {
    test(`${label} ${verb} returns 400 for a non-UUID id and never queries`, async () => {
      for (const id of MALFORMED) {
        resetQueries()
        const result = await call(handlers, verb, id)
        assert.notEqual(
          result.status,
          404,
          `${label} ${verb} ${id}: malformed id must be 400, not the 404 unknown-id contract: ${JSON.stringify(result.json)}`,
        )
        assert.equal(
          result.status,
          400,
          `${label} ${verb} ${id}: expected 400, got ${result.status}: ${JSON.stringify(result.json)} ${result.thrown ?? ''}`,
        )
        assert.match(
          String((result.json as { error?: string } | null)?.error ?? ''),
          /must be a UUID/i,
          `${label} ${verb} ${id}: 400 must name that the id must be a UUID`,
        )
        assert.equal(state.statements.length, 0, `${label} ${verb} ${id} reached the database`)
      }
    })
  }

  test(`${label} GET still probes a canonical UUID (404 when missing)`, async () => {
    resetQueries()
    const result = await call(handlers, 'GET', CANONICAL)
    assert.equal(result.status, 404, JSON.stringify(result.json))
    assert.ok(state.statements.length > 0, `${label} GET must still query a well-formed id`)
    assert.ok(boundValues().includes(CANONICAL), `${label} GET must bind the canonical id`)
  })
}

test('admin loader never binds a malformed form/view/from id into a uuid column', async () => {
  resetQueries()
  const data = await loadCustomization({
    recordType: 'vendor_bill',
    form: 'not-a-uuid',
    view: '-'.repeat(36),
    from: 'not-a-uuid',
  })
  for (const bad of MALFORMED) {
    assert.equal(boundValues().includes(bad), false, `loader bound ${bad}`)
  }
  assert.equal(data.formDrawerOpen, false)
  assert.equal(data.viewDrawerOpen, false)
})
