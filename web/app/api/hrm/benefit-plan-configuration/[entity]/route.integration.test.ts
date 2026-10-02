import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { stubModules } from '../../../../../testing/stub-modules'
import { db, withBypassContext } from '@openbooks/engine/platform/database'
import { createScratchOrg, createScratchUser, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'
import { setFeatures } from '@openbooks/engine/src/testing/hrm-harness.ts'

const stateKey = Symbol.for('openbooks.benefit-plan-configuration-route')
const state = {
  authz: null as null | { user: { orgId: string; id: string }; permissions: Set<string>; allowedSubsidiaryIds: ReadonlySet<string> | null },
  forbidden: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state
const authzSource = `
  const state = globalThis[Symbol.for('openbooks.benefit-plan-configuration-route')]
  export async function guardPermission(permission) {
    return state.authz?.permissions.has(permission) ? state.authz : state.forbidden
  }
  export async function getAuthz() { return state.authz }
  export function guardSubsidiaryScope() { return null }
  export function guardUnrestrictedScope() { return null }
  export async function guardRootSubsidiaryScope() { return null }
`
stubModules({ authz: { source: authzSource } })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './authz' && context.parentURL?.endsWith('/web/lib/feature-gates.ts')) {
      return { url: 'openbooks:test:benefit-plan-authz', shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    return url === 'openbooks:test:benefit-plan-authz'
      ? { format: 'module', source: authzSource, shortCircuit: true }
      : next(url, context)
  },
})
const routeReady = import('./route')
const DB = Boolean(process.env.OPENBOOKS_DB_URL)
const call = (entity = 'benefit-plans') => ({ params: Promise.resolve({ entity }) })
const plan = (subsidiaryId: string) => ({
  code: 'HEALTH', name: 'Health coverage', kind: 'health', currency: 'CAD',
  employerSubsidiaryId: subsidiaryId,
  approvalMode: 'none', waitingPeriodDays: 0,
  effectiveFrom: '2026-01-01', isActive: false,
})
function request(method: string, body?: unknown, requestId: string = randomUUID(), entity = 'benefit-plans', id?: string) {
  return new Request(`http://localhost/api/hrm/benefit-plan-configuration/${entity}${id ? `?id=${id}` : ''}`, {
    method, headers: { 'Idempotency-Key': requestId },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}
async function fixture(fn: (org: Awaited<ReturnType<typeof createScratchOrg>>, actorId: string) => Promise<void>) {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, 'Benefits manager', 'benefits_manager'))
    await withBypassContext(() => setFeatures(org.orgId, { hrm: true, payroll: true, multiSubsidiary: false }))
    state.authz = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(['hrm.benefits.manage']), allowedSubsidiaryIds: null }
    await fn(org, actorId)
  } finally {
    state.authz = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
}

test('HR management creates and edits native offers and eligibility classes with idempotent audit evidence', { skip: !DB }, async () => {
  await fixture(async (org, actorId) => {
    const { POST, PATCH } = await routeReady
    const requestId = randomUUID()
    const body = plan(org.subsidiaryId)
    const created = await POST(request('POST', body, requestId), call())
    assert.equal(created.status, 200, await created.clone().text())
    const replayed = await POST(request('POST', body, requestId), call())
    assert.equal(replayed.status, 200, await replayed.clone().text())
    assert.deepEqual(await replayed.json(), await created.json())
    const changed = await POST(request('POST', { ...body, name: 'Different coverage' }, requestId), call())
    assert.equal(changed.status, 409)
    const edited = await PATCH(request('PATCH', { ...body, id: requestId, name: 'Extended health coverage', waitingPeriodMonths: '' }), call())
    assert.equal(edited.status, 200, await edited.clone().text())
    const tierId = randomUUID()
    const tier = await POST(request('POST', { planId: requestId, classKey: 'family', name: 'Family coverage' }, tierId, 'benefit-contribution-classes'), call('benefit-contribution-classes'))
    assert.equal(tier.status, 200, await tier.clone().text())
    const recovery = await POST(request('POST', { planId: requestId, ruleId: randomUUID(), premiumRuleId: randomUUID() }, randomUUID(), 'benefit-recovery-sources'), call('benefit-recovery-sources'))
    assert.equal(recovery.status, 400)
    assert.match((await recovery.json()).error, /Link an employee carry deduction.*same plan/)
    await withBypassContext(async () => {
      const stored = (await db.execute<{ name: string; active: boolean }>(sql`select name, is_active as active from hrm_benefit_plans where org_id = ${org.orgId} and id = ${requestId}`)).rows[0]
      assert.deepEqual(stored, { name: 'Extended health coverage', active: false })
      const audits = (await db.execute<{ action: string; actorId: string; changes: Record<string, unknown> }>(sql`select action, actor_id::text as "actorId", changes from audit_log where org_id = ${org.orgId} and table_name = 'hrm_benefit_plans' and row_id = ${requestId} order by at, id`)).rows
      assert.equal(audits.length, 2, 'the retry must not duplicate creation or audit')
      assert.deepEqual(audits.map(a => a.actorId), [actorId, actorId])
      assert.ok(audits.find(a => a.action === 'update')?.changes.before)
      assert.ok(audits.find(a => a.action === 'update')?.changes.after)
    })
  })
})

