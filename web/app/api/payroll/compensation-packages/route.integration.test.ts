import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { NextResponse } from 'next/server'

const state = { orgId: '', actorId: '', permissions: [] as string[] }
Object.assign(globalThis, { __compensationPackageRequest: state, __compensationPackageNextResponse: NextResponse })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@/lib/feature-gates' && context.parentURL?.includes('/lib/api/route')) return {
    shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
      export async function guardFeaturePermission(permission) {
        const s=globalThis.__compensationPackageRequest; s.permissions.push(permission);
        return {user:{orgId:s.orgId,id:s.actorId},allowedSubsidiaryIds:null};
      }
    `),
  }
  if (specifier === '@/lib/analytics/preview-invalidation') return {
    shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export async function invalidateAnalyticsPreviews() {}'),
  }
  return next(specifier, context)
} })

const { db, withOrgContext, withBypassContext } = await import('@openbooks/engine/platform/database')
const { DB, setupHarness, withHarness, seedEmployment } = await import('@openbooks/engine/src/testing/hrm-harness.ts')
const { seedPayrollSchedule, seedPayrollProfile } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { sql } = await import('drizzle-orm')
const collection = await import('./route')
const versionRoute = await import('./[id]/versions/route')
const versionUpdate = await import('./[id]/versions/[versionId]/route')
const submitRoute = await import('./[id]/versions/[versionId]/submit/route')
const decisionRoute = await import('./[id]/versions/[versionId]/decision/route')
const previewRoute = await import('./[id]/versions/[versionId]/preview/route')
const assignments = await import('./[id]/assignments/route')
const assignmentAction = await import('./[id]/assignments/[assignmentId]/route')
const assignmentDecision = await import('./[id]/assignments/[assignmentId]/decision/route')

const spec = { country: 'CA', features: ['payroll', 'hrm', 'compensationPackages'], users: [
  { key: 'authorId', name: 'Package author', handle: 'package_author', permissions: ['payroll.manage', 'payroll.read', 'hrm.compensation.approve'], link: true },
  { key: 'approverId', name: 'Package approver', handle: 'package_approver', permissions: ['payroll.read', 'hrm.compensation.approve'], link: true },
] } as const
async function setup() {
  return setupHarness(spec, async ({ org, authorId }) => {
    const worker = await seedEmployment(org.orgId, org.subsidiaryId, { from: '2026-01-01' })
    const schedule = randomUUID()
    await seedPayrollSchedule(org.orgId, schedule, authorId, { name: 'Monthly', frequency: 'monthly', periodsPerYear: 12, anchorPeriodEnd: '2026-01-31', payDateOffsetDays: 1 })
    await seedPayrollProfile(org.orgId, worker.workerPartyId, worker.employmentId, schedule, authorId, { country: 'CA', province: 'ON', payBasis: 'hourly' })
    const componentId = randomUUID()
    await db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,basis,value,is_active)
      values(${componentId},${org.orgId},'PKG_TRAVEL','Travel allowance','earning','CA','fixed_amount','0',true)`)
    return { ...worker, componentId }
  })
}
type Handler = (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>
async function post(handler: Handler, body: unknown, params: Record<string, string> = {}, key: string | null = randomUUID(), method = 'POST') {
  return withOrgContext(state.orgId, () => handler(new Request('http://payroll.test/api/payroll/compensation-packages', {
    method, headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body),
  }), { params: Promise.resolve(params) }))
}
async function saved<T>(response: Response): Promise<T> {
  assert.ok(response.ok, `Expected success: ${response.status} ${await response.clone().text()}`)
  return response.json() as Promise<T>
}
async function refusal(response: Response, status: number, message: RegExp) {
  assert.equal(response.status, status, await response.clone().text())
  assert.match((await response.json() as { error: string }).error, message)
}

test('native package API refuses malformed bodies, missing create identity and changed retries without extra rows', { skip: !DB }, async () => {
  await withHarness(setup, async (f) => {
    Object.assign(state, { orgId: f.org.orgId, actorId: f.authorId, permissions: [] })
    const body = { subsidiaryId: f.org.subsidiaryId, code: 'API_PACKAGE', name: 'Native package', country: 'CA', currency: 'CAD', reason: 'Employer configuration' }
    await refusal(await post(collection.POST, { ...body, orgId: randomUUID() }), 422, /Unrecognized key/)
    await refusal(await post(collection.POST, body, {}, null), 400, /UUID Idempotency-Key.*reopen/)
    const key = randomUUID()
    const first = await saved<{ id: string }>(await post(collection.POST, body, {}, key))
    const retry = await saved<{ id: string }>(await post(collection.POST, body, {}, key))
    assert.equal(first.id, key); assert.equal(retry.id, first.id)
    await refusal(await post(collection.POST, { ...body, name: 'Changed payload' }, {}, key), 422, /already saved with different details.*reopen/)
    const rows = await withBypassContext(() => db.execute(sql`select id from payroll_compensation_packages where org_id=${f.org.orgId}`))
    assert.equal(rows.rows.length, 1)
    assert.ok(state.permissions.every((permission) => permission === 'payroll.manage'))
  }, { bypass: true })
})

