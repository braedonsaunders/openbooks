import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route boundary for app status and uninstall. Helpers return this request's
// affected-row count (or throw). {ok:true} is only returned when that count
// is greater than zero — a void resolve is a refusal, not success.

const stateKey = Symbol.for('openbooks.app-key-route-test')

interface AppWrite {
  affectedRows: number
}

interface RouteState {
  setAppStatus: (
    orgId: string,
    userId: string,
    key: string,
    status: string,
  ) => Promise<AppWrite | void>
  deleteApp: (orgId: string, userId: string, key: string) => Promise<AppWrite | void>
  setCalls: Array<{ orgId: string; userId: string; key: string; status: string }>
  deleteCalls: Array<{ orgId: string; userId: string; key: string }>
}

const state: RouteState = {
  setAppStatus: async () => ({ affectedRows: 1 }),
  deleteApp: async () => ({ affectedRows: 1 }),
  setCalls: [],
  deleteCalls: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mockSources = new Map<string, string>([
  [
    'mock:next',
    `
      export class NextResponse {
        constructor(body, init = {}) {
          this._body = body
          this.status = init.status ?? 200
        }
        static json(body, init = {}) {
          return new NextResponse(JSON.stringify(body), init)
        }
        async json() { return JSON.parse(this._body) }
      }
    `,
  ],
  [
    'mock:gates',
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
  ],
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        const body = await request.json().catch(() => undefined)
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return { ok: false, response: { status: 400, json: async () => ({ error: 'invalid request body' }) } }
        }
        return { ok: true, data: body }
      }
    `,
  ],
  [
    'mock:store',
    `
      const state = globalThis[Symbol.for('openbooks.app-key-route-test')]
      export class AppError extends Error {
        constructor(message, status = 400) {
          super(message)
          this.status = status
          this.name = 'AppError'
        }
      }
      export async function getAppByKey() { return null }
      export async function setAppStatus(orgId, userId, key, status) {
        state.setCalls.push({ orgId, userId, key, status })
        return state.setAppStatus(orgId, userId, key, status)
      }
      export async function deleteApp(orgId, userId, key) {
        state.deleteCalls.push({ orgId, userId, key })
        return state.deleteApp(orgId, userId, key)
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['next/server', 'mock:next'],
  ['@/lib/feature-gates', 'mock:gates'],
  ['@/lib/api/json', 'mock:json'],
  ['@/lib/apps/store', 'mock:store'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
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

const { PATCH, DELETE } = (await import('./route.ts?app-key-route-test')) as typeof import('./route.ts')
const store = (await import('@/lib/apps/store')) as {
  AppError: new (message: string, status?: number) => Error & { status: number }
}
hooks.deregister()

function reset(): void {
  state.setAppStatus = async () => ({ affectedRows: 1 })
  state.deleteApp = async () => ({ affectedRows: 1 })
  state.setCalls = []
  state.deleteCalls = []
}

function patch(key: string, body: Record<string, unknown>) {
  return PATCH(
    new Request(`http://openbooks.test/api/apps/${key}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  )
}

function remove(key: string) {
  return DELETE(new Request(`http://openbooks.test/api/apps/${key}`, { method: 'DELETE' }), {
    params: Promise.resolve({ key }),
  })
}

test('PATCH refuses when setAppStatus still returns void', async () => {
  reset()
  state.setAppStatus = async () => undefined
  const response = await patch('ledger', { status: 'disabled' })
  assert.equal(response.status, 409)
  const body = (await response.json()) as { ok?: unknown; error: string }
  assert.equal(body.ok, undefined)
  assert.match(body.error, /was not changed to disabled/)
})

test('PATCH refuses a zero-row setAppStatus outcome', async () => {
  reset()
  state.setAppStatus = async () => ({ affectedRows: 0 })
  const response = await patch('ledger', { status: 'disabled' })
  assert.equal(response.status, 409)
  assert.equal(((await response.json()) as { ok?: unknown }).ok, undefined)
})

test('PATCH surfaces setAppStatus 404 instead of {ok:true} when the scoped app is missing', async () => {
  reset()
  state.setAppStatus = async () => {
    throw new store.AppError(
      'App "ghost" was not found in this organization. Install it or GET /api/apps/ghost to confirm the key before changing status.',
      404,
    )
  }
  const response = await patch('ghost', { status: 'disabled' })
  assert.equal(response.status, 404)
  const body = (await response.json()) as { ok?: unknown; error: string }
  assert.equal(body.ok, undefined)
  assert.match(body.error, /not found/)
  assert.equal(state.setCalls.length, 1)
})

test('PATCH surfaces setAppStatus 409 when the status is already current', async () => {
  reset()
  state.setAppStatus = async () => {
    throw new store.AppError(
      'App "ledger" is already disabled. PATCH status to "installed" if you need a status change.',
      409,
    )
  }
  const response = await patch('ledger', { status: 'disabled' })
  assert.equal(response.status, 409)
  const body = (await response.json()) as { ok?: unknown; error: string }
  assert.equal(body.ok, undefined)
  assert.match(body.error, /already disabled/)
})

test('PATCH reports {ok:true} only when setAppStatus returns affectedRows > 0', async () => {
  reset()
  const response = await patch('ledger', { status: 'disabled' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(state.setCalls, [{ orgId: 'org-1', userId: 'user-1', key: 'ledger', status: 'disabled' }])
})

test('DELETE refuses when deleteApp still returns void', async () => {
  reset()
  state.deleteApp = async () => undefined
  const response = await remove('ledger')
  assert.equal(response.status, 409)
  const body = (await response.json()) as { ok?: unknown; error: string }
  assert.equal(body.ok, undefined)
  assert.match(body.error, /was not uninstalled/)
})

test('DELETE surfaces deleteApp 404 instead of {ok:true} when the scoped app is missing', async () => {
  reset()
  state.deleteApp = async () => {
    throw new store.AppError(
      'App "ghost" was not found in this organization. Confirm the key is installed here before uninstalling.',
      404,
    )
  }
  const response = await remove('ghost')
  assert.equal(response.status, 404)
  const body = (await response.json()) as { ok?: unknown; error: string }
  assert.equal(body.ok, undefined)
  assert.match(body.error, /not found/)
  assert.match(body.error, /uninstall/)
})

test('DELETE reports {ok:true} after a history-preserving uninstall with affectedRows > 0', async () => {
  reset()
  state.deleteApp = async () => ({ affectedRows: 1 })
  const response = await remove('ledger')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(state.deleteCalls, [{ orgId: 'org-1', userId: 'user-1', key: 'ledger' }])
})

test('DELETE surfaces deleteApp 409 when the in-transaction write matches zero rows', async () => {
  reset()
  state.deleteApp = async () => {
    throw new store.AppError(
      'App "ledger" was not uninstalled. Confirm the app is still visible in this organization and retry.',
      409,
    )
  }
  const response = await remove('ledger')
  assert.equal(response.status, 409)
  const body = (await response.json()) as { ok?: unknown; error: string }
  assert.equal(body.ok, undefined)
  assert.match(body.error, /was not uninstalled/)
})
