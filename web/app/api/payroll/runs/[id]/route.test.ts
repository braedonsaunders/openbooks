import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextResponse } from 'next/server'

/**
 * DELETE /api/payroll/runs/[id] — the in-UI discard path's HTTP boundary.
 *
 * The accounting boundary lives in the engine (`discardPayRun`); this file
 * proves the adapter around it: a draft discards, a committed run is refused
 * with the void remedy (422, never a quiet void), and missing ids and
 * out-of-scope runs answer the same 404.
 */

const stateKey = Symbol.for('openbooks.payroll-run-delete-test')
interface RouteState {
  ownedSubsidiaryId: string | null
  discardCalls: unknown[]
  discardBehavior: 'ok' | 'committed' | 'missing'
}
const routeState: RouteState = { ownedSubsidiaryId: 'sub-1', discardCalls: [], discardBehavior: 'ok' }
;(globalThis as Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody() { return { ok: true, data: {} } }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-run-delete-test')]
      export const db = {
        execute() { return Promise.resolve({ rows: state.ownedSubsidiaryId ? [{ subsidiaryId: state.ownedSubsidiaryId }] : [] }) },
      }
      export const env = {}
      export const schema = {}
      export const pool = { query() { return Promise.resolve({ rows: [] }) } }
      export const orgContext = { getStore() { return undefined } }
      export function registerRequestOrgResolver() {}
      export function ambientTenantOrgId() { return null }
      export async function assertSafeRuntimeDatabaseRole() {}
      export async function withOrgTransaction(_orgId, fn) { return fn() }
      export async function withMaintenanceTransaction(fn) { return fn() }
      export async function withTransactionSavepoint(_tx, fn) { return fn() }
      export async function inDbTransaction(fn) { return fn() }
      export async function withBypassContext(fn) { return fn() }
      export async function withOrgContext(_orgId, fn) { return fn() }
      export async function withOrg(_orgId, fn) { return fn() }
      export async function withBypass(fn) { return fn() }
    `,
  ],
  [
    'mock:feature-gates',
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'actor-1' }, permissions: new Set(['payroll.run']), allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:authz',
    `
      export function guardSubsidiaryScope() { return undefined }
    `,
  ],
  [
    'mock:payroll-run',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-run-delete-test')]
      export class PayrollError extends Error {}
      export async function calculatePayRun() { throw new Error('not under test') }
      export async function commitPayRun() { throw new Error('not under test') }
      export async function previewPayRunGl() { throw new Error('not under test') }
      export async function discardPayRun(input) {
        state.discardCalls.push(input)
        if (state.discardBehavior === 'committed') {
          throw new PayrollError('pay run PAY-00002 is committed and cannot be discarded — void it to reverse the posted payroll')
        }
        if (state.discardBehavior === 'missing') throw new PayrollError('pay run not found')
        return { documentNumber: 'PAY-00002' }
      }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '@/lib/api/json') return { url: 'mock:json', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/db.ts') return { url: 'mock:db', shortCircuit: true }
    if (specifier === '@openbooks/engine/src/payroll-run.ts') {
      return { url: 'mock:payroll-run', shortCircuit: true }
    }
    if (specifier.endsWith('/lib/feature-gates')) return { url: 'mock:feature-gates', shortCircuit: true }
    if (specifier.endsWith('/lib/authz')) return { url: 'mock:authz', shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?payroll-run-delete-test'
const { DELETE } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

void NextResponse
const RUN_ID = '00000000-0000-4000-8000-000000000001'

function reset() {
  routeState.ownedSubsidiaryId = 'sub-1'
  routeState.discardCalls = []
  routeState.discardBehavior = 'ok'
}

test('DELETE discards a draft run', async () => {
  reset()
  const res = await DELETE(
    new Request(`http://openbooks.test/api/payroll/runs/${RUN_ID}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id: RUN_ID }) },
  )
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, documentNumber: 'PAY-00002' })
  assert.equal(routeState.discardCalls.length, 1)
})

test('DELETE refuses a committed run with the void remedy, never a quiet void', async () => {
  reset()
  routeState.discardBehavior = 'committed'
  const res = await DELETE(
    new Request(`http://openbooks.test/api/payroll/runs/${RUN_ID}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id: RUN_ID }) },
  )
  assert.equal(res.status, 422)
  assert.match((await res.json() as { error: string }).error, /cannot be discarded — void it/)
})

test('DELETE answers a missing run and a malformed id with the same 404', async () => {
  reset()
  routeState.ownedSubsidiaryId = null
  const missing = await DELETE(
    new Request(`http://openbooks.test/api/payroll/runs/${RUN_ID}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id: RUN_ID }) },
  )
  assert.equal(missing.status, 404)

  reset()
  const malformed = await DELETE(
    new Request('http://openbooks.test/api/payroll/runs/nope', { method: 'DELETE' }),
    { params: Promise.resolve({ id: 'nope' }) },
  )
  assert.equal(malformed.status, 404)
  assert.equal(routeState.discardCalls.length, 0)
})
