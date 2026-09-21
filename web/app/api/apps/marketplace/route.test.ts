import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Boundary suite for POST unpublish. The helper refuses an already-inactive
// listing under FOR UPDATE. The route also refuses that by name (and key)
// so a sequential second unpublish is never {ok:true} for a write no read
// can observe, and never calls the helper.
const stateKey = Symbol.for('openbooks.marketplace-unpublish-route-test')
type RouteState = {
  listingRows: { is_active: boolean }[]
  executeCalls: { text: string; values: unknown[] }[]
  unpublishCalls: { orgId: string; userId: string; key: string }[]
  unpublishError: { message: string; status: number } | null
}
const state: RouteState = {
  listingRows: [],
  executeCalls: [],
  unpublishCalls: [],
  unpublishError: null,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const ORG_ID = '00000000-0000-4000-8000-00000000c001'
const USER_ID = '00000000-0000-4000-8000-00000000c002'

const mockSources = new Map<string, string>([
  [
    'mock:json',
    `
      import { NextResponse } from 'next/server'
      export const jsonObject = { safeParse(value) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return { success: false, error: { issues: [{ path: [], message: 'invalid request body' }] } }
        }
        return { success: true, data: value }
      } }
      export async function parseJsonBody(request, schema) {
        if (!schema || typeof schema.safeParse !== 'function') {
          throw new Error('parseJsonBody requires a schema')
        }
        const raw = await request.json().catch(() => undefined)
        const parsed = schema.safeParse(raw)
        if (!parsed.success) {
          return {
            ok: false,
            response: NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'invalid request body' }, { status: 400 }),
          }
        }
        return { ok: true, data: parsed.data }
      }
    `,
  ],
  [
    'mock:sql',
    `
      export function sql(strings, ...values) {
        return { strings: Array.from(strings), values }
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.marketplace-unpublish-route-test')]
      export const db = {
        async execute(query) {
          const text = Array.isArray(query?.strings) ? query.strings.join('') : String(query)
          state.executeCalls.push({ text, values: query?.values ?? [] })
          return { rows: state.listingRows }
        },
      }
    `,
  ],
  [
    'mock:gates',
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: '${ORG_ID}', id: '${USER_ID}' } }
      }
    `,
  ],
  [
    'mock:store',
    `
      const state = globalThis[Symbol.for('openbooks.marketplace-unpublish-route-test')]
      export class AppError extends Error {
        constructor(message, status = 400) {
          super(message)
          this.name = 'AppError'
          this.status = status
        }
      }
      export async function listListings() { return { listings: [], total: 0 } }
      export async function publishApp() { return { id: 'listing-1' } }
      export async function unpublishApp(orgId, userId, key) {
        state.unpublishCalls.push({ orgId, userId, key })
        if (state.unpublishError) {
          throw new AppError(state.unpublishError.message, state.unpublishError.status)
        }
      }
    `,
  ],
  [
    'mock:context',
    `export function applicationContextFromSession() { return {} }`,
  ],
  [
    'mock:extensions',
    `export async function draftExtension() { return { id: 'draft-1' } }`,
  ],
  [
    'mock:errors',
    `
      export class ApplicationError extends Error {
        constructor(message, status = 400) {
          super(message)
          this.name = 'ApplicationError'
          this.status = status
        }
      }
    `,
  ],
  [
    'mock:list-params',
    `export function isUuid(value) { return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) }`,
  ],
  [
    'mock:next',
    `
      export class NextResponse extends Response {
        static json(body, init) {
          return new NextResponse(JSON.stringify(body), {
            status: init?.status ?? 200,
            headers: { 'content-type': 'application/json', ...init?.headers },
          })
        }
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['next/server', 'mock:next'],
  ['@/lib/api/json', 'mock:json'],
  ['drizzle-orm', 'mock:sql'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['@/lib/feature-gates', 'mock:gates'],
  ['@/lib/apps/store', 'mock:store'],
  ['@/lib/application/context', 'mock:context'],
  ['@/lib/application/extensions', 'mock:extensions'],
  ['@/lib/application/errors', 'mock:errors'],
  ['@/lib/list-params', 'mock:list-params'],
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

const marketplace_unpublish_route_testUrl = './route.ts?marketplace-unpublish-route-test'
const { POST } = (await import(marketplace_unpublish_route_testUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(listingRows: { is_active: boolean }[] = []): void {
  state.listingRows = listingRows
  state.executeCalls = []
  state.unpublishCalls = []
  state.unpublishError = null
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://openbooks.test/api/apps/marketplace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

test('already-inactive unpublish is a named 409, not {ok:true}', async () => {
  reset([{ is_active: false }])
  const response = await post({ action: 'unpublish', key: 'payroll-pack' })
  assert.equal(response.status, 409)
  const body = (await response.json()) as { error?: string; ok?: boolean }
  assert.equal(body.ok, undefined)
  assert.match(body.error ?? '', /Nothing was withdrawn/)
  assert.match(body.error ?? '', /payroll-pack/)
  assert.match(body.error ?? '', /already inactive/)
  assert.match(body.error ?? '', /Publish/)
  assert.deepEqual(state.unpublishCalls, [], 'a zero-row withdraw must not call unpublishApp')
  assert.ok(
    state.executeCalls.some(
      (call) =>
        /publisher_org_id/i.test(call.text) &&
        call.values.includes(ORG_ID) &&
        call.values.includes('payroll-pack'),
    ),
    'the inactive check is scoped to this org and key',
  )
})

test('two already-inactive keys are named apart so the refusal is readable', async () => {
  reset([{ is_active: false }])
  const payroll = await post({ action: 'unpublish', key: 'payroll-pack' })
  const expense = await post({ action: 'unpublish', key: 'expense-pack' })
  assert.equal(payroll.status, 409)
  assert.equal(expense.status, 409)
  const payrollError = ((await payroll.json()) as { error: string }).error
  const expenseError = ((await expense.json()) as { error: string }).error
  assert.match(payrollError, /payroll-pack/)
  assert.doesNotMatch(payrollError, /expense-pack/)
  assert.match(expenseError, /expense-pack/)
  assert.doesNotMatch(expenseError, /payroll-pack/)
  assert.deepEqual(state.unpublishCalls, [])
})

test('an active listing is withdrawn and reports {ok:true}', async () => {
  reset([{ is_active: true }])
  const response = await post({ action: 'unpublish', key: 'payroll-pack' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.deepEqual(state.unpublishCalls, [
    { orgId: ORG_ID, userId: USER_ID, key: 'payroll-pack' },
  ])
})

test('a missing listing still reaches unpublishApp, which names the 404', async () => {
  reset([])
  state.unpublishError = {
    message: 'No app listing owned by this organization',
    status: 404,
  }
  const response = await post({ action: 'unpublish', key: 'payroll-pack' })
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), {
    error: 'No app listing owned by this organization',
  })
  assert.deepEqual(state.unpublishCalls, [
    { orgId: ORG_ID, userId: USER_ID, key: 'payroll-pack' },
  ])
})
