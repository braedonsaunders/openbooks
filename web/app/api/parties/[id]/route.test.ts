import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.party-route-hold-test')

interface ExistingParty {
  display_name: string
  is_active: boolean
  kind: string
  has_customer_role: boolean
  has_vendor_role: boolean
  has_employee_role: boolean
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
    kind: 'company',
    has_customer_role: false,
    has_vendor_role: false,
    has_employee_role: false,
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
      export function ambientTenantOrgId() { return null }
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
      export async function findUnownedCustomReferences() { return [] }
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
])

// Neither the decimal classifier nor the money kernel is mocked: a hand
// double of either decides amount questions the real module would refuse,
// so the route's exact-decimal behavior below was never really tested.
const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['../../../../lib/authz', 'mock:authz'],
  ['../../../../lib/features', 'mock:features'],
  ['../../../../lib/custom-fields', 'mock:custom-fields'],
  ['../../../../lib/list-params', 'mock:list-params'],
  ['../../../../lib/countries', 'mock:countries'],
  ['../_lib', 'mock:party-loader'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    // '@/lib/api/json' is not mocked: never double the validation boundary.
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

const routeUrl = './route.ts?party-hold-test'
const { PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(existing: Partial<ExistingParty> = {}): void {
  routeState.calls.length = 0
  routeState.existing = {
    display_name: 'Test party',
    is_active: true,
    kind: 'company',
    has_customer_role: false,
    has_vendor_role: false,
    has_employee_role: false,
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

test('impossible hired-on dates are refused before the employee upsert', async () => {
  reset()

  const response = await patch({ roles: { employee: { enabled: true, hiredOn: '2026-02-30' } } })

  assert.equal(response.status, 422)
  assert.equal(
    routeState.calls.filter(({ text }) => text.includes('insert into employee_roles')).length,
    0,
  )
})

test('valid hired-on dates reach the employee upsert', async () => {
  reset()

  const response = await patch({ roles: { employee: { enabled: true, hiredOn: '2026-02-28' } } })

  assert.equal(response.status, 200)
  const call = routeState.calls.find(({ text }) => text.includes('insert into employee_roles'))
  assert.ok(call, 'the employee role upsert should run')
  assert.ok(call.values.includes('2026-02-28'), 'the valid hired-on date is stored')
})

test('edits echoing a backed role kind persist instead of 422ing (F-t05-002, OM-16)', async () => {
  // F-t05-002: parties store customer/employee/vendor kinds (the drawer
  // echoes the stored kind back), but PATCH only accepted company|person —
  // so EVERY save of an employee-kind party failed while the UI reported
  // success. OM-16 narrows the round-trip: a role kind persists only while
  // its role row backs it — the echo of a backed kind must still succeed.
  for (const kind of ['customer', 'vendor', 'employee']) {
    reset({
      kind,
      has_customer_role: kind === 'customer',
      has_vendor_role: kind === 'vendor',
      has_employee_role: kind === 'employee',
    })

    const response = await patch({ kind, shortCode: 'DE-001' })

    assert.equal(response.status, 200, `backed kind ${kind} must be accepted`)
    const call = routeState.calls.find(({ text }) => text.includes('update parties set'))
    assert.ok(call, `kind ${kind} must reach the party update`)
    assert.ok(call.values.includes(kind), `kind ${kind} must be stored`)
    assert.ok(call.values.includes('DE-001'), 'the short code must be stored alongside')
  }
})

test('an unbacked role kind is refused by name before any write (OM-16)', async () => {
  // OM-16: storing kind "vendor" with no vendor role strands a "Kind:
  // Vendor" no read can back. Naming the kind without enabling (or holding)
  // the role must refuse, with the remedy in the message.
  for (const kind of ['customer', 'vendor', 'employee']) {
    reset({ kind: 'company' })

    const response = await patch({ kind, shortCode: 'DE-001' })

    assert.equal(response.status, 422, `unbacked kind ${kind} must be refused`)
    const body = (await response.json()) as { error: string }
    assert.ok(
      body.error.includes(`kind "${kind}" needs the ${kind} role`),
      `the refusal must name the missing role, got: ${body.error}`,
    )
    assert.equal(writeCalls().length, 0, 'no role or party write may run')
  }
})

test('enabling the role alongside the kind heals the claim atomically (OM-16)', async () => {
  // The role-scoped drawer forces its role on every save, so opening a
  // kind-vendor party with ?role=vendor and saving must create the missing
  // role rather than refuse.
  reset({ kind: 'vendor', has_vendor_role: false })

  const response = await patch({ kind: 'vendor', roles: { vendor: { enabled: true } } })

  assert.equal(response.status, 200)
  assert.ok(
    routeState.calls.some(({ text }) => text.includes('insert into vendor_roles')),
    'the missing vendor role must be created by the same save',
  )
})

test('dropping the role a stored kind names is refused until the kind is renamed (OM-16)', async () => {
  reset({ kind: 'vendor', has_vendor_role: true })

  const refused = await patch({ roles: { vendor: { enabled: false } } })

  assert.equal(refused.status, 422)
  const body = (await refused.json()) as { error: string }
  assert.ok(
    body.error.includes('change kind to "company" or "person"'),
    `the refusal must name the remedy, got: ${body.error}`,
  )
  assert.equal(writeCalls().length, 0, 'no role or party write may run')

  reset({ kind: 'vendor', has_vendor_role: true })
  const renamed = await patch({ kind: 'company', roles: { vendor: { enabled: false } } })

  assert.equal(renamed.status, 200, 'renaming the kind alongside the drop must succeed')
})

test('an unknown party kind is still refused before any write', async () => {
  reset()

  const response = await patch({ kind: 'syndicate' })

  assert.equal(response.status, 422)
  assert.equal(writeCalls().length, 0)
})
