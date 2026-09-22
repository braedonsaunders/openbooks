import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Empty caller subsidiary scope must fail closed, like the sibling close
// runs and posting-periods routes: 403 naming the scope and the
// covering-administrator remedy, with nothing posted. Null (unrestricted)
// and non-empty scopes pass through to the engine untouched. Only the
// permission/feature gate is stubbed; body parsing, validation, and the
// engine run against the real implementations.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string; scope: 'empty' | 'open' | 'unknown' | 'real'; unknownId: string; realId: string } = {
  orgId: '',
  actorId: '',
  scope: 'empty',
  unknownId: '',
  realId: '',
}
Object.assign(globalThis, { __revaluationScopeState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__revaluationScopeState;
        const allowedSubsidiaryIds =
          s.scope === 'open' ? null : s.scope === 'unknown' ? new Set([s.unknownId]) : s.scope === 'real' ? new Set([s.realId]) : new Set();
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = (await seedFlowActors(org.orgId)).adminId
  const unrealizedId = (await db.execute<{ id: string }>(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${randomUUID()}, ${org.orgId}, '7990', 'Unrealized FX', 'expense_other', false, true, false, false, '{}'::jsonb, '{}'::jsonb, true)
    returning id`)).rows[0]!.id
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"multiCurrency": true}'::jsonb)
     where id = ${org.orgId}`)
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{controlAccounts}',
      coalesce(settings->'controlAccounts','{}'::jsonb) || ${JSON.stringify({ fxUnrealizedGainLoss: unrealizedId })}::jsonb)
     where id = ${org.orgId}`)
  return { org }
}

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => POST(
      new Request('http://close.test/api/close/run-revaluation', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

async function entryCount(): Promise<number> {
  const rows = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries
     where org_id = ${state.orgId} and origin = 'fx_revaluation'`)).rows
  return rows[0]!.n
}

test('POST refuses an empty caller subsidiary scope with 403 and posts nothing', { skip: !DB }, async () => {
  const { org } = await fixture()
  state.scope = 'empty'
  try {
    const result = await post({ periodId: org.periodId })
    assert.equal(result.status, 403, `expected 403, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.match(JSON.stringify(result.json), /no subsidiaries are in the caller's close scope/)
    assert.match(JSON.stringify(result.json), /administrator/)
    assert.equal(await entryCount(), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('POST still runs organization-wide for an unrestricted caller', { skip: !DB }, async () => {
  const { org } = await fixture()
  state.scope = 'open'
  try {
    const result = await post({ periodId: org.periodId })
    assert.equal(result.status, 200, `expected 200, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.ok(Array.isArray((result.json as { posted?: unknown }).posted))
    assert.ok(Array.isArray((result.json as { skipped?: unknown }).skipped))
    assert.doesNotMatch(JSON.stringify(result.json), /close scope/)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('POST runs a real visible subsidiary in a non-empty caller scope', { skip: !DB }, async () => {
  const { org } = await fixture()
  state.scope = 'real'
  state.realId = org.subsidiaryId
  try {
    const result = await post({ periodId: org.periodId })
    assert.equal(result.status, 200, `expected 200, got ${result.status}: ${JSON.stringify(result.json)}`)
    // The scratch org carries no foreign balances, so the real subsidiary is
    // observed and skipped — proving scoped use works instead of refusing.
    assert.deepEqual(
      (result.json as { skipped?: unknown }).skipped,
      [{ subsidiaryId: org.subsidiaryId, reason: 'no revaluation needed' }],
    )
    assert.deepEqual((result.json as { posted?: unknown }).posted, [])
    assert.equal(await entryCount(), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('POST passes a non-empty caller scope through to the engine', { skip: !DB }, async () => {
  const { org } = await fixture()
  state.scope = 'unknown'
  state.unknownId = randomUUID()
  try {
    const result = await post({ periodId: org.periodId })
    assert.equal(result.status, 200, `expected 200, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.match(JSON.stringify(result.json), /does not exist/)
    assert.equal(await entryCount(), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
