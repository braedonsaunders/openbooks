import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { ReactElement } from 'react'
import type { DriftRow } from '../app/(app)/admin/setup/overhead/OverheadLifecycle'
import type { TrueCostData } from './analytics/true-cost-data'

const state = { modelReads: 0, model: null as TrueCostData | null }
const stateKey = Symbol.for('openbooks.overhead-lifecycle-read-test')
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state
const nativeReader = new URL('./analytics/true-cost-data.ts', import.meta.url).href
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '../../../../../lib/analytics/true-cost-data' && context.parentURL?.includes('/setup/overhead/')) {
    return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
      import {trueCostData as read} from ${JSON.stringify(nativeReader)};
      export async function trueCostData(...args) {
        globalThis[Symbol.for('openbooks.overhead-lifecycle-read-test')].modelReads++;
        const model = await read(...args);
        globalThis[Symbol.for('openbooks.overhead-lifecycle-read-test')].model = model;
        return model;
      }
    `) }
  }
  if (specifier === 'next-intl/server') return { shortCircuit: true, url: 'data:text/javascript,export async function getTranslations(){return key=>key} export async function getLocale(){return "en"}' }
  if (specifier === 'next/headers') return { shortCircuit: true, url: 'data:text/javascript,export async function cookies(){return {get(){return undefined}}}' }
  return next(specifier, context)
} })
test.after(() => hooks.deregister())
Object.assign(globalThis, { React: await import('react') })
const { sql } = await import('drizzle-orm')
const { db, withOrgContext, withBypass } = await import('@openbooks/engine/src/platform/db.ts')
const { withSimClock } = await import('@openbooks/engine/src/platform/clock.ts')
const { toUnits } = await import('@openbooks/engine/src/money/money.ts')
const { postEntry } = await import('@openbooks/engine/src/journal/post-entry.ts')
const { assertDedicatedFixtureDatabase, createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { resolveAuthzByUserId } = await import('./authz-core')
const { withAuthzContext } = await import('./authz-context')
const { publishOverheadRates } = await import('./overhead-publish')
const { loadOverhead, overheadSpec } = await import('../app/(app)/admin/setup/overhead/view')
const { OverheadLifecycleTabSlot } = await import('../app/(app)/admin/setup/overhead/sections')

function widgetProps(value: unknown, name: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (record.kind === 'widget' && record.widget === name) return record.props as Record<string, unknown>
  for (const child of Object.values(record)) {
    const found = widgetProps(child, name)
    if (found) return found
  }
}

test('overhead lifecycle shares one native model read while published rates, feature authority and legal-entity scope remain current',
  { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    await assertDedicatedFixtureDatabase()
    const org = await createScratchOrg()
    const department = randomUUID(), employee = randomUUID(), project = randomUUID(), category = randomUUID()
    try {
      const actor = await createScratchUser(org.orgId, 'Overhead Controller', 'overhead_controller')
      await withBypass(async () => {
        await db.execute(sql`update app_roles set permissions='["admin.setup.manage"]'::jsonb
          where org_id=${org.orgId} and key='overhead_controller'`)
        await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,projects}','true'::jsonb,true)
          where id=${org.orgId}`)
        await db.execute(sql`insert into departments(id,org_id,name) values(${department},${org.orgId},'Operations')`)
        await db.execute(sql`insert into parties(id,org_id,kind,display_name,subsidiary_id)
          values(${employee},${org.orgId},'person','Worker',${org.subsidiaryId})`)
        await db.execute(sql`insert into projects(id,org_id,subsidiary_id,code,name,customer_id,status,is_active)
          values(${project},${org.orgId},${org.subsidiaryId},'OVERHEAD','Overhead work',${org.customerId},'active',true)`)
        await db.execute(sql`insert into account_groups(id,org_id,dimension,key,name)
          values(${category},${org.orgId},'burden','office','Office')`)
        await db.execute(sql`insert into account_group_members(org_id,group_id,account_id,dimension)
          values(${org.orgId},${category},${org.accounts.cogs},'burden')`)
        await db.execute(sql`insert into time_entries(org_id,employee_party_id,worked_on,hours,project_id,item_id,department_id,is_billable,cost_rate,status)
          values(${org.orgId},${employee},${org.date},4,${project},${org.items.service},${department},true,4,'approved')`)
      })
      await withSimClock(org.date, () => withOrgContext(org.orgId, async () => {
        await postEntry(db, {
          orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId,
          postingDate: org.date, periodId: org.periodId, entryNumber: `OVH-${randomUUID()}`, origin: 'manual', currency: 'CAD',
          lines: [
            { accountId: org.accounts.cogs, departmentId: department, amount: '100', txnAmount: '100', fxRate: '1' },
            { accountId: org.accounts.bank, departmentId: department, amount: '-100', txnAmount: '-100', fxRate: '1' },
          ],
        })
        const authz = await resolveAuthzByUserId(org.orgId, actor)
        assert.ok(authz)
        assert.ok(authz.permissions.has('admin.setup.manage'))
        const history = async () => (await db.execute(sql`select * from journal_lines where org_id=${org.orgId} order by id`)).rows
        const before = await history()
        assert.equal(before.length, 2)
        state.modelReads = 0
        await withAuthzContext(authz, async () => {
          const data = await loadOverhead({ view: 'lifecycle' })
          assert.equal(state.modelReads, 1)
          assert.equal(data.onLifecycle, true)
          assert.equal(data.actions.departments.length, 1)
          assert.equal(data.actions.departments[0]?.composite, 25)
          assert.ok(data.trueCost)
          assert.ok(state.model)
          assert.equal(state.model.labor.employees.length, 1)
          assert.ok(state.model.monthly.length > 0)
          assert.ok(!('employees' in data.trueCost.labor))
          assert.ok(!('monthly' in data.trueCost))
          assert.ok(!('forecast' in data.trueCost))
          const { monthly: _monthly, forecast: _forecast, labor, ...model } = state.model
          const { employees: _employees, ...laborSummary } = labor
          assert.deepEqual(data.trueCost, { ...model, labor: laborSummary },
            'the native loader must retain model values and refusals while bounding its client payload')
          const props = widgetProps(overheadSpec(data), 'overhead-lifecycle-tab')
          assert.ok(props)
          assert.deepEqual(props.departments, data.actions.departments)
          assert.deepEqual(widgetProps(overheadSpec({ ...data, trueCost: null }), 'overhead-lifecycle-tab'), {},
            'a refused model must retain the native refusal path rather than share an empty calculation')
          // Publish after the header calculation: the body must read the new
          // card without recalculating or rewriting the retained ledger.
          await publishOverheadRates(org.orgId, actor, org.date, [{ departmentId: department, ratePerHour: '25.57' }])
          const lifecycleProps = { departments: data.actions.departments }
          const body = await OverheadLifecycleTabSlot(lifecycleProps)
          assert.ok(body)
          const { drift } = (body as ReactElement<{ drift: DriftRow[] }>).props
          assert.equal(state.modelReads, 1)
          assert.equal(drift.length, 1)
          assert.equal(drift[0]?.id, department)
          assert.equal(drift[0]?.live, 25)
          assert.equal(typeof drift[0]?.published, 'string')
          assert.equal(toUnits(drift[0]!.published!), toUnits('25.57'))
          const refusedComposite = await OverheadLifecycleTabSlot({ departments: [{ id: department, name: 'Operations', composite: null }] })
          assert.equal((refusedComposite as ReactElement<{ drift: DriftRow[] }>).props.drift[0]?.live, null)
          const legacy = await OverheadLifecycleTabSlot()
          assert.deepEqual((legacy as ReactElement<{ drift: DriftRow[] }>).props.drift, drift)
          assert.equal(state.modelReads, 2, 'a stored layout without shared rows retains the native reader')
          await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,projects}','false'::jsonb,true) where id=${org.orgId}`)
          await assert.rejects(OverheadLifecycleTabSlot(lifecycleProps), /projects feature is disabled/)
          assert.equal(state.modelReads, 2)
        })
        await withAuthzContext({ ...authz, allowedSubsidiaryIds: new Set([randomUUID()]) }, async () => {
          await assert.rejects(OverheadLifecycleTabSlot({ departments: [{ id: department, name: 'Operations', composite: 25 }] }),
            (error: unknown) => (error as { digest?: string }).digest === 'NEXT_HTTP_ERROR_FALLBACK;404')
          assert.equal(state.modelReads, 2)
        })
        await db.execute(sql`update app_roles set permissions='[]'::jsonb where org_id=${org.orgId} and key='overhead_controller'`)
        const revoked = await resolveAuthzByUserId(org.orgId, actor)
        assert.ok(revoked)
        await withAuthzContext(revoked, async () => {
          await assert.rejects(loadOverhead({ view: 'lifecycle' }),
            (error: unknown) => (error as { digest?: string }).digest?.startsWith('NEXT_REDIRECT;') === true)
          assert.equal(state.modelReads, 2)
        })
        assert.deepEqual(await history(), before)
      }))
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
