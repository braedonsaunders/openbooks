import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { registerHooks } from 'node:module'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { stubModules } from '../../../../testing/stub-modules'
import { db, withBypassContext } from '@openbooks/engine/platform/database'
import { createScratchOrg, createScratchUser, dropScratchOrg } from '@openbooks/engine/src/testing/fixtures.ts'
import { setFeatures } from '@openbooks/engine/src/testing/hrm-harness.ts'
import { seedPayrollComponents } from '@openbooks/engine/src/payroll/run-setup.ts'
import { seedOntarioEhtFixture } from '@openbooks/engine/src/payroll/filing-test-fixtures.ts'
import { calculatePayRun } from '@openbooks/engine/src/payroll/run-calculation.ts'
import { createPayRun } from '@openbooks/engine/src/payroll/run-lifecycle.ts'
import {
  seedPayrollSchedule, seedPayrollEmployeeRole, seedPayrollPerson, seedPayrollTime,
  seedPayrollProfile, seedPayrollWage, seedWorkerEmployment,
} from '@openbooks/engine/src/testing/fixtures.ts'

/**
 * POST employee-components — the assignment write path the Payroll tab drives:
 * a save persists exactly one effective-dated row with audit evidence, an
 * overlapping save refuses, a statutory component refuses, and a row that
 * already priced a stub can be ended but never deleted. Authz is stubbed;
 * the database, the payroll service validation, and the run calculation
 * are real.
 */

const stateKey = Symbol.for('openbooks.payroll-employee-components-route')
const state = {
  authz: null as null | {
    user: { orgId: string; id: string }
    permissions: Set<string>
    allowedSubsidiaryIds: ReadonlySet<string> | null
  },
  forbidden: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state
const authzSource = `
  const state = globalThis[Symbol.for('openbooks.payroll-employee-components-route')]
  export async function guardPermission(permission) {
    if (!state.authz?.permissions.has(permission)) return state.forbidden
    return state.authz
  }
  export async function getAuthz() { return state.authz }
  export function guardSubsidiaryScope() { return null }
  export function guardUnrestrictedScope() { return null }
  export function subsidiaryScopeAllows() { return true }
  export function subsidiariesInScope() { return true }
  export function can(authz, perm) { return authz?.permissions?.has(perm) ?? false }
`
stubModules({ authz: { source: authzSource } })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './authz' && context.parentURL?.endsWith('/web/lib/feature-gates.ts')) {
      return { url: 'openbooks:test:employee-components-authz', shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    return url === 'openbooks:test:employee-components-authz'
      ? { format: 'module', source: authzSource, shortCircuit: true }
      : next(url, context)
  },
})
const routeReady = import('./route')
const DB = Boolean(process.env.OPENBOOKS_DB_URL)

