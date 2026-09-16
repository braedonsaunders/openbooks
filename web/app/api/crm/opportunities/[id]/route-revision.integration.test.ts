import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Two tabs editing the same opportunity: the second save carries the revision
// token it read before the first save committed, so it must fail with a 409
// instead of silently replacing the first tab's full-replace payload (header
// fields + lines). Same contract as document, payment, prebill-line, capture,
// and custom-record edits.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __opportunityRevisionState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') return virtual('export function redirect() {}')
    if (specifier === '../../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__opportunityRevisionState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__opportunityRevisionState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/test-fixtures.ts')
const { GET, PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = (await seedFlowActors(org.orgId)).adminId
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"crm": true}'::jsonb)
     where id = ${org.orgId}`)
  const statusId = (await db.execute<{ id: string }>(sql`
    insert into crm_opportunity_statuses (org_id, key, name, probability, is_closed, is_won, is_active)
    values (${org.orgId}, 'open', 'Open', 10, false, false, true)
    returning id`)).rows[0]!.id
  const itemA = (await db.execute<{ id: string }>(sql`
    insert into items (org_id, kind, name, is_active)
    values (${org.orgId}, 'service', 'Revision Item A', true)
    returning id`)).rows[0]!.id
  const itemB = (await db.execute<{ id: string }>(sql`
    insert into items (org_id, kind, name, is_active)
    values (${org.orgId}, 'service', 'Revision Item B', true)
    returning id`)).rows[0]!.id
  const oppId = (await db.execute<{ id: string }>(sql`
    insert into crm_opportunities (org_id, opportunity_number, title, status_id, currency)
    values (${org.orgId}, 'OPP-REV-001', 'Revision Opp', ${statusId}, 'CAD')
    returning id`)).rows[0]!.id
  return { org, statusId, itemA, itemB, oppId }
}

async function read(id: string) {
  const response = await withOrgContext(state.orgId, () => GET(
    new Request(`http://crm.test/api/crm/opportunities/${id}`),
    { params: Promise.resolve({ id }) },
  ))
  assert.equal(response.status, 200)
  return (await response.json() as {
    opportunity: { title: string; updated_at: string }
    lines: { item_id: string | null }[]
  })
}

async function patch(id: string, body: unknown): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(state.orgId, () => PATCH(
      new Request(`http://crm.test/api/crm/opportunities/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

test('a stale opportunity revision refuses instead of replacing a newer save', { skip: !DB }, async () => {
  const { org, statusId, itemA, itemB, oppId } = await fixture()
  try {
    // Both tabs read the same revision.
    const stale = (await read(oppId)).opportunity.updated_at
    assert.match(stale, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)

    // Tab A saves a full-replace payload (header + lines) with the fresh token.
    const tabA = await patch(oppId, {
      statusId,
      title: 'Tab A title',
      lines: [{ itemId: itemA, quantity: '2', unitPrice: '50' }],
      expectedUpdatedAt: stale,
    })
    assert.equal(tabA.status, 200, `tab A: ${JSON.stringify(tabA.json)}`)
    const afterA = await read(oppId)
    assert.equal(afterA.opportunity.title, 'Tab A title')
    assert.deepEqual(afterA.lines.map((line) => line.item_id), [itemA])
    assert.notEqual(afterA.opportunity.updated_at, stale)

    // Tab B still holds the pre-A token: it must lose loudly, and the live
    // header + lines must stay exactly what tab A wrote.
    const tabB = await patch(oppId, {
      statusId,
      title: 'Tab B title',
      lines: [{ itemId: itemB, quantity: '1', unitPrice: '10' }],
      expectedUpdatedAt: stale,
    })
    assert.equal(tabB.status, 409, `tab B: ${JSON.stringify(tabB.json)}`)
    const live = await read(oppId)
    assert.equal(live.opportunity.title, 'Tab A title')
    assert.deepEqual(live.lines.map((line) => line.item_id), [itemA])

    // A save with no token is rejected before any work happens.
    const tokenless = await patch(oppId, { statusId, title: 'Sneaky' })
    assert.equal(tokenless.status, 409)
    assert.equal((await read(oppId)).opportunity.title, 'Tab A title')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
