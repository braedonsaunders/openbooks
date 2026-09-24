import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.setup-agent-run-scope-test')
interface Gate {
  user: { orgId: string; id: string }
  permissions: Set<string>
  allowedSubsidiaryIds: Set<string> | null
}
const routeState: { gate: Gate | null } = { gate: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const module_ = (source: string): { shortCircuit: true; format: 'module'; url: string } => ({
  shortCircuit: true,
  format: 'module',
  url: `data:text/javascript,${encodeURIComponent(source)}`,
})

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    // The shared dependency tree links @openbooks/engine to another checkout;
    // route tests must execute this worktree's engine boundary (otherwise the
    // UnrestrictedScopeError identity check in the route would compare
    // against a foreign class and the 403 would collapse into a 404).
    if (specifier.startsWith('@openbooks/engine/') && (context.parentURL ?? '').includes('setup/agents/')) {
      return nextResolve(
        new URL(`../../../../../../../../engine/${specifier.slice('@openbooks/engine/'.length)}`, context.parentURL).href,
        context,
      )
    }
    // Re-export the REAL feature-gates module and override only the session
    // gate, so the scope refusal under test is the production path: the real
    // guardFeaturePermission delegates to the real guardPermission, which we
    // stub at the session boundary while the engine assert stays genuine.
    if (specifier === '../../../../lib/authz' ||
        (specifier === './authz' && (context.parentURL ?? '').includes('/web/lib/'))) {
      const real = nextResolve(specifier, context).url
      return module_(`
        export * from ${JSON.stringify(real)};
        const state = globalThis[Symbol.for('openbooks.setup-agent-run-scope-test')];
        export async function guardPermission(_permission) {
          if (!state.gate) return { error: 'unauthorized', status: 401 };
          return state.gate;
        }
      `)
    }
    return nextResolve(specifier, context)
  },
})

const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)
const { POST } = await import('./route.ts')
hooks.deregister()
const DB = !!process.env.OPENBOOKS_DB_URL

async function setup() {
  const org = await createScratchOrg()
  const actor = await createScratchUser(org.orgId, 'Setup runner', 'reviewer')
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features','{}'::jsonb) || ${JSON.stringify({ continuousClose: true })}::jsonb)
     where id = ${org.orgId}`)
  const gate = (scope: Set<string> | null) => {
    routeState.gate = {
      user: { orgId: org.orgId, id: actor },
      permissions: new Set(['admin.setup.manage']),
      allowedSubsidiaryIds: scope,
    }
  }
  return { org, gate }
}

const params = (agentKey: string) => ({ params: Promise.resolve({ agentKey }) })

test('a restricted manual agent run is refused by name and persists nothing', { skip: !DB }, async () => {
  const { org, gate } = await setup()
  try {
    gate(new Set([org.subsidiaryId]))
    const res = await POST(new Request('http://localhost/run', { method: 'POST' }), params('accounting'))
    assert.equal(res.status, 403)
    assert.deepEqual(await res.json(), { error: 'requires unrestricted subsidiary access' })
    const runs = await db.execute<{ n: string }>(sql`
      select count(*) as n from ai_agent_runs where org_id = ${org.orgId}
    `)
    assert.equal(Number(runs.rows[0]!.n), 0, 'a refused scan leaves no run row behind')
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
  }
})

test('an unknown agent key still answers invalid_agent', { skip: !DB }, async () => {
  const { org, gate } = await setup()
  try {
    gate(null)
    const res = await POST(new Request('http://localhost/run', { method: 'POST' }), params('nope'))
    assert.equal(res.status, 404)
    assert.deepEqual(await res.json(), { error: 'invalid_agent' })
  } finally {
    routeState.gate = null
    await dropScratchOrg(org.orgId)
  }
})
