import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.form-options-permission-test')
interface RouteState {
  permissions: Set<string>
  signedIn: boolean
  scope: Set<string> | null
  queries: number
}
const routeState: RouteState = {
  permissions: new Set(),
  signedIn: true,
  scope: null,
  queries: 0,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.form-options-permission-test')]
      export async function getAuthz() {
        if (!state.signedIn) return null
        return { user: { orgId: 'org-1', id: 'user-1' }, permissions: state.permissions, allowedSubsidiaryIds: state.scope }
      }
      export function can(authz, perm) {
        return authz.permissions.has('*') || authz.permissions.has(perm)
      }
    `,
  ],
  [
    'mock:subsidiaries',
    `
      // Scope SHAPE is preserved (null passthrough vs empty-set fence) while
      // the SQL fragment is a stub: the mock db never executes the query.
      // Subsidiary predicate semantics are covered by values.integration.test.ts.
      export function subsidiaryVisibleFilter(column, allowed) {
        return allowed === null ? '' : ' and false'
      }
    `,
  ],
  [
    'mock:projects-gate',
    `
      export async function guardProjectsFeature() { return null }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.form-options-permission-test')]
      export const db = {
        async execute() {
          state.queries += 1
          return { rows: [] }
        },
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['../../../../lib/authz', 'mock:authz'],
  ['../../../../lib/subsidiaries', 'mock:subsidiaries'],
  ['../../../../lib/projects-gate', 'mock:projects-gate'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    if (specifier.startsWith('@openbooks/forms-core') && context.parentURL) {
      return nextResolve(new URL('../../../../../packages/forms-core/src/index.ts', context.parentURL).href, context)
    }
    return nextResolve(specifier)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?form-options-permission-test'
const { GET } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(permissions: string[] = [], scope: Set<string> | null = null): void {
  routeState.permissions = new Set(permissions)
  routeState.signedIn = true
  routeState.scope = scope
  routeState.queries = 0
}

function get(url: string): Promise<Response> {
  return GET(new Request(`http://openbooks.test${url}`))
}

test('signed-out callers are 401s', async () => {
  reset()
  routeState.signedIn = false

  const response = await get('/api/forms/options?source=parties')

  assert.equal(response.status, 401)
  assert.equal(routeState.queries, 0)
})

test('parties enumeration without parties.read is a 403', async () => {
  reset(['records.read'])

  const response = await get('/api/forms/options?source=parties')

  assert.equal(response.status, 403)
  assert.match(((await response.json()) as { error: string }).error, /parties\.read/)
  assert.equal(routeState.queries, 0)
})

test('parties.read unlocks the parties picker', async () => {
  reset(['parties.read'])

  const response = await get('/api/forms/options?source=parties')

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { options: [] })
  assert.equal(routeState.queries, 1)
})

test('gl_accounts enumeration without gl.read is a 403', async () => {
  reset(['parties.read'])

  const response = await get('/api/forms/options?source=gl_accounts')

  assert.equal(response.status, 403)
  assert.match(((await response.json()) as { error: string }).error, /gl\.read/)
  assert.equal(routeState.queries, 0)
})

test('gl.read unlocks the accounts picker', async () => {
  reset(['gl.read'])

  const response = await get('/api/forms/options?source=gl_accounts')

  assert.equal(response.status, 200)
  assert.equal(routeState.queries, 1)
})

test('reference tables demand their own read permission', async () => {
  for (const [table, permission] of [
    ['parties', 'parties.read'],
    ['accounts', 'gl.read'],
    ['projects', 'projects.read'],
    ['items', 'items.read'],
  ] as const) {
    reset(['records.read'])
    const denied = await get(`/api/forms/options?source=reference&table=${table}`)
    assert.equal(denied.status, 403)
    assert.match(((await denied.json()) as { error: string }).error, new RegExp(permission.replace('.', '\\.')))

    reset([permission])
    const allowed = await get(`/api/forms/options?source=reference&table=${table}`)
    assert.equal(allowed.status, 200)
  }
})

test('an empty subsidiary scope still discloses nothing', async () => {
  reset(['parties.read'], new Set())

  const response = await get('/api/forms/options?source=parties')

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { options: [] })
  assert.equal(routeState.queries, 0)
})

test('unknown sources stay 400s', async () => {
  reset(['*'])

  const response = await get('/api/forms/options?source=bogus')

  assert.equal(response.status, 400)
})
