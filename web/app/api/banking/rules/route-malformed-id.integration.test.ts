import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Banking-rules PATCH requires a body id but never gates it: a malformed id
// binds straight into the row lock and escapes as a raw Postgres uuid throw
// (HTTP 500) instead of the same 404 an unknown id returns.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __bankRulesPatchIdState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__bankRulesPatchIdState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  return org
}

const RULE_BODY = {
  name: 'Test rule',
  criteria: { version: 2, match: { combinator: 'and', rules: [{ field: 'flow', op: 'is', value: 'in' }] } },
  outcome: { action: 'exclude' },
}

async function patch(body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => PATCH(
      new Request('http://bankrules.test/api/banking/rules', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

test('PATCH returns 404 for a malformed rule id', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await patch({ id: 'not-a-uuid', ...RULE_BODY })
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH still returns 404 for an unknown rule id', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await patch({ id: randomUUID(), ...RULE_BODY })
    assert.equal(result.status, 404, JSON.stringify(result.json))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
