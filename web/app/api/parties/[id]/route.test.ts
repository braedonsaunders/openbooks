import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.party-route-hold-test')

interface ExistingParty {
  display_name: string
  is_active: boolean
  updated_at: string
  customer_hold: boolean
  customer_hold_reason: string | null
  vendor_hold: boolean
  vendor_hold_reason: string | null
  subsidiaryId: string | null
  before: Record<string, unknown>
}

interface DbCall {
  text: string
  values: unknown[]
}

interface RouteState {
  calls: DbCall[]
  existing: ExistingParty
}

const PARTY_ID = '00000000-0000-4000-8000-00000000a401'
const REVISION = '2026-08-24T12:00:00.400001Z'
const routeState: RouteState = {
  calls: [],
  existing: {
    display_name: 'Test party',
    is_active: true,
    updated_at: REVISION,
    customer_hold: false,
    customer_hold_reason: null,
    vendor_hold: false,
    vendor_hold_reason: null,
    subsidiaryId: null,
    before: {},
  },
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string' || typeof chunk === 'number' || typeof chunk === 'boolean') return String(chunk)
      const value = (chunk as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      return (chunk as { queryChunks?: unknown[] })?.queryChunks ? sqlText(chunk) : ''
    })
    .join('')
}

;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlTextParty?: unknown }).openbooksSqlTextParty = sqlText

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.party-route-hold-test')]
      const sqlText = globalThis.openbooksSqlTextParty
      const record = (query) => {
        const text = sqlText(query)
        state.calls.push({ text, values: (query.queryChunks ?? []).flatMap((chunk) => {
          if (chunk === null || typeof chunk !== 'object') return [chunk]
          return []
        }) })
        if (text.includes('select p.display_name')) return Promise.resolve({ rows: [state.existing] })
        if (text.includes('update parties set')) return Promise.resolve({ rows: [{ id: '${PARTY_ID}' }] })
        return Promise.resolve({ rows: [] })
      }
      export const db = {
        execute: record,
        transaction: async (fn) => fn({ execute: record }),
      }
      export const schema = {}
      export const pool = {}
      export const env = {}
      export function registerRequestOrgResolver() {}
      export async function withBypassContext(fn) { return fn() }
    `,
  ],
  [
    'mock:authz',
    `
      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
      export function guardSubsidiaryScope() { return null }
      export function subsidiariesInScope() { return true }
    `,
  ],
  ['mock:features', `export async function isFeatureEnabled() { return true }`],
  [
    'mock:custom-fields',
    `
      export async function loadFieldDefs() { return [] }
      export function validateCustomValues(_defs, values) { return { ok: true, errors: {}, cleaned: values ?? {} } }
    `,
  ],
  ['mock:list-params', `export function isUuid(value) { return typeof value === 'string' && value.length > 0 }`],
  [
    'mock:countries',
    `
      export function normalizeCountryCode(value) {
        if (typeof value !== 'string') return null
        const normalized = value.trim().toUpperCase()
        return normalized.length === 2 ? normalized : null
      }
    `,
  ],
  [
    'mock:party-loader',
    `
      export async function loadParty(id) {
        return { party: { id }, customer: null, vendor: null, employee: null, addresses: [], contacts: [], bankAccounts: [], transactionSummary: { count: 0, openCount: 0, lastDate: null, currencies: [] }, additionalSubsidiaryIds: [] }
      }
    `,
  ],
  [
    'mock:exact-decimal',
    `
      export function canonicalDecimal(value) { return String(value) }
      export function compareDecimal(left, right) { return Number(left) - Number(right) }
      export function fixedDecimal(value) { return String(value) }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['../../../../lib/authz', 'mock:authz'],
  ['../../../../lib/features', 'mock:features'],
  ['../../../../lib/custom-fields', 'mock:custom-fields'],
  ['../../../../lib/list-params', 'mock:list-params'],
  ['../../../../lib/countries', 'mock:countries'],
  ['../../../../lib/exact-decimal', 'mock:exact-decimal'],
  ['../_lib', 'mock:party-loader'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier === '@/lib/api/json') return { shortCircuit: true, format: 'module', url: 'mock:json' }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:json') {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          export const jsonObject = {}
          export async function parseJsonBody(req) { return { ok: true, data: await req.json() } }
        `,
      }
    }
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?party-hold-test'
const { PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(existing: Partial<ExistingParty> = {}): void {
  routeState.calls.length = 0
  routeState.existing = {
    display_name: 'Test party',
    is_active: true,
    updated_at: REVISION,
    customer_hold: false,
    customer_hold_reason: null,
    vendor_hold: false,
    vendor_hold_reason: null,
    subsidiaryId: null,
    before: {},
    ...existing,
  }
}

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/parties/${PARTY_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedUpdatedAt: REVISION, ...body }),
    }),
    { params: Promise.resolve({ id: PARTY_ID }) },
  )
}

function roleCall(role: 'customer' | 'vendor'): DbCall {
  const call = routeState.calls.find(({ text }) => text.includes(`insert into ${role}_roles`))
  assert.ok(call, `${role} role upsert should run`)
  return call
}

function writeCalls(): DbCall[] {
  return routeState.calls.filter(({ text }) => text.includes('update parties set') || text.includes('insert into customer_roles') || text.includes('insert into vendor_roles'))
}

test('customer role updates preserve an existing hold and reason when omitted', async () => {
  reset({ customer_hold: true, customer_hold_reason: 'credit review' })

  const response = await patch({ roles: { customer: { enabled: true } } })

  assert.equal(response.status, 200)
  const call = roleCall('customer')
  assert.ok(call.values.includes(true), 'the existing customer hold remains enabled')
  assert.ok(call.values.includes('credit review'), 'the existing customer hold reason remains attached')
})

test('vendor role updates preserve an existing hold and reason when omitted', async () => {
  reset({ vendor_hold: true, vendor_hold_reason: 'payment review' })

  const response = await patch({ roles: { vendor: { enabled: true } } })

  assert.equal(response.status, 200)
  const call = roleCall('vendor')
  assert.ok(call.values.includes(true), 'the existing vendor hold remains enabled')
  assert.ok(call.values.includes('payment review'), 'the existing vendor hold reason remains attached')
})

test('customer hold release without a change reason is refused before any write', async () => {
  reset({ customer_hold: true, customer_hold_reason: 'credit review' })

  const response = await patch({ roles: { customer: { enabled: true, isOnHold: false } } })

  assert.equal(response.status, 422)
  assert.equal(writeCalls().length, 0)
})

test('vendor hold release without a change reason is refused before any write', async () => {
  reset({ vendor_hold: true, vendor_hold_reason: 'payment review' })

  const response = await patch({ roles: { vendor: { enabled: true, isOnHold: false } } })

  assert.equal(response.status, 422)
  assert.equal(writeCalls().length, 0)
})
