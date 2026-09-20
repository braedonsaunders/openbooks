import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * View export already applies canRunReportEntity. Pin that a payroll plan
 * is not exported with only reports.read — the same refusal GET/list/PATCH
 * still lack.
 */
const stateKey = Symbol.for('openbooks.view-export-authz-route-test')
interface RouteState {
  granted: Set<string>
  ran: boolean
}
const state: RouteState = { granted: new Set(), ran: false }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const VIEW_ID = '00000000-0000-4000-8000-00000000c001'

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      import { NextResponse } from 'next/server'
      const state = globalThis[Symbol.for('openbooks.view-export-authz-route-test')]
      export async function guardPermission(permission) {
        if (!state.granted.has('*') && !state.granted.has(permission)) {
          return NextResponse.json({ error: 'forbidden' }, { status: 403 })
        }
        return { user: { orgId: 'org-1', id: 'user-1' }, permissions: state.granted, allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:report-authz',
    `
      export async function canRunReportEntity(authz, query) {
        const entity = query && typeof query === 'object' ? query.entity : undefined
        if (entity === 'pay_stubs') return authz.permissions.has('payroll.read') || authz.permissions.has('*')
        return Boolean(entity)
      }
    `,
  ],
  [
    'mock:views',
    `
      const state = globalThis[Symbol.for('openbooks.view-export-authz-route-test')]
      export async function loadView() {
        return {
          id: '${VIEW_ID}',
          org_id: 'org-1',
          slug: 'payroll-wages',
          name: 'Payroll wages',
          query: { entity: 'pay_stubs', mode: 'rows', columns: ['gross_pay'] },
          layout: null,
        }
      }
      export async function runView() {
        state.ran = true
        return { groups: [], rowCount: 0 }
      }
    `,
  ],
])

const SELF_URL = new URL(import.meta.url).href
const mockUrl = (name: string) => `${SELF_URL}?mock=${name}`
const mockUrls = new Map<string, string>([
  ['../../../../../lib/authz', mockUrl('authz')],
  ['../../../../../lib/report-authz', mockUrl('report-authz')],
  ['../../../../../lib/views', mockUrl('views')],
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
    const parsed = new URL(url)
    const mockName = parsed.searchParams.get('mock')
    const source = mockSources.get(mockName ? `mock:${mockName}` : url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { GET } = (await import('./[id]/export/route.ts?view-export-authz')) as typeof import('./[id]/export/route.ts')
hooks.deregister()

test('view export refuses a payroll plan when the caller lacks payroll.read', async () => {
  state.granted = new Set(['reports.read'])
  state.ran = false

  const response = await GET(
    new Request(`http://openbooks.test/api/views/${VIEW_ID}/export?format=csv`),
    { params: Promise.resolve({ id: VIEW_ID }) },
  )

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not found' })
  assert.equal(state.ran, false, 'the executor must not run after the entity gate refuses')
})
