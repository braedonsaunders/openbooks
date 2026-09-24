import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.admin-email-scope-test')
const state: { allowedSubsidiaryIds: Set<string> | null; saves: unknown[] } = {
  allowedSubsidiaryIds: null,
  saves: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

let authzUrl = ''
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { format: 'module', source: '', shortCircuit: true, url: 'data:text/javascript,export {}' }
    if (specifier === '../../../../lib/authz' && context.parentURL?.includes('/admin/email/route')) {
      authzUrl = nextResolve(specifier, context).url
      const source = `
        export { guardUnrestrictedScope } from ${JSON.stringify(authzUrl)};
        const state = globalThis[Symbol.for('openbooks.admin-email-scope-test')];
        export async function guardPermission() {
          return { user: { orgId: 'org-1', id: 'actor-1' }, allowedSubsidiaryIds: state.allowedSubsidiaryIds };
        }
      `
      return { format: 'module', source, shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` }
    }
    if (specifier === '@openbooks/engine/src/delivery/email-config.ts') {
      const source = `
        const state = globalThis[Symbol.for('openbooks.admin-email-scope-test')];
        export class OrgEmailConfigConflictError extends Error {}
        export async function readOrgEmailConfigView() { return {} }
        export async function saveOrgEmailConfig(...args) { state.saves.push(args); return { updatedAt: '2' } }
      `
      return { format: 'module', source, shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(source)}` }
    }
    return nextResolve(specifier, context)
  },
})

const { PUT } = await import('./route.ts')
hooks.deregister()

test('restricted actors cannot change the organization outbound email transport', async () => {
  state.allowedSubsidiaryIds = new Set(['subsidiary-a'])
  state.saves.length = 0
  const response = await PUT(new Request('http://localhost/api/admin/email', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedUpdatedAt: '1', enabled: false, provider: 'smtp' }),
  }))
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'requires unrestricted subsidiary access' })
  assert.deepEqual(state.saves, [], 'no organization email settings reach the storage service')
})
