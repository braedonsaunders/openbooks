import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
registerHooks({ resolve(specifier, context, next) { return specifier === 'server-only' ? { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' } : next(specifier, context) } })
const { CONTINUOUS_CLOSE_AGENT_KEYS, agentPackMeta, agentPackMetas } = await import('./agents.ts')

/**
 * Source-contract for the Agents setup area (web/lib/setup/agents.ts + the
 * thin API adapters under web/app/api/admin/setup/agents/**).
 *
 * Configuration lives behind `admin.setup.manage` (the Setup workspace gate),
 * never the provider-page `admin.ai.manage` key; every query the area runs is
 * org-scoped; writes reuse the continuous-close policy commands. These tests
 * pin that contract so a later edit cannot silently re-point a route at the
 * wrong gate or drop the tenant filter.
 */

const thisDir = import.meta.dirname

/**
 * Gate proofs for the thin API adapters: every setup-agents route demands
 * `admin.setup.manage` (the Setup workspace gate), so a provider-page
 * manager holding only `admin.ai.manage` is refused before any adapter
 * runs — and each route delegates to its shared setup command.
 */
type GateCall = [string, ...unknown[]]
const gateKey = Symbol.for('openbooks.setup-agents-gate-test')
const gateState: { granted: Set<string>; calls: GateCall[] } = { granted: new Set(), calls: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[gateKey] = gateState

const gateAuthz = `
  import { NextResponse } from 'next/server'
  const state = globalThis[Symbol.for('openbooks.setup-agents-gate-test')]
  async function demand(permission) {
    if (!state.granted.has(permission)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    return { user: { orgId: 'org-1', id: 'user-1' }, permissions: state.granted, allowedSubsidiaryIds: null }
  }
  export async function guardPermission(permission) { return demand(permission) }
  export async function guardFeaturePermission(permission) { return demand(permission) }
`
const gateAdapters = `
  const state = globalThis[Symbol.for('openbooks.setup-agents-gate-test')]
  export async function getAgentsOverview(orgId) {
    state.calls.push(['overview', orgId])
    return []
  }
  export async function listAgentRuns(orgId, opts) {
    state.calls.push(['activity', orgId, opts])
    return { runs: [], total: 0, truncated: false }
  }
  export async function saveSetupAgentPolicy(orgId, userId, agentKey, data) {
    state.calls.push(['save', orgId, userId, agentKey, data])
    return { agentKey, enabled: true }
  }
  export async function runSetupAgentNow(orgId, userId, agentKey) {
    state.calls.push(['run', orgId, userId, agentKey])
    return { status: 'completed' }
  }
`
const GATE_SELF = new URL(import.meta.url).href
const gateMock = (name: string) => `${GATE_SELF}?mock=${name}`
const gateMocks = new Map<string, string>([
  ['../../../../../lib/authz', gateMock('authz')],
  ['../../../../../lib/setup/agents', gateMock('adapters')],
  ['../../../../../../lib/authz', gateMock('authz')],
  ['../../../../../../lib/setup/agents', gateMock('adapters')],
  ['../../../../../../../lib/feature-gates', gateMock('authz')],
  ['../../../../../../../lib/setup/agents', gateMock('adapters')],
])
const gateHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = gateMocks.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const parsed = new URL(url)
    const name = parsed.searchParams.get('mock')
    if (name === 'authz') return { format: 'module', source: gateAuthz, shortCircuit: true }
    if (name === 'adapters') return { format: 'module', source: gateAdapters, shortCircuit: true }
    return nextLoad(url, context)
  },
})
const agentsApi = (rel: string) => `../../app/api/admin/setup/agents/${rel}?setup-agents-gate`
const { GET: collectionGET } = (await import(agentsApi('route.ts'))) as typeof import('../../app/api/admin/setup/agents/route.ts')
const { GET: activityGET } = (await import(agentsApi('activity/route.ts'))) as typeof import('../../app/api/admin/setup/agents/activity/route.ts')
const { PUT: policyPUT } = (await import(agentsApi('[agentKey]/route.ts'))) as typeof import('../../app/api/admin/setup/agents/[agentKey]/route.ts')
const { POST: runPOST } = (await import(agentsApi('[agentKey]/run/route.ts'))) as typeof import('../../app/api/admin/setup/agents/[agentKey]/run/route.ts')
gateHooks.deregister()

const SETUP_KEY = 'admin.setup.manage'
const PROVIDER_KEY = 'admin.ai.manage'

function asProviderManager() {
  gateState.granted = new Set([PROVIDER_KEY])
  gateState.calls = []
}

function asSetupManager() {
  gateState.granted = new Set([SETUP_KEY])
  gateState.calls = []
}

test('every registered agent pack has setup metadata', () => {
  const metas = agentPackMetas()
  assert.deepEqual(
    metas.map((meta) => meta.agentKey).sort(),
    [...CONTINUOUS_CLOSE_AGENT_KEYS].sort(),
    'the setup area must describe exactly the packs the engine registry lists — no hardcoded pair',
  )
  for (const meta of metas) {
    assert.equal(meta.featureKey, 'continuousClose', `${meta.agentKey} must fence on the Continuous Close feature`)
    assert.ok(meta.readPermissions.length > 0, `${meta.agentKey} must name the permissions its findings need`)
    for (const permission of meta.readPermissions) {
      assert.match(permission, /^[a-z*]+(\.[a-z]+)+$/, `${meta.agentKey} permission ${permission} is not a permission key`)
    }
    assert.deepEqual(meta.detectorKeys, agentPackMeta(meta.agentKey).detectorKeys)
  }
})

test('every pack declares at least one detector in the engine registry', () => {
  for (const agentKey of CONTINUOUS_CLOSE_AGENT_KEYS) {
    assert.ok(agentPackMeta(agentKey).detectorKeys.length > 0, `${agentKey} must declare detectors`)
  }
})

test('the overview refuses a provider-key manager before any adapter runs', async () => {
  asProviderManager()
  const response = await collectionGET()
  assert.equal(response.status, 403)
  assert.deepEqual(gateState.calls, [])

  asSetupManager()
  const allowed = await collectionGET()
  assert.equal(allowed.status, 200)
  assert.deepEqual(await allowed.json(), { agents: [] })
  assert.deepEqual(gateState.calls, [['overview', 'org-1']])
})

test('the activity read refuses a provider-key manager before any adapter runs', async () => {
  asProviderManager()
  const response = await activityGET(new Request('http://openbooks.test/api/admin/setup/agents/activity'))
  assert.equal(response.status, 403)
  assert.deepEqual(gateState.calls, [])

  asSetupManager()
  const allowed = await activityGET(new Request('http://openbooks.test/api/admin/setup/agents/activity?limit=5'))
  assert.equal(allowed.status, 200)
  assert.deepEqual(gateState.calls, [['activity', 'org-1', { agentKey: undefined, limit: 5 }]])
})

test('a policy write refuses a provider-key manager and otherwise reuses the shared command', async () => {
  const put = (body: unknown) =>
    policyPUT(
      new Request('http://openbooks.test/api/admin/setup/agents/accounting', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ agentKey: 'accounting' }) },
    )
  asProviderManager()
  assert.equal((await put({ enabled: true })).status, 403)
  assert.deepEqual(gateState.calls, [])

  asSetupManager()
  const allowed = await put({ enabled: true })
  assert.equal(allowed.status, 200)
  assert.deepEqual(gateState.calls, [['save', 'org-1', 'user-1', 'accounting', { enabled: true }]])
})

