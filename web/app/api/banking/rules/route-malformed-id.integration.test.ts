import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'

// A malformed body id must refuse at the JSON boundary before PostgreSQL's
// UUID cast; a well-formed unknown id must remain indistinguishable from an
// out-of-scope rule.
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __bankRulesPatchIdState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '../../../../lib/feature-gates' ||
        (specifier === '@/lib/feature-gates' && context.parentURL?.includes('/lib/api/route'))) return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__bankRulesPatchIdState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    return next(specifier, context)
  },
})
const { withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PATCH } = await import('./route.ts')

async function fixture() {
  const org = await withBypassContext(() => (createScratchOrg()))
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

test('PATCH returns 400 for a malformed rule id before database access', async () => {
  const org = await fixture()
  try {
    const result = await patch({ id: 'not-a-uuid', ...RULE_BODY })
    assert.equal(result.status, 400, `expected 400, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.match(JSON.stringify(result.json), /id.*UUID/)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH still returns 404 for an unknown rule id', async () => {
  const org = await fixture()
  try {
    const result = await patch({ id: randomUUID(), ...RULE_BODY })
    assert.equal(result.status, 404, JSON.stringify(result.json))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
