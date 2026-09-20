import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Revaluation boundary contract: per-subsidiary domain findings (unknown
// period, missing spot rate) collect into problems[] with nothing posted;
// run-level domain refusals (unconfigured control account, closed GL period)
// fail closed with a named 422. Only systemic throws stay 500.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __revaluationDomainState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__revaluationDomainState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
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

test('POST reports an unknown period as a problem with nothing posted', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    const result = await post({ periodId: randomUUID() })
    assert.equal(result.status, 200, `expected 200, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.deepEqual((result.json as { posted?: unknown[] }).posted, [])
    assert.match(JSON.stringify(result.json), /not found/)
    assert.equal(await entryCount(), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('POST maps an unconfigured control account to 422 with nothing posted', { skip: !DB }, async () => {
  const { org } = await fixture()
  try {
    await db.execute(sql`
      update orgs set settings = settings #- '{controlAccounts,fxUnrealizedGainLoss}'
       where id = ${org.orgId}`)
    const result = await post({ periodId: randomUUID() })
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await entryCount(), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