test('run-now refuses a provider-key manager and otherwise reuses the shared runner', async () => {
  const post = () =>
    runPOST(
      new Request('http://openbooks.test/api/admin/setup/agents/accounting/run', { method: 'POST' }),
      { params: Promise.resolve({ agentKey: 'accounting' }) },
    )
  asProviderManager()
  assert.equal((await post()).status, 403)
  assert.deepEqual(gateState.calls, [])

  asSetupManager()
  const allowed = await post()
  assert.equal(allowed.status, 200)
  assert.deepEqual(gateState.calls, [['run', 'org-1', 'user-1', 'accounting']])
})

test('every pack has title, description, reads and proposes copy in en/es/fr', () => {
  for (const locale of ['en', 'es', 'fr']) {
    const catalog = JSON.parse(
      readFileSync(join(thisDir, '..', '..', 'messages', locale, 'admin.json'), 'utf8'),
    ) as { setup?: { agents?: { packs?: Record<string, Record<string, string>> } } }
    const packs = catalog.setup?.agents?.packs ?? {}
    for (const agentKey of CONTINUOUS_CLOSE_AGENT_KEYS) {
      for (const field of ['title', 'description', 'reads', 'proposes']) {
        const value = packs[agentKey]?.[field]
        assert.ok(
          typeof value === 'string' && value.length > 0,
          `${locale} setup.agents.packs.${agentKey}.${field} must be translated copy`,
        )
      }
    }
  }
})