test('the Benefits configuration adapter refuses missing permission and unrelated entities', { skip: !DB }, async () => {
  await fixture(async (org) => {
    const { POST } = await routeReady
    state.authz!.permissions.clear()
    assert.equal((await POST(request('POST', plan(org.subsidiaryId)), call())).status, 403)
    state.authz!.permissions.add('hrm.benefits.manage')
    assert.equal((await POST(request('POST', { name: 'Unauthorized account' }, randomUUID(), 'accounts'), call('accounts'))).status, 400)
    assert.equal((await POST(request('POST', plan(org.subsidiaryId), 'invalid'), call())).status, 400)
  })
})

test('plan writes preserve native validation and feature refusals', { skip: !DB }, async () => {
  await fixture(async (org) => {
    const { POST } = await routeReady
    const invalid = await POST(request('POST', { ...plan(org.subsidiaryId), waitingPeriodDays: 30, waitingPeriodMonths: 3 }), call())
    assert.equal(invalid.status, 400)
    assert.match((await invalid.json()).error, /months or days, not both/i)
    await withBypassContext(() => setFeatures(org.orgId, { hrm: false }))
    assert.equal((await POST(request('POST', plan(org.subsidiaryId)), call())).status, 404)
  })
})

test('offer and class mutations cannot cross organization or legal-entity boundaries', { skip: !DB }, async () => {
  await fixture(async (org) => {
    const { POST, PATCH, DELETE } = await routeReady
    const foreign = await withBypassContext(() => createScratchOrg())
    try {
      const outside = await POST(request('POST', plan(foreign.subsidiaryId)), call())
      assert.equal(outside.status, 400, await outside.clone().text())
      const id = randomUUID()
      const body = plan(org.subsidiaryId)
      const created = await POST(request('POST', body, id), call())
      assert.equal(created.status, 200, await created.clone().text())
      state.authz!.allowedSubsidiaryIds = new Set([foreign.subsidiaryId])
      const edited = await PATCH(request('PATCH', { ...body, id, name: 'Out of scope' }), call())
      assert.equal(edited.status, 403, await edited.clone().text())
      assert.match((await edited.json()).error, /outside your allowed scope/)
      const deleted = await DELETE(request('DELETE', undefined, randomUUID(), 'benefit-plans', id), call())
      assert.equal(deleted.status, 403, await deleted.clone().text())
      assert.match((await deleted.json()).error, /outside your allowed scope/)
      const tier = await POST(request('POST', { planId: id, classKey: 'family', name: 'Family coverage' }, randomUUID(), 'benefit-contribution-classes'), call('benefit-contribution-classes'))
      assert.ok(tier.status >= 400 && tier.status < 500, await tier.clone().text())
      await withBypassContext(async () => {
        assert.equal((await db.execute<{ name: string }>(sql`select name from hrm_benefit_plans where org_id = ${org.orgId} and id = ${id}`)).rows[0]?.name, body.name)
      })
    } finally { await withBypassContext(() => dropScratchOrg(foreign.orgId)) }
  })
})
