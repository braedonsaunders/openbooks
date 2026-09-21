import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// resolveFormLayout is server-only and database-backed. Stub the database
// (never validation). Callers pass production role KEYS (authz.user.roles[].key);
// persisted allowedRoles are app_roles.id UUIDs. Matching keys to UUIDs is
// impossible — the resolver must read the user's assigned role ids.
// react cache keys on arguments, so every case uses its own org.

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '@openbooks/engine/src/platform/db.ts') {
      return {
        shortCircuit: true,
        format: 'module',
        url: 'data:text/javascript,export const db = globalThis.__resolveFormRolesDb',
      }
    }
    return nextResolve(specifier, context)
  },
})

type Row = Record<string, unknown>
;(globalThis as Record<string, unknown>).__resolveFormRolesDb = {
  formRows: [] as Row[],
  heldRoleIds: [] as string[],
  prefLayoutId: null as string | null,
  async execute(query: unknown) {
    const state = (globalThis as Record<string, unknown>).__resolveFormRolesDb as {
      formRows: Row[]
      heldRoleIds: string[]
      prefLayoutId: string | null
    }
    let text = ''
    try {
      text = JSON.stringify(query)
    } catch {
      text = String(query)
    }
    if (text.includes('role_assignments') || text.includes('app_roles')) {
      return { rows: state.heldRoleIds.map((id) => ({ id })) }
    }
    if (text.includes('user_form_preferences')) {
      return { rows: state.prefLayoutId ? [{ layoutId: state.prefLayoutId }] : [] }
    }
    return { rows: state.formRows }
  },
}

const { resolveFormLayout } = await import('./resolve.ts')
const { defaultFormLayout } = await import('@openbooks/customization')

const ROLE_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ROLE_ID = '22222222-2222-4222-8222-222222222222'
const LAYOUT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function formRow(overrides: Row = {}): Row {
  return {
    id: LAYOUT_ID,
    name: 'Restricted',
    recordType: 'vendor_bill',
    isDefault: true,
    isActive: true,
    allowedRoles: 'admin',
    layout: defaultFormLayout('vendor_bill'),
    ...overrides,
  }
}

async function resolve(
  formRows: Row[],
  userRoles: string[],
  org: string,
  heldRoleIds: string[] = [],
) {
  const state = (globalThis as Record<string, unknown>).__resolveFormRolesDb as {
    formRows: Row[]
    heldRoleIds: string[]
    prefLayoutId: string | null
  }
  state.formRows = formRows
  state.heldRoleIds = heldRoleIds
  state.prefLayoutId = null
  return resolveFormLayout({
    orgId: org,
    userId: 'user-1',
    recordType: 'vendor_bill',
    userRoles,
    headerDefs: [],
    lineDefs: [],
  })
}

test('resolveFormLayout does not throw when stored allowedRoles is a non-array', async () => {
  let resolved
  try {
    resolved = await resolve([formRow({ allowedRoles: 'admin' })], ['clerk'], 'org-malformed-string')
  } catch (error) {
    assert.fail(`resolveFormLayout threw on a stored string allowedRoles: ${(error as Error).message}`)
  }
  assert.equal(resolved.source, 'system')
  assert.equal(resolved.row, null)
  assert.equal(resolved.available.length, 0)
})

test('resolveFormLayout does not throw when stored allowedRoles is a non-UUID list', async () => {
  let resolved
  try {
    resolved = await resolve([formRow({ allowedRoles: ['admin'] })], ['admin'], 'org-malformed-keys')
  } catch (error) {
    assert.fail(`resolveFormLayout threw on a stored non-UUID allowedRoles: ${(error as Error).message}`)
  }
  assert.equal(resolved.source, 'system')
  assert.equal(resolved.row, null)
  assert.equal(resolved.available.length, 0)
})

test('a clerk who holds the gated role id can use the form', async () => {
  const resolved = await resolve(
    [formRow({ allowedRoles: [ROLE_ID] })],
    ['clerk'],
    'org-clerk-holds-gate',
    [ROLE_ID],
  )
  assert.equal(resolved.source, 'org')
  assert.equal(resolved.row?.id, LAYOUT_ID)
  assert.equal(resolved.available.length, 1)
})

test('a clerk who holds a different role id cannot use the gated form', async () => {
  const resolved = await resolve(
    [formRow({ allowedRoles: [OTHER_ROLE_ID] })],
    ['clerk'],
    'org-clerk-other-role',
    [ROLE_ID],
  )
  assert.equal(resolved.source, 'system')
  assert.equal(resolved.row, null)
  assert.equal(resolved.available.length, 0)
})

test('a UUID stuffed into userRoles does not grant access', async () => {
  const resolved = await resolve(
    [formRow({ allowedRoles: [ROLE_ID] })],
    [ROLE_ID],
    'org-impossible-userRoles',
    [],
  )
  assert.equal(resolved.source, 'system')
  assert.equal(resolved.row, null)
  assert.equal(resolved.available.length, 0)
})
