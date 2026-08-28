import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { SETUP_ENTITY_BY_KEY } from './setup/registry.ts'

const routeSource = readFileSync(
  new URL('../app/api/admin/setup/[entity]/route.ts', import.meta.url),
  'utf8',
)

test('the shared currency registry stays readable but is not tenant-mutable', () => {
  const currencies = SETUP_ENTITY_BY_KEY.get('currencies')
  assert.ok(currencies)
  assert.equal(currencies.orgScoped, false, 'currencies must remain one shared reference table')
  assert.equal(currencies.readOnly, true, 'tenant setup must not own the shared registry')
  assert.deepEqual(
    currencies.fields.map((field) => field.key),
    ['code', 'name', 'minorUnits'],
    'currency fields remain available for reads and reference pickers',
  )
})

test('every setup mutation method rejects a read-only entity before request writes', () => {
  assert.equal(
    routeSource.match(/if \(entity\.readOnly\) return NextResponse\.json\(\{ error: 'read-only' \}, \{ status: 405 \}\)/g)?.length,
    3,
    'POST, PATCH, and DELETE must all have an explicit read-only boundary',
  )

  const post = routeSource.slice(routeSource.indexOf('export async function POST('), routeSource.indexOf('export async function PATCH('))
  const patch = routeSource.slice(routeSource.indexOf('export async function PATCH('), routeSource.indexOf('export async function DELETE('))
  const del = routeSource.slice(routeSource.indexOf('export async function DELETE('))
  for (const [method, source, requestStart] of [
    ['POST', post, 'const parsedBody'],
    ['PATCH', patch, 'const parsedBody2'],
    ['DELETE', del, 'const url'],
  ] as const) {
    const gate = source.indexOf("if (entity.readOnly) return NextResponse.json({ error: 'read-only' }, { status: 405 })")
    assert.ok(gate >= 0, `${method} must reject read-only entities`)
    assert.ok(gate < source.indexOf(requestStart), `${method} must reject before reading the request body/id`)

    const firstWrite = source.search(/\b(?:insert\s+into|update\s+|delete\s+from)\b/i)
    assert.ok(firstWrite < 0 || gate < firstWrite, `${method} must reject before its first SQL write`)
  }
})

const routeState = {
  executeCalls: 0,
  transactionCalls: 0,
}
const routeStateKey = Symbol.for('openbooks.currency-route-test')
;(globalThis as typeof globalThis & Record<symbol, unknown>)[routeStateKey] = routeState

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      export async function guardPermission() {
        return { user: { orgId: 'tenant-a', id: 'admin-a' }, permissions: new Set(['admin.setup.manage']), allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.currency-route-test')]
      export const db = {
        execute() { state.executeCalls++; return Promise.resolve({ rows: [] }) },
        transaction() { state.transactionCalls++; throw new Error('read-only currency route must not open a transaction') },
      }
    `,
  ],
  [
    'mock:features',
    `
      export function featureEnabled() { return true }
      export async function isFeatureEnabled() { return true }
      export async function resolvedFeatureState() { return {} }
      export async function subsidiaryFeatureEnabled() { return true }
      export async function orgFeatureState() { return {} }
    `,
  ],
  [
    'mock:payroll-run',
    `
      export function payPeriodsPerYearProblem() { return null }
      export function semiMonthlyAnchorProblem() { return null }
    `,
  ],
  [
    'mock:payroll-filing-registry',
    `
      export function filingAccountProblem() { return null }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.startsWith('@/') && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context)
    }
    const routeParent = context.parentURL?.includes('%5Bentity%5D') || context.parentURL?.includes('[entity]')
    if (specifier === '../../../../../lib/authz' && routeParent) {
      return { url: 'mock:authz', shortCircuit: true }
    }
    if (specifier === '../../../../../lib/features' || specifier === '../features') {
      return { url: 'mock:features', shortCircuit: true }
    }
    if (specifier === '@openbooks/engine/src/db.ts') {
      return { url: 'mock:db', shortCircuit: true }
    }
    if (specifier === '@openbooks/engine/src/payroll-run.ts') {
      return { url: 'mock:payroll-run', shortCircuit: true }
    }
    if (specifier === '@openbooks/engine/src/payroll-filing-registry.ts') {
      return { url: 'mock:payroll-filing-registry', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = '../app/api/admin/setup/[entity]/route.ts?currency-route-test'
const { POST, PATCH, DELETE } = await import(routeUrl) as typeof import('../app/api/admin/setup/[entity]/route.ts')
hooks.deregister()

test('currency mutations fail closed before parsing or touching the database', async () => {
  routeState.executeCalls = 0
  routeState.transactionCalls = 0
  const params = { params: Promise.resolve({ entity: 'currencies' }) }
  const responses = [
    await POST(new Request('http://localhost/api/admin/setup/currencies', { method: 'POST', body: '{not-json' }), params),
    await PATCH(new Request('http://localhost/api/admin/setup/currencies', { method: 'PATCH', body: '{}' }), params),
    await DELETE(new Request('http://localhost/api/admin/setup/currencies', { method: 'DELETE' }), params),
  ]
  for (const response of responses) {
    assert.equal(response.status, 405)
    assert.deepEqual(await response.json(), { error: 'read-only' })
  }
  assert.equal(routeState.executeCalls, 0)
  assert.equal(routeState.transactionCalls, 0)
})
