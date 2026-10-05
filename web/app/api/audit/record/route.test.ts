import assert from 'node:assert/strict'
import { stubModules } from '../../../../testing/stub-modules'
import test from 'node:test'
import { NextRequest } from 'next/server'

// Record permissions are checked before existence, preventing identifier disclosure.
interface AuditState {
  recordExists: boolean
  permissions: string[]
  featureOn: boolean
  hiddenEmployer: boolean
  reads: number
}

const stateKey = Symbol.for('openbooks.audit-record-route-test')
const auditState: AuditState = { recordExists: true, permissions: [], featureOn: true, hiddenEmployer: false, reads: 0 }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = auditState

const EXISTING_ID = '00000000-0000-4000-8000-00000000a001'
const MISSING_ID = '00000000-0000-4000-8000-00000000a002'

const authzDouble = `const state=globalThis[Symbol.for('openbooks.audit-record-route-test')];export async function getAuthz(){return {user:{orgId:'org-1',id:'user-1'},allowedSubsidiaryIds:null,permissions:new Set(state.permissions)}}export function can(authz,perm){return authz.permissions.has('*')||authz.permissions.has(perm)}export function guardSubsidiaryScope(){return state.hiddenEmployer ? Response.json({error:'not_found'},{status:404}) : null}`
stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: `const s=globalThis[Symbol.for('openbooks.audit-record-route-test')];export async function isFeatureEnabled(){return s.featureOn}`,
  extra: {
    "server-only": "",
    "@openbooks/engine/src/platform/db.ts": `
      import { PgDialect } from ${JSON.stringify(import.meta.resolve('drizzle-orm/pg-core'))}
      export * from ${JSON.stringify(import.meta.resolve('@openbooks/engine/src/platform/db.ts'))}
      const state = globalThis[Symbol.for('openbooks.audit-record-route-test')]
      export const db = {
        async execute(query) {
          state.reads++; const text = new PgDialect().sqlToQuery(query).sql
          if (['payroll_compensation_packages','payroll_compensation_versions','payroll_compensation_assignments'].some(table=>text.includes('from '+table))) return state.recordExists ? {rows:[{kind:'compensation',created_at:new Date(),created_by:null,subsidiaryId:'employer-1'}]} : {rows:[]}
          if (['hrm_training_courses','hrm_training_sessions','hrm_training_participants'].some(table=>text.includes('from "'+table+'"'))) return state.recordExists ? {rows:[{kind:'training',created_at:new Date(),created_by:null,subsidiaryId:'employer-1'}]} : {rows:[]}
          if (text.includes('from documents')) {
            return state.recordExists
              ? { rows: [{ org_id: 'org-1', kind: 'vendor_bill', created_at: new Date(), created_by: null,
                           updated_at: new Date(), updated_by: null, subsidiaryId: null }] }
              : { rows: [] }
          }
          if (['hrm_benefit_programs','hrm_benefit_plans','entitlement_plans'].some(table=>text.includes('from '+table))) return state.recordExists ? { rows:[{kind:'benefit_program',created_at:new Date(),created_by:null,subsidiaryId:'employer-1'}] } : {rows:[]}
          if (text.includes('from hrm_benefit_enrollments')) return state.recordExists ? { rows: [{ kind: 'benefit_enrollment', created_at: new Date(), created_by: null, subsidiaryId: 'employer-1' }] } : { rows: [] }
          if (text.includes('count(*)')) return { rows: [{ n: 0 }] }
          return { rows: [] }
        },
      }
    `,
    "../../../../lib/authz": authzDouble,
    "@/lib/authz": authzDouble,
  },
})

const routeUrl = './route.ts?audit-record-route-test'
const { GET } = (await import(routeUrl)) as typeof import('./route.ts')

function get(table: string, id: string): Promise<Response> {
  return GET(new NextRequest(`http://openbooks.test/api/audit/record?table=${table}&id=${id}`))
}

test('a caller with no document permission learns nothing from an existing id', async () => {
  auditState.recordExists = true
  auditState.permissions = []
  const response = await get('documents', EXISTING_ID)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not_found' })
})

