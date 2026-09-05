import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextResponse } from 'next/server'

// Route boundary suite for the tax filing surface (no test file existed for
// this module). Regression for fnd_mtbnow2k_d89o5i: the Prepare (POST) and
// Mark Filed (PATCH) routes regressed to the report-creation permission,
// so any report creator could certify a statutory return as filed. The
// certification authority is compliance.file; these tests pin the exact
// permission string both entry points demand and prove a reports.create
// holder is refused.

interface EngineCall {
  op: 'compute' | 'markFiled'
  orgId: string
  userId: string
}

interface RouteState {
  permissions: Set<string>
  permissionChecks: string[]
  engineCalls: EngineCall[]
}

const stateKey = Symbol.for('openbooks.tax-filing-route-test')
const routeState: RouteState = {
  permissions: new Set(),
  permissionChecks: [],
  engineCalls: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksTaxFilingNextResponse =
  NextResponse

/** Flatten a drizzle SQL chunk into its raw text for keyword scripting. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((c) => {
      if (typeof c === 'string') return c
      const value = (c as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((c as { queryChunks?: unknown[] })?.queryChunks) return sqlText(c)
      return ''
    })
    .join('')
}
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlTextTaxFiling = sqlText

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
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.tax-filing-route-test')]
      const NextResponse = globalThis.openbooksTaxFilingNextResponse
      export function guardSubsidiaryScope(authz) {
        if (authz.allowedSubsidiaryIds !== null) throw new Error('unexpected scoped fixture')
        return null
      }
      export async function guardPermission(permission) {
        state.permissionChecks.push(permission)
        if (!state.permissions.has(permission)) {
          return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 })
        }
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.tax-filing-route-test')]
      const sqlText = globalThis.openbooksSqlTextTaxFiling
      export const db = {
        execute() { throw new Error('unexpected database query') },
        async transaction(work) {
          return work({
            execute(query) {
              const text = sqlText(query)
              if (text.includes('insert into tax_filings')) {
                return { rows: [{ id: 'filing-1', version: 2 }] }
              }
              if (text.includes('from tax_filings')) return { rows: [{ version: 2 }] }
              if (text.includes('from tax_return_forms')) return { rows: [{ country: 'US' }] }
              return { rows: [] }
            },
          })
        },
      }
    `,
  ],
  [
    'mock:tax-filing',
    `
      const state = globalThis[Symbol.for('openbooks.tax-filing-route-test')]
      export class TaxFilingError extends Error {
        constructor(code) { super(code); this.code = code }
      }
      export async function markTaxFilingFiled(orgId, id, userId) {
        state.engineCalls.push({ op: 'markFiled', orgId, userId })
        return { id, filedAt: '2026-08-24T00:00:00.000Z' }
      }
      export function buildTaxFilingSnapshot() {
        return { snapshot: { boxes: [] }, snapshotHash: 'hash-1' }
      }
    `,
  ],
  [
    'mock:tax-return',
    `
      const state = globalThis[Symbol.for('openbooks.tax-filing-route-test')]
      export async function computeTaxReturn(orgId, code, from, to) {
        state.engineCalls.push({ op: 'compute', orgId, userId: 'user-1' })
        return { formCode: code, formName: 'Form ' + code, from, to, submissionChannel: 'paper', boxes: [] }
      }
    `,
  ],
  [
    'mock:tax-nexus-ledger',
    `
      export async function loadOrgFilingCalendar() { return [] }
    `,
  ],
  [
    'mock:business-date',
    `
      export async function businessToday() { return '2026-08-24' }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['../../../../lib/authz', 'mock:authz'],
  ['../../../../../lib/authz', 'mock:authz'],
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['@openbooks/engine/src/tax-filing.ts', 'mock:tax-filing'],
  ['@openbooks/engine/src/tax-return.ts', 'mock:tax-return'],
  ['@openbooks/engine/src/tax-nexus-ledger.ts', 'mock:tax-nexus-ledger'],
  ['@openbooks/engine/src/business-date.ts', 'mock:business-date'],
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

const postRouteUrl = './route.ts?tax-filing-permission-test'
const { POST } = (await import(postRouteUrl)) as typeof import('./route.ts')
const patchRouteUrl = './[id]/route.ts?tax-filing-permission-test'
const { PATCH } = (await import(patchRouteUrl)) as typeof import('./[id]/route.ts')
hooks.deregister()

function reset(permissions: string[]): void {
  routeState.permissions = new Set(permissions)
  routeState.permissionChecks.length = 0
  routeState.engineCalls.length = 0
}

function post(): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/tax/filings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'GST-Q', from: '2026-01-01', to: '2026-03-31' }),
    }),
  )
}

function patch(filingId: string): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/tax/filings/${filingId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filingReference: 'REF-2026-042' }),
    }),
    { params: Promise.resolve({ id: filingId }) },
  )
}

test('POST prepare demands compliance.file and freezes the snapshot under it', async () => {
  reset(['compliance.file'])

  const response = await post()

  assert.equal(response.status, 201)
  assert.deepEqual(await response.json(), { id: 'filing-1', version: 2 })
  assert.deepEqual(routeState.permissionChecks, ['compliance.file'])
  assert.deepEqual(routeState.engineCalls, [{ op: 'compute', orgId: 'org-1', userId: 'user-1' }])
})

test('PATCH mark-filed demands compliance.file, not the report authority', async () => {
  reset(['compliance.file'])
  const filingId = randomUUID()

  const response = await patch(filingId)

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { id: filingId, filed_at: '2026-08-24T00:00:00.000Z' })
  assert.deepEqual(routeState.permissionChecks, ['compliance.file'])
  assert.deepEqual(routeState.engineCalls, [{ op: 'markFiled', orgId: 'org-1', userId: 'user-1' }])
})

test('a reports.create holder cannot certify a statutory filing', async () => {
  reset(['reports.create'])

  const response = await post()

  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'missing permission: compliance.file' })
  assert.deepEqual(routeState.permissionChecks, ['compliance.file'])
  assert.deepEqual(routeState.engineCalls, [], 'the refused certification never reached the engine')
})
