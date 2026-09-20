import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// resolveFormLayout is server-only and database-backed. Stub the database
// (never validation): a stored allowedRoles that is not an array of UUIDs
// used to throw on `.some` and take every form for that record type down.
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
  calls: 0,
  formRows: [] as Row[],
  prefLayoutId: null as string | null,
  async execute() {
    const state = (globalThis as Record<string, unknown>).__resolveFormRolesDb as {
      calls: number
      formRows: Row[]
      prefLayoutId: string | null
    }
    state.calls += 1
    if (state.calls === 1) return { rows: state.formRows }
    return { rows: state.prefLayoutId ? [{ layoutId: state.prefLayoutId }] : [] }
  },
}

const { resolveFormLayout } = await import('./resolve.ts')
const { defaultFormLayout } = await import('@openbooks/customization')

const ROLE_ID = '11111111-1111-4111-8111-111111111111'
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

async function resolve(formRows: Row[], userRoles: string[], org: string) {
  const state = (globalThis as Record<string, unknown>).__resolveFormRolesDb as {
    calls: number
    formRows: Row[]
    prefLayoutId: string | null
  }
  state.calls = 0
  state.formRows = formRows
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

test('resolveFormLayout still serves a form gated to a UUID the user holds', async () => {
  const resolved = await resolve([formRow({ allowedRoles: [ROLE_ID] })], [ROLE_ID], 'org-valid-uuid')
  assert.equal(resolved.source, 'org')
  assert.equal(resolved.row?.id, LAYOUT_ID)
  assert.equal(resolved.available.length, 1)
})
