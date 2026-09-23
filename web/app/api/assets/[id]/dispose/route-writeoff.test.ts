import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'

// A contradictory { writeOff: true, proceeds: 500 } must reach the engine
// untouched so its write-off-takes-no-proceeds refusal fires. The route used
// to coerce proceeds to zero on write-offs, posting a zero-proceeds write-off
// as success and masking the contradiction.

interface RouteState {
  isIsoCalendarDate: typeof isIsoCalendarDate
}

const stateKey = Symbol.for('openbooks.asset-disposal-writeoff-test')
const routeState: RouteState = { isIsoCalendarDate }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  [
    'mock:feature-gates',
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
  ],
  [
    'mock:list-params',
    `
      export function isUuid(value) {
        return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      }
    `,
  ],
  [
    'mock:business-date',
    `
      const state = globalThis[Symbol.for('openbooks.asset-disposal-writeoff-test')]
      export async function businessToday(orgId) {
        return '2026-08-31'
      }
      export const isIsoCalendarDate = state.isIsoCalendarDate
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '../../../../../lib/feature-gates') {
      return { url: 'mock:feature-gates', shortCircuit: true }
    }
    if (specifier === '../../../../../lib/list-params') {
      return { url: 'mock:list-params', shortCircuit: true }
    }
    if (specifier === '@openbooks/engine/src/platform/business-date.ts') {
      return { url: 'mock:business-date', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?asset-disposal-writeoff-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const ASSET_ID = '00000000-0000-4000-8000-00000000a002'

function post(body: unknown): Promise<Response> {
  return POST(
    new Request(`http://openbooks.test/api/assets/${ASSET_ID}/dispose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ASSET_ID }) },
  )
}

test('a write-off with proceeds is refused, not coerced to zero', async () => {
  const response = await post({ writeOff: true, proceeds: '500.0000', date: '2026-08-31' })
  const body = (await response.json()) as { error?: string }
  // No disposal target exists here, but the refusal must be the engine's
  // write-off economics refusal — never a success, and never a masked zero.
  assert.equal(response.status, 422)
  assert.match(body.error ?? '', /write-off takes no proceeds/)
})
