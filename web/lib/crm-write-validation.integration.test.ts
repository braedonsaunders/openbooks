import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from './auth'

// CRM write routes must (a) keep header probability and stored line detail in
// one exact relationship (weighted_amount = sum of line expected_amount) and
// (b) refuse malformed dates at the API boundary instead of surfacing a
// Postgres cast failure as a 500.
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __crmWriteValidationUser: state })
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: 'data:text/javascript,' + encodeURIComponent(source),
})
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (
      (specifier === './auth' || specifier.endsWith('/lib/auth')) &&
      context.parentURL?.endsWith('/web/lib/authz.ts')
    ) {
      return virtual(
        'export async function currentUser(){ return globalThis.__crmWriteValidationUser.user }',
      )
    }
    if (specifier.startsWith('@/'))
      return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } =
  await import('@openbooks/engine/src/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import('@openbooks/engine/src/test-fixtures.ts')
const { ensureCrmDefaults } = await import('@openbooks/engine/src/crm.ts')
const { PATCH: opportunityEdit } =
  await import('../app/api/crm/opportunities/[id]/route')
const { PATCH: activityEdit } =
  await import('../app/api/crm/activities/[id]/route')
const { POST: activityDraft } =
  await import('../app/api/crm/activities/draft/route')
const { PATCH: accountEdit } = await import('../app/api/crm/accounts/[id]/route')
const { NextRequest } = await import('next/server')

const request = (body: unknown) =>
  new Request('http://crm.local', { method: 'PATCH', body: JSON.stringify(body) })
const params = (id: string) => ({ params: Promise.resolve({ id }) })

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actor = await withBypassContext(() =>
      createScratchUser(org.orgId, 'CRM writer', 'crm_writer'),
    )
    await withBypassContext(async () => {
      await db.execute(
        sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb) || '{"crm":true}'::jsonb) where id=${org.orgId}`,
      )
      await db.execute(
        sql`update app_roles set permissions='["ar.read","ar.create","crm.opportunities.read","crm.opportunities.manage","crm.opportunities.close","crm.accounts.read","crm.accounts.manage","crm.activities.read","crm.activities.manage"]'::jsonb, subsidiary_restriction='{"mode":"all"}'::jsonb where org_id=${org.orgId} and key='crm_writer'`,
      )
    })
    state.user = {
      id: actor,
      orgId: org.orgId,
      name: 'CRM writer',
      email: 'crm-writer@scratch.test',
      roles: [],
      isSuperAdmin: false,
      envKind: 'production',
      productionOrgId: org.orgId,
      homeOrgId: org.orgId,
      homeUserId: actor,
    }
    return { org, actor }
  } catch (e) {
    await withBypassContext(() => dropScratchOrg(org.orgId))
    throw e
  }
}

async function seedOpportunity(orgId: string, actor: string, date: string) {
  await ensureCrmDefaults(orgId, actor)
  const status = (
    await db.execute<{ id: string }>(
      sql`select id from crm_opportunity_statuses where org_id=${orgId} and is_default and is_active limit 1`,
    )
  ).rows[0]!.id
  const id = randomUUID()
  // Header 10%: line 1 carries an explicit 100% override, line 2 inherits
  // (null), line 3 is a legacy row whose stored probability equals the header.
  await db.execute(
    sql`insert into crm_opportunities(id,org_id,opportunity_number,title,status_id,probability,currency,projected_amount,weighted_amount,expected_close_date,created_by,updated_by) values (${id},${orgId},${id},'Weighted opportunity',${status},10,'CAD','2500','1150',${date},${actor},${actor})`,
  )
  await db.execute(
    sql`insert into crm_opportunity_lines(org_id,opportunity_id,line_number,description,quantity,unit_price,amount,probability,expected_amount,created_by,updated_by) values
      (${orgId},${id},1,'Override line','1','1000','1000',100,'1000',${actor},${actor}),
      (${orgId},${id},2,'Inherited line','1','1000','1000',null,'100',${actor},${actor}),
      (${orgId},${id},3,'Legacy inherited line','1','500','500',10,'50',${actor},${actor})`,
  )
  return { id, status }
}

async function storedLines(orgId: string, id: string) {
  return (
    await db.execute<{ line_number: number; probability: number | null; expected_amount: string }>(
      sql`select line_number, probability, expected_amount from crm_opportunity_lines where org_id=${orgId} and opportunity_id=${id} order by line_number`,
    )
  ).rows
}

async function header(orgId: string, id: string) {
  return (
    await db.execute<{ probability: number; projected_amount: string; weighted_amount: string; expected_close_date: string | null }>(
      sql`select probability, projected_amount, weighted_amount, expected_close_date::text from crm_opportunities where org_id=${orgId} and id=${id}`,
    )
  ).rows[0]!
}

test(
  'PATCH probability without lines re-weights the stored line detail exactly',
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { org, actor } = await fixture()
    try {
      await withOrgContext(org.orgId, async () => {
        const { id } = await seedOpportunity(org.orgId, actor, org.date)
        const edited = await opportunityEdit(request({ probability: 20 }), params(id))
        assert.equal(edited.status, 200, JSON.stringify(await edited.clone().json()))
        const row = await header(org.orgId, id)
        assert.equal(row.probability, 20)
        assert.equal(row.projected_amount, '2500.0000')
        // 1000 (override stays at 100%) + 200 (inherited) + 100 (legacy inherited)
        assert.equal(row.weighted_amount, '1300.0000')
        assert.deepEqual(await storedLines(org.orgId, id), [
          { line_number: 1, probability: 100, expected_amount: '1000.0000' },
          { line_number: 2, probability: null, expected_amount: '200.0000' },
          { line_number: 3, probability: null, expected_amount: '100.0000' },
        ])
        // A second header move keeps following: the normalized rows inherit.
        const again = await opportunityEdit(request({ probability: 50 }), params(id))
        assert.equal(again.status, 200)
        assert.equal((await header(org.orgId, id)).weighted_amount, '1750.0000')
        assert.deepEqual(
          (await storedLines(org.orgId, id)).map((line) => line.expected_amount),
          ['1000.0000', '500.0000', '250.0000'],
        )
      })
    } finally {
      state.user = null
      await withBypassContext(() => dropScratchOrg(org.orgId))
    }
  },
)

test(
  'a status-only change that moves the header probability re-weights lines',
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { org, actor } = await fixture()
    try {
      await withOrgContext(org.orgId, async () => {
        const { id, status } = await seedOpportunity(org.orgId, actor, org.date)
        const next = (
          await db.execute<{ id: string; probability: number }>(
            sql`select id, probability from crm_opportunity_statuses where org_id=${org.orgId} and is_active and not is_closed and id<>${status} and probability<>10 order by sequence limit 1`,
          )
        ).rows[0]
        assert.ok(next, 'defaults seed an open status with a different probability')
        const edited = await opportunityEdit(request({ statusId: next.id }), params(id))
        assert.equal(edited.status, 200, JSON.stringify(await edited.clone().json()))
        const row = await header(org.orgId, id)
        assert.equal(row.probability, next.probability)
        const lines = await storedLines(org.orgId, id)
        const total = lines.reduce((sum, line) => sum + Number(line.expected_amount), 0)
        assert.equal(Number(row.weighted_amount), total)
        assert.equal(lines[0]!.expected_amount, '1000.0000')
        assert.equal(lines[1]!.probability, null)
        assert.equal(lines[2]!.probability, null)
      })
    } finally {
      state.user = null
      await withBypassContext(() => dropScratchOrg(org.orgId))
    }
  },
)

test(
  'resent lines store null probability when they inherit the header',
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { org, actor } = await fixture()
    try {
      await withOrgContext(org.orgId, async () => {
        const { id } = await seedOpportunity(org.orgId, actor, org.date)
        const edited = await opportunityEdit(
          request({
            probability: 30,
            lines: [
              { itemId: org.items.service, quantity: '2', unitPrice: '100' },
              { itemId: org.items.service, quantity: '1', unitPrice: '100', probability: 60 },
            ],
          }),
          params(id),
        )
        assert.equal(edited.status, 200, JSON.stringify(await edited.clone().json()))
        assert.deepEqual(await storedLines(org.orgId, id), [
          { line_number: 1, probability: null, expected_amount: '60.0000' },
          { line_number: 2, probability: 60, expected_amount: '60.0000' },
        ])
        const row = await header(org.orgId, id)
        assert.equal(row.projected_amount, '300.0000')
        assert.equal(row.weighted_amount, '120.0000')
        const moved = await opportunityEdit(request({ probability: 40 }), params(id))
        assert.equal(moved.status, 200)
        assert.equal((await header(org.orgId, id)).weighted_amount, '140.0000')
      })
    } finally {
      state.user = null
      await withBypassContext(() => dropScratchOrg(org.orgId))
    }
  },
)

test(
  'malformed CRM dates are refused with 422 before reaching SQL',
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { org, actor } = await fixture()
    try {
      await withOrgContext(org.orgId, async () => {
        const { id } = await seedOpportunity(org.orgId, actor, org.date)
        for (const expectedCloseDate of ['soon', '2026-02-30', '20260301', 'tomorrow', 12]) {
          const response = await opportunityEdit(request({ expectedCloseDate }), params(id))
          assert.equal(response.status, 422, `expectedCloseDate=${String(expectedCloseDate)}`)
        }
        assert.equal((await header(org.orgId, id)).expected_close_date, org.date)
        const accepted = await opportunityEdit(request({ expectedCloseDate: '2026-03-01' }), params(id))
        assert.equal(accepted.status, 200, JSON.stringify(await accepted.clone().json()))
        assert.equal((await header(org.orgId, id)).expected_close_date, '2026-03-01')
        const cleared = await opportunityEdit(request({ expectedCloseDate: null }), params(id))
        assert.equal(cleared.status, 200)
        assert.equal((await header(org.orgId, id)).expected_close_date, null)

        const draft = await activityDraft(
          new NextRequest('http://crm.local', { method: 'POST', body: JSON.stringify({ kind: 'event' }) }),
        )
        assert.equal(draft.status, 200)
        const activityId = (await draft.json()).id
        for (const body of [
          { startsAt: 'soon' },
          { dueAt: '2026-13-01T10:00' },
          { reminderAt: 'next week' },
          { endsAt: '2026-09-05T25:00' },
          { startsAt: '2026-09-05T10:30', endsAt: '2026-09-05T09:00' },
        ]) {
          const response = await activityEdit(request(body), params(activityId))
          assert.equal(response.status, 422, JSON.stringify(body))
        }
        const scheduled = await activityEdit(
          request({ startsAt: '2026-09-05T10:30', endsAt: '2026-09-05T11:30', dueAt: '2026-09-05', reminderAt: '2026-09-05T10:00:00Z' }),
          params(activityId),
        )
        assert.equal(scheduled.status, 200, JSON.stringify(await scheduled.clone().json()))
        // Cross-field ordering is checked against the STORED start when only
        // the end moves, so the database check constraint never fires a 500.
        const reordered = await activityEdit(request({ endsAt: '2026-09-05T09:00' }), params(activityId))
        assert.equal(reordered.status, 422)

        await db.execute(
          sql`insert into crm_account_profiles(org_id,party_id,lifecycle_stage,created_by,updated_by) values (${org.orgId},${org.customerId},'customer',${actor},${actor}) on conflict do nothing`,
        )
        for (const nextActionAt of ['soon', '2026-02-30T10:00', 'later']) {
          const response = await accountEdit(request({ nextActionAt }), params(org.customerId))
          assert.equal(response.status, 422, nextActionAt)
        }
        const followUp = await accountEdit(request({ nextActionAt: '2026-09-05T10:30' }), params(org.customerId))
        assert.equal(followUp.status, 200, JSON.stringify(await followUp.clone().json()))
      })
    } finally {
      state.user = null
      await withBypassContext(() => dropScratchOrg(org.orgId))
    }
  },
)
