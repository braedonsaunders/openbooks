import assert from 'node:assert/strict'
import { stubModules, withAuthzTestSurface } from '@/testing/stub-modules'
import test from 'node:test'

// Two tabs editing the same opportunity: the second save carries the revision
// token it read before the first save committed, so it must fail with a 409
// instead of silently replacing the first tab's full-replace payload (header
// fields + lines). Same contract as document, payment, prebill-line, capture,
// and custom-record edits.
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __opportunityRevisionState: state })
stubModules({
  navigation: true,
  authz: {
    source: withAuthzTestSurface(`
      const state = globalThis.__opportunityRevisionState;
      const session = () => ({ user: { orgId: state.orgId, id: state.actorId }, permissions: [], allowedSubsidiaryIds: null });
      export async function getAuthz() { return session(); }
      export async function guardPermission() { return session(); }
    `),
  },
  features: {
    source: `
      const state = globalThis.__opportunityRevisionState;
      const session = () => ({ user: { orgId: state.orgId, id: state.actorId }, permissions: [], allowedSubsidiaryIds: null });
      export async function isFeatureEnabled() { return true; }
      export async function guardFeaturePermission() { return session(); }
    `,
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET, PATCH } = await import('./route.ts')

async function fixture() {
  return withBypassContext(async () => {
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
  })
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

test('a stale opportunity revision refuses instead of replacing a newer save', async () => {
  const { org, statusId, itemA, itemB, oppId } = await fixture()
  try {
    // Both tabs read the same revision.
    const stale = (await read(oppId)).opportunity.updated_at
    assert.match(stale, /^\d{1,20}$/)

    // Tab A saves a full-replace payload (header + lines) with the fresh token.
    const tabA = await patch(oppId, {
      statusId,
      title: 'Tab A title',
      lines: [{ itemId: itemA, description: 'Tab A line', quantity: '2', unit: 'each', unitPrice: '50' }],
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
      lines: [{ itemId: itemB, description: 'Tab B line', quantity: '1', unit: 'each', unitPrice: '10' }],
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

test('PATCH stores custom values only after validating them against the opportunity definitions', async () => {
  const { org, statusId, oppId } = await fixture()
  try {
    await withBypassContext(() => db.execute(sql`
      insert into custom_field_defs (org_id, target_table, key, label, field_type, config)
      values (${org.orgId}, 'crm_opportunities', 'segment', 'Segment', 'select', '{"options":["smb","enterprise"]}'::jsonb)`))
    const stored = async () => (await withBypassContext(() => db.execute<{ custom: unknown }>(sql`
      select custom from crm_opportunities where id = ${oppId}`))).rows[0]!.custom
    const header = {
      description: null, expectedCloseDate: null, forecastCategory: 'most_likely', leadSourceId: null, lines: [],
      nextStep: null, ownerUserId: null, partyId: null, primaryContactId: null, probability: 10, salesTeamId: null,
      statusId, title: 'Revision Opp', winLossReason: null,
    }
    for (const [custom, status, refusal] of [
      [{ segment: 'enterprise' }, 200, null],
      [{ segment: 'consumer' }, 422, /Segment: invalid option/],
      [{ region: 'west' }, 422, /unknown custom field: region/],
    ] as const) {
      const result = await patch(oppId, { ...header, custom, expectedUpdatedAt: (await read(oppId)).opportunity.updated_at })
      assert.equal(result.status, status, JSON.stringify(result.json))
      if (refusal) assert.match(String((result.json as { error?: unknown } | null)?.error ?? ''), refusal)
      assert.deepEqual(await stored(), { segment: 'enterprise' })
    }
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
