import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { resolveAppModule } from '../../../../lib/test-module-hooks'

const key = Symbol.for('openbooks.module-admin-route-test')
const state = { permissions: ['apps.manage', 'admin.customization.manage', 'admin.sandboxes.manage'], envKind: 'production' }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[key] = state
const root = new URL('../../../../../', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === 'mock:module-authz') return next(specifier, { ...context, parentURL: import.meta.url })
    if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier.endsWith('/authz') || specifier === '../authz') return { shortCircuit: true, url: 'mock:module-authz' }
    return resolveAppModule(specifier, context, next, root) ?? next(specifier, context)
  },
  load(url, context, next) {
    if (url !== 'mock:module-authz') return next(url, context)
    return { shortCircuit: true, format: 'module', source: `
      import { NextResponse } from 'next/server';
      const state = globalThis[Symbol.for('openbooks.module-admin-route-test')];
      export const can = (authz, permission) => authz.permissions.has(permission);
      export async function guardPermission(permission) {
        const authz = { user: { id:'00000000-0000-4000-8000-000000000001', orgId:'00000000-0000-4000-8000-000000000002', envKind:state.envKind }, permissions:new Set(state.permissions), allowedSubsidiaryIds:null };
        return can(authz, permission) ? authz : NextResponse.json({error:'forbidden'}, {status:403});
      }
      export const resolveUserAuthz = async () => { throw new Error('Unexpected sandbox identity resolution'); };
    ` }
  },
})
const { GET, POST } = await import('./route')
hooks.deregister()
const request = (data: unknown) => new Request('http://localhost/api/admin/modules', { method: 'POST', body: JSON.stringify(data) })

test('module admin routes require the list permission before reading or mutating', async () => {
  const prior = state.permissions
  state.permissions = []
  try {
    assert.equal((await GET(new Request('http://localhost/api/admin/modules'))).status, 403)
    assert.equal((await POST(request({ action: 'install', manifest: {} }))).status, 403)
  } finally { state.permissions = prior }
})

test('module admin mutations reject malformed commands and selected-module identity changes', async () => {
  for (const body of [
    { action: 'unknown' },
    { action: 'deactivate', key: 'example', reason: { text: 'not text' } },
    { action: 'install', key: 'selected-module', manifest: { key: 'another-module' } },
    { action: 'diff', key: 'selected-module', manifest: { key: 'another-module' } },
    { action: 'apply', gateId: '00000000-0000-4000-8000-000000000001', signature: '' },
    { action: 'stageRehearsal', sandboxOrgId: 'not-a-uuid', manifest: {} },
  ]) assert.equal((await POST(request(body))).status, 400, JSON.stringify(body))
})

test('an app manager cannot author modules without customization authority', async () => {
  const prior = state.permissions
  state.permissions = ['apps.manage']
  try { assert.equal((await POST(request({ action: 'install', manifest: {} }))).status, 403) }
  finally { state.permissions = prior }
})

test('sandbox promotion cannot be initiated from another sandbox session', async () => {
  state.envKind = 'sandbox'
  try { assert.equal((await POST(request({ action: 'promoteRehearsal', key: 'example', sandboxOrgId: '00000000-0000-4000-8000-000000000003' }))).status, 403) }
  finally { state.envKind = 'production' }
})