function request(method: string, body?: unknown, employee?: string) {
  return new Request(`http://localhost/api/payroll/employee-components${employee ? `?employee=${employee}` : ''}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function post(body: unknown) {
  const { POST } = await routeReady
  const response = await POST(request('POST', body) as never, { params: Promise.resolve({}) } as never)
  const parsed = (await response.json()) as { error?: string; ok?: boolean; id?: string }
  return { status: response.status, body: parsed }
}

async function get(employee: string) {
  const { GET } = await routeReady
  const response = await GET(request('GET', undefined, employee) as never, { params: Promise.resolve({}) } as never)
  return { status: response.status, body: (await response.json()) as { assignments: { id: string }[]; components: unknown[]; employments: unknown[] } }
}

test('save lists, overlaps refuse, and consumed rows end but never delete', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(() => setFeatures(org.orgId, { payroll: true }))
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, 'Payroll manager', 'payroll_manager'))
    state.authz = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(['payroll.manage']), allowedSubsidiaryIds: null }
    await withBypassContext(() => seedPayrollComponents(org.orgId, actorId, 'CA'))
    await withBypassContext(() => seedOntarioEhtFixture(org.orgId, actorId))
    const partyId = randomUUID()
    await withBypassContext(async () => {
      await seedPayrollPerson(org.orgId, partyId, 'Route Assignment Employee')
      await seedPayrollEmployeeRole(org.orgId, partyId, { id: randomUUID(), workerCompGroupId: null, terminatedOn: null })
      await seedPayrollWage(org.orgId, partyId, actorId, { currency: 'CAD', rate: '30', basis: 'hour', annualHours: '2080', effectiveFrom: '2026-01-01' })
    })
    const employmentId = await withBypassContext(() => seedWorkerEmployment(org.orgId, partyId, org.subsidiaryId))
    const scheduleId = randomUUID()
    await withBypassContext(async () => {
      await seedPayrollSchedule(org.orgId, scheduleId, actorId, { name: 'Weekly', frequency: 'weekly', periodsPerYear: 52, anchorPeriodEnd: '2026-07-18', payDateOffsetDays: 3 })
      await seedPayrollProfile(org.orgId, partyId, employmentId, scheduleId, actorId,
        { country: 'CA', province: 'ON', payBasis: 'hourly', federalClaimCode: 1, provincialClaimCode: 1 },
        { percentFloor: '4', method: 'accrue' })
    })
    const componentId = randomUUID()
    await withBypassContext(() => db.execute(sql`insert into pay_components(id,org_id,code,name,kind,country,taxable,pensionable,insurable,vacationable,
      tax_treatment,payment_kind,basis,value) values(${componentId},${org.orgId},'ROUTECOMP','Route component','deduction','CA',true,true,true,false,'none','cash','fixed_amount','25')`))

    const saved = await post({
      action: 'save-assignment', employeePartyId: partyId, employmentId, componentId,
      value: '25.00', effectiveFrom: '2026-01-01', effectiveTo: null,
    })
    assert.equal(saved.status, 200)
    assert.ok(saved.body.id)
    const listed = await get(partyId)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.assignments.length, 1)

    const overlap = await post({
      action: 'save-assignment', employeePartyId: partyId, employmentId, componentId,
      value: '30', effectiveFrom: '2026-06-01', effectiveTo: null,
    })
    assert.equal(overlap.status, 422)
    assert.match(overlap.body.error ?? '', /already holds ROUTECOMP/)

    // The API-written row prices on a real run, so deleting it afterwards
    // must refuse while ending it stays available.
    await withBypassContext(async () => {
      for (const day of ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17']) {
        await seedPayrollTime(org.orgId, partyId, actorId, {
          workedOn: day, hours: '8', projectId: null, status: 'approved', isBillable: false,
          billingStatus: 'unbilled', costingBasis: 'actual',
        })
      }
    })
    const run = await withBypassContext(() => createPayRun({ orgId: org.orgId, actorId, payScheduleId: scheduleId, periodStart: '2026-07-12', periodEnd: '2026-07-18' }))
    assert.deepEqual((await withBypassContext(() => calculatePayRun({ orgId: org.orgId, actorId, documentId: run.documentId }))).errors, [])
    const consumed = await post({ action: 'delete-assignment', id: saved.body.id })
    assert.equal(consumed.status, 422)
    assert.match(consumed.body.error ?? '', /already priced a pay stub — end the assignment instead/)
    const ended = await post({ action: 'end-assignment', id: saved.body.id, effectiveTo: '2026-12-31' })
    assert.equal(ended.status, 200)
    const audit = await withBypassContext(() => db.execute<{ action: string }>(sql`select action from audit_log
      where org_id = ${org.orgId} and table_name = 'employee_pay_components' and row_id = ${saved.body.id} order by at`))
    assert.deepEqual(audit.rows.map((row) => row.action), ['insert', 'update'])
  } finally {
    state.authz = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('a statutory component refuses with its remedy', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    await withBypassContext(() => setFeatures(org.orgId, { payroll: true }))
    const actorId = await withBypassContext(() => createScratchUser(org.orgId, 'Payroll manager', 'payroll_manager'))
    state.authz = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(['payroll.manage']), allowedSubsidiaryIds: null }
    await withBypassContext(() => seedPayrollComponents(org.orgId, actorId, 'CA'))
    const partyId = randomUUID()
    await withBypassContext(async () => {
      await seedPayrollPerson(org.orgId, partyId, 'Statutory Refusal Employee')
      await seedPayrollEmployeeRole(org.orgId, partyId, { id: randomUUID(), workerCompGroupId: null, terminatedOn: null })
    })
    const employmentId = await withBypassContext(() => seedWorkerEmployment(org.orgId, partyId, org.subsidiaryId))
    const statutory = await withBypassContext(() => db.execute<{ id: string }>(sql`select id from pay_components
      where org_id = ${org.orgId} and system_key is not null and kind = 'deduction' limit 1`))
    const refused = await post({
      action: 'save-assignment', employeePartyId: partyId, employmentId, componentId: statutory.rows[0]!.id,
      value: '5', effectiveFrom: '2026-01-01', effectiveTo: null,
    })
    assert.equal(refused.status, 422)
    assert.match(refused.body.error ?? '', /is statutory.*assign a user-defined component instead/)
  } finally {
    state.authz = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