test('the same caller gets the identical answer for a missing id', async () => {
  auditState.recordExists = false
  auditState.permissions = []
  const response = await get('documents', MISSING_ID)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not_found' })
})

test('a caller with the wrong kind permission gets the uniform 404, not a 403', async () => {
  auditState.recordExists = true
  auditState.permissions = ['ar.read']
  const response = await get('documents', EXISTING_ID)
  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not_found' })
})

test('a caller with the kind permission still reads the record', async () => {
  auditState.recordExists = true
  auditState.permissions = ['ap.read']
  const response = await get('documents', EXISTING_ID)
  assert.equal(response.status, 200)
  const body = (await response.json()) as { recordType?: unknown }
  assert.equal(body.recordType, 'vendor_bill')
})

test('benefit audit refuses permission and disabled features before disclosing existence', async () => {
  for (const [permissions, featureOn] of [[[], true], [['hrm.benefits.read'], false]] as const) {
    for (const table of ['hrm_benefit_enrollments','hrm_benefit_programs','hrm_benefit_plans','entitlement_plans']) { Object.assign(auditState,{permissions:[...permissions],featureOn,reads:0}); assert.equal((await get(table,EXISTING_ID)).status,404,table); assert.equal(auditState.reads,0,table) }
  }
});
test('benefit audit fences every program family and permits scoped lifecycle evidence', async () => {
  for (const table of ['hrm_benefit_enrollments','hrm_benefit_programs','hrm_benefit_plans','entitlement_plans']) {
    Object.assign(auditState,{permissions:['hrm.benefits.read'],featureOn:true,recordExists:true,hiddenEmployer:true,reads:0}); assert.equal((await get(table,EXISTING_ID)).status,404,table); assert.equal(auditState.reads,1,table);
    auditState.hiddenEmployer=false; const response=await get(table,EXISTING_ID); assert.equal(response.status,200,table); assert.equal((await response.json()).recordType,table==='hrm_benefit_enrollments'?'benefit_enrollment':'benefit_program',table);
  }
});


test('compensation audit requires payroll read and the enabled feature before disclosing scoped records', async () => {
  for (const table of ['payroll_compensation_packages', 'payroll_compensation_versions', 'payroll_compensation_assignments']) {
    for (const fixture of [{ permissions: ['hrm.compensation.approve'], featureOn: true }, { permissions: ['payroll.read'], featureOn: false }]) {
      Object.assign(auditState, { ...fixture, recordExists: true, hiddenEmployer: false, reads: 0 })
      assert.equal((await get(table, EXISTING_ID)).status, 404, table)
      assert.equal(auditState.reads, 0, table)
    }
    Object.assign(auditState, { permissions: ['payroll.read'], featureOn: true, recordExists: true, hiddenEmployer: true, reads: 0 })
    assert.equal((await get(table, EXISTING_ID)).status, 404, table)
    Object.assign(auditState, { hiddenEmployer: false, reads: 0 })
    const response = await get(table, EXISTING_ID)
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json()
    assert.ok(Array.isArray(body.rows), table)
  }
})


test('training audit hides existence before permission and feature checks and fences the legal employer', async () => {
  for (const table of ['hrm_training_courses', 'hrm_training_sessions', 'hrm_training_participants']) {
    for (const recordExists of [false, true]) {
      for (const fixture of [{permissions: ['hrm.benefits.read'], featureOn: true}, {permissions: ['hrm.certifications.read'], featureOn: false}]) {
        Object.assign(auditState, {...fixture, recordExists, hiddenEmployer: false, reads: 0})
        assert.equal((await get(table, EXISTING_ID)).status, 404, table)
        assert.equal(auditState.reads, 0, table)
      }
    }
    Object.assign(auditState, {permissions: ['hrm.certifications.read'], featureOn: true, recordExists: true, hiddenEmployer: true, reads: 0})
    assert.equal((await get(table, EXISTING_ID)).status, 404, table)
    assert.equal(auditState.reads, 1, table)
    auditState.hiddenEmployer = false
    const response = await get(table, EXISTING_ID)
    assert.equal(response.status, 200, await response.clone().text())
    assert.ok(Array.isArray((await response.json()).rows), table)
  }
})
