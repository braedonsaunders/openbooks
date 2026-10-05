import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { stubModules } from '../../../../../../testing/stub-modules'

const state = { calls: [] as { deltaMinor: bigint; idempotencyKey: string; allowedSubsidiaryIds: ReadonlySet<string> | null }[], error: null as Error | null, grants: [] as string[] }
Object.assign(globalThis, { __storedAdjustment: state })
stubModules({ extra: { '@/lib/feature-gates': `
  export async function guardFeaturePermission(permission, feature) {
    globalThis.__storedAdjustment.grants.push(permission + ':' + feature)
    return { user: { orgId: 'org', id: 'actor' }, allowedSubsidiaryIds: null }
  }
` } })
registerHooks({ resolve(specifier, context, nextResolve) {
  // Isolate the committed service result and transaction boundary, while
  // keeping the route factory, JSON schema and native JSON response real.
  if (context.parentURL?.endsWith('/adjust/route.ts')) {
    let source: string | undefined
    if (specifier === '@openbooks/engine/src/platform/db.ts') source = 'export async function withOrgTransaction(_orgId, work) { return work() }'
    if (specifier === '@openbooks/engine/src/stored-value/accounts.ts') source = `
      export async function adjustStoredValue(input) {
        const state = globalThis.__storedAdjustment
        state.calls.push(input)
        if (state.error) throw state.error
        return { entryId: '01a10c33-abb8-797a-bd5a-058e59065554', journalEntryId: '01a10c33-abb8-797a-bd5a-058e59065555', balanceMinor: 900719925474099312345n }
      }
    `
    if (source) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(source) }
  }
  return nextResolve(specifier, context)
} })
const { POST } = await import('./route')
const { StoredValueError } = await import('@openbooks/engine/stored-value')
const body = { delta: '25.0001', reason: 'Correct opening balance', offsetAccountId: '01a10c33-abb8-797a-bd5a-058e59065556', idempotencyKey: 'original-adjustment-request' }
function post(delta = body.delta) {
  return POST(new Request('http://openbooks.test/api/stored-value/accounts/account/adjust', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, delta }) }), { params: Promise.resolve({ id: '01a10c33-abb8-797a-bd5a-058e59065554' }) })
}

test('a committed adjustment returns its exact large balance as a usable JSON receipt', async () => {
  state.calls.length = 0; state.grants.length = 0; state.error = null
  const response = await post()
  assert.equal(response.status, 201, 'serializing a committed effect cannot turn its receipt into a 500')
  const receipt = await response.json()
  assert.equal(receipt.balanceMinor, '900719925474099312345')
  assert.equal(receipt.entryId, '01a10c33-abb8-797a-bd5a-058e59065554')
  assert.equal(state.calls[0]?.deltaMinor, 250001n)
  assert.equal(state.calls[0]?.idempotencyKey, body.idempotencyKey)
  assert.equal(state.calls[0]?.allowedSubsidiaryIds, null, 'the route forwards the authoritative actor scope, never a guessed one')
  assert.deepEqual(state.grants, ['stored_value.adjust:storedValue'])
})

test('an unreadable supplied adjustment refuses before the balance service runs', async () => {
  state.calls.length = 0; state.error = null
  const response = await post('25,01')
  assert.equal(response.status, 400)
  assert.deepEqual(state.calls, [])
})

test('an adjustment domain refusal retains its remedy and stable code', async () => {
  const refusal = new StoredValueError({ message: 'Account is closed', status: 409, code: 'stored_value_adjust_closed', remedy: 'Review the closed account before issuing new stored value' })
  state.error = refusal
  const response = await post()
  assert.equal(response.status, 409)
  assert.equal((await response.json()).remedy, refusal.remedy)
  state.error = null
})

test('an out-of-scope account answers a neutral not-found with no balance leak', async () => {
  const { ScopeNotFoundError } = await import('@openbooks/engine/organization/scope')
  state.calls.length = 0; state.error = new ScopeNotFoundError()
  const response = await post()
  assert.equal(response.status, 404, 'a hidden account reads as missing, never as a named refusal')
  const body = await response.json()
  assert.equal(body.error, 'not found')
  assert.ok(!('balanceMinor' in body) && !('code' in body) && !('remedy' in body), 'no hidden state may ride the denial')
  state.error = null
})
