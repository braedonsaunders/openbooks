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
const readRoute = (rel: string) =>
  readFileSync(join(thisDir, '..', '..', 'app', 'api', 'admin', 'setup', 'agents', rel), 'utf8')

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

test('setup agent routes demand the setup gate, never the provider key', () => {
  const collection = readRoute('route.ts')
  assert.match(collection, /guardPermission\(['"]admin\.setup\.manage['"]\)/)
  assert.doesNotMatch(collection, /admin\.ai\.manage/)

  const activity = readRoute('activity/route.ts')
  assert.match(activity, /guardPermission\(['"]admin\.setup\.manage['"]\)/)
  assert.doesNotMatch(activity, /admin\.ai\.manage/)

  const policy = readRoute('[agentKey]/route.ts')
  assert.match(policy, /guardPermission\(['"]admin\.setup\.manage['"]\)/)
  assert.doesNotMatch(policy, /admin\.ai\.manage/)
  assert.match(policy, /saveSetupAgentPolicy/, 'the policy route must reuse the shared setup adapter, not fork the save')

  const run = readRoute('[agentKey]/run/route.ts')
  assert.match(run, /guardFeaturePermission\(['"]admin\.setup\.manage['"],\s*['"]continuousClose['"]\)/)
  assert.match(run, /runSetupAgentNow/, 'run-now must reuse the shared adapter over runContinuousCloseAgent')
})

test('setup agent reads stay inside the requesting org', () => {
  const lib = readFileSync(join(thisDir, 'agents.ts'), 'utf8')
  assert.match(lib, /where org_id = /)
  assert.doesNotMatch(lib, /withBypassContext/, 'setup reads must not bypass tenant scoping')
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