test('native package endpoints preserve independent decisions, exact previews and employee assignment refusals', { skip: !DB }, async () => {
  await withHarness(setup, async (f) => {
    Object.assign(state, { orgId: f.org.orgId, actorId: f.authorId, permissions: [] })
    const pack = await saved<{ id: string }>(await post(collection.POST, { subsidiaryId: f.org.subsidiaryId, code: 'ALLOWANCE', name: 'Travel package', country: 'CA', currency: 'CAD', reason: 'Declared employer terms' }))
    const definition = { orgId: f.org.orgId, country: 'CA', currency: 'CAD', partialPeriod: 'allow',
      inputs: [{ name: 'allowance', type: { kind: 'money', currency: 'CAD' }, source: 'assignment', minimum: '0', maximum: '1000' }],
      rules: [{ key: 'travel', componentId: f.componentId, expression: 'allowance', proration: 'calendar_days', rounding: { scale: 2, mode: 'half_even', maxWholeDigits: 15 } }] }
    await refusal(await post(versionRoute.POST, { definition, effectiveFrom: '2026-02-30', effectiveTo: null, reason: 'Invalid date' }, { id: pack.id }), 422, /valid calendar date/)
    let version = await saved<{ id: string; revision: number }>(await post(versionRoute.POST, { definition, effectiveFrom: '2026-01-01', effectiveTo: null, reason: 'Approved policy proposal' }, { id: pack.id }))
    const params = { id: pack.id, versionId: version.id }
    const draftRevision = version.revision
    version = await saved<{ id: string; revision: number }>(await post(versionUpdate.PATCH, { definition, effectiveFrom: '2026-01-01', effectiveTo: null, expectedRevision: draftRevision, reason: 'Refined draft policy' }, params, null, 'PATCH'))
    await refusal(await post(versionUpdate.PATCH, { definition, effectiveFrom: '2026-01-01', effectiveTo: null, expectedRevision: draftRevision, reason: 'Stale draft editor' }, params, null, 'PATCH'), 422, /revision changed.*reload/i)
    const submitted = await saved<{ revision: number }>(await post(submitRoute.POST, { expectedRevision: version.revision, reason: 'Review proposal' }, params))
    await refusal(await post(versionUpdate.PATCH, { definition, effectiveFrom: '2026-01-01', effectiveTo: null, expectedRevision: submitted.revision, reason: 'Rewrite submitted policy' }, params, null, 'PATCH'), 422, /draft|submitted.*immutable/i)
    await refusal(await post(decisionRoute.POST, { expectedRevision: submitted.revision, action: 'approve', reason: 'Self decision' }, params), 422, /author.*independent approver/)
    state.actorId = f.approverId
    const approved = await saved<{ status: string }>(await post(decisionRoute.POST, { expectedRevision: submitted.revision, action: 'approve', reason: 'Independent policy review' }, params))
    assert.equal(approved.status, 'approved'); assert.equal(state.permissions.at(-1), 'hrm.compensation.approve')
    const preview = await saved<{ coveredDays: number; lines: { amount: string }[] }>(await post(previewRoute.POST, { context: {
      periodStart: '2026-01-01', periodEnd: '2026-01-31', effectiveFrom: '2026-01-16', effectiveTo: null,
      values: { allowance: '310' }, occupiedComponentIds: [], replacementComponentIds: [],
    } }, params))
    assert.equal(preview.coveredDays, 16); assert.equal(preview.lines[0]?.amount, '160.0000')
    state.actorId = f.authorId
    const employeeInput = { versionId: version.id, employmentId: f.employmentId, effectiveFrom: '2026-01-01', effectiveTo: null, inputs: { allowance: '12,34' }, reason: 'Employee terms' }
    await refusal(await post(assignments.POST, employeeInput, { id: pack.id }), 422, /write "12,34" as "12.34"/)
    let assignment = await saved<{ id: string; revision: number }>(await post(assignments.POST, { ...employeeInput, inputs: { allowance: '310' } }, { id: pack.id }))
    const employeeParams = { id: pack.id, assignmentId: assignment.id }
    const assignmentRevision = assignment.revision
    assignment = await saved<{ id: string; revision: number }>(await post(assignmentAction.PATCH, { ...employeeInput, inputs: { allowance: '620' }, expectedRevision: assignmentRevision, reason: 'Employee draft refinement' }, employeeParams, null, 'PATCH'))
    await refusal(await post(assignmentAction.PATCH, { ...employeeInput, inputs: { allowance: '310' }, expectedRevision: assignmentRevision, reason: 'Stale employee editor' }, employeeParams, null, 'PATCH'), 422, /revision changed.*reload/i)
    const proposed = await saved<{ revision: number }>(await post(assignmentAction.POST, { expectedRevision: assignment.revision, action: 'submit', reason: 'Employee proposal review' }, employeeParams))
    state.actorId = f.approverId
    const active = await saved<{ status: string }>(await post(assignmentDecision.POST, { expectedRevision: proposed.revision, action: 'approve', reason: 'Independent employee terms review' }, employeeParams))
    assert.equal(active.status, 'active')
  }, { bypass: true })
})
