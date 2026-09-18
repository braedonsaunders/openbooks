import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Opportunity PATCH validates line quantities/prices, team contributions, and
// range bounds to 4dp but never bounds their magnitude, so a pasted 20-digit
// figure sails through validation and dies in Postgres as a raw numeric(19,4)
// overflow (HTTP 500 — the verb rethrows non-domain errors) instead of failing
// closed with a named 422. Every figure lands in a numeric(19,4) column.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __opportunityPatchMagnitudeState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'next/navigation') return virtual('export function redirect() {}')
    if (specifier === '../../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__opportunityPatchMagnitudeState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier === '../../../../../lib/feature-gates') return virtual(`
      export async function guardFeaturePermission() {
        const s = globalThis.__opportunityPatchMagnitudeState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/test-fixtures.ts')
const { PATCH } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg())
  state.orgId = org.orgId
  state.actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
  const statusId = await withBypassContext(async () => {
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features','{}'::jsonb) || '{"crm": true}'::jsonb)
       where id = ${org.orgId}`)
    const statusId = (await db.execute<{ id: string }>(sql`
      insert into crm_opportunity_statuses (org_id, key, name, probability, is_closed, is_won, is_active)
      values (${org.orgId}, 'open', 'Open', 10, false, false, true)
      returning id`)).rows[0]!.id
    return statusId
  })
  const itemId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into items (org_id, kind, name, is_active)
    values (${org.orgId}, 'service', 'Opp Item', true)
    returning id`))).rows[0]!.id
  const oppId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into crm_opportunities (org_id, opportunity_number, title, status_id, currency)
    values (${org.orgId}, 'OPP-001', 'Magnitude Opp', ${statusId}, 'CAD')
    returning id`))).rows[0]!.id
  return { org, statusId, itemId, oppId }
}

async function revision(id: string): Promise<string> {
  const row = (await db.execute<{ revision: string }>(sql`
    select (revision_seq)::text as revision
      from crm_opportunities where id = ${id}`)).rows[0]!
  return row.revision
}

async function patch(id: string, body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
  try {
    // Saves speak the revision contract: attach the live token so the
    // magnitude assertions exercise validation, not the 409 guard.
    // The token read rides the same org scope as the PATCH itself.
    const response = await withOrgContext(state.orgId, async () => {
      const expectedUpdatedAt = await revision(id)
      return PATCH(
        new Request(`http://crm.test/api/crm/opportunities/${id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, expectedUpdatedAt }),
        }),
        { params: Promise.resolve({ id }) },
      )
    })
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

async function lineCount(oppId: string): Promise<number> {
  const rows = (await withOrgContext(state.orgId, () => db.execute<{ n: number }>(sql`
    select count(*)::int as n from crm_opportunity_lines where opportunity_id = ${oppId}`))).rows
  return rows[0]!.n
}

function base(statusId: string, extra: Record<string, unknown> = {}) {
  return { statusId, ...extra }
}

test('PATCH refuses a line quantity wider than numeric(19,4) without writing', { skip: !DB }, async () => {
  const { org, statusId, itemId, oppId } = await fixture()
  try {
    const result = await patch(oppId, base(statusId, {
      lines: [{ itemId, quantity: '99999999999999999999', unitPrice: '10' }],
    }))
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await lineCount(oppId), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH refuses a line unit price wider than numeric(19,4) without writing', { skip: !DB }, async () => {
  const { org, statusId, itemId, oppId } = await fixture()
  try {
    const result = await patch(oppId, base(statusId, {
      lines: [{ itemId, quantity: '1', unitPrice: '99999999999999999999' }],
    }))
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
    assert.equal(await lineCount(oppId), 0)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH refuses a range bound wider than numeric(19,4) without writing', { skip: !DB }, async () => {
  const { org, statusId, oppId } = await fixture()
  try {
    const result = await patch(oppId, base(statusId, { rangeLow: '99999999999999999999' }))
    assert.equal(result.status, 422, `expected 422, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('PATCH still saves a column-maximum line with identical read-back', { skip: !DB }, async () => {
  const { org, statusId, itemId, oppId } = await fixture()
  try {
    const result = await patch(oppId, base(statusId, {
      lines: [{ itemId, quantity: '1', unitPrice: '999999999999999.9999' }],
    }))
    assert.equal(result.status, 200, JSON.stringify(result.json))
    const rows = (await withOrgContext(state.orgId, () => db.execute<{ unit_price: string; amount: string }>(sql`
      select unit_price::text as unit_price, amount::text as amount
        from crm_opportunity_lines where opportunity_id = ${oppId}`))).rows
    assert.equal(rows[0]!.unit_price, '999999999999999.9999')
    assert.equal(rows[0]!.amount, '999999999999999.9999')
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
