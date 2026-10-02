import assert from 'node:assert/strict'
import test from 'node:test'
import { NextResponse } from 'next/server'
;(globalThis as typeof globalThis & { __benefitsNextResponse: typeof NextResponse }).__benefitsNextResponse = NextResponse
import { stubModules } from '../../../../testing/stub-modules'
const state = { allowed: true, feature: true, visible: true, catalogVisible: true, calls: [] as string[] }
;(globalThis as typeof globalThis & { __employeeBenefits: typeof state }).__employeeBenefits = state
stubModules({ intl: `export async function getTranslations(){return Object.assign(key=>key,{has:()=>true})}`, extra: {
  'server-only': ``,
  '@/lib/authz': `const s=globalThis.__employeeBenefits;export function can(){return false}export function guardSubsidiaryScope(){return s.visible ? null : Response.json({error:'not_found'},{status:404})}`,
  '@/lib/feature-gates': `const s=globalThis.__employeeBenefits;export async function guardFeaturePermission(permission,feature){if(permission!=='hrm.benefits.read'||feature!=='hrm')throw Error('wrong guard');if(!s.allowed||!s.feature)return globalThis.__benefitsNextResponse.json({error:'not_found'},{status:404});return {user:{orgId:'org-1',id:'actor-1'}}}`,
  '@/lib/features': `export async function isFeatureEnabled(){return true}`,
  '@openbooks/engine/platform/database': `const s=globalThis.__employeeBenefits;export async function withOrgTransaction(org,fn,options){if(options.isolationLevel!=='REPEATABLE READ'||options.readOnly!==true)throw Error('missing read snapshot');if(org!=='org-1')throw Error('wrong organization');return fn()}export const db={execute:async()=>{s.calls.push('db');return {rows:s.calls.length===1?[{id:'employment-1',employer:'Employer',subsidiaryId:'employer-1'}]:[]}}}`,
  '@openbooks/engine/hrm/benefits': `const s=globalThis.__employeeBenefits;export async function listBenefitsProgramCatalog(db,org,actor){s.calls.push('catalog');if(org!=='org-1'||actor!=='actor-1')throw Error('wrong scope');return s.catalogVisible?[{id:'program-1',name:'RRSP',type:'retirement'}]:[]}export async function listBenefitsProgramParticipants(db,org,actor,filter){s.calls.push('participants');if(filter.employeePartyId!=='00000000-0000-4000-8000-000000000001')throw Error('wrong employee');return [{id:'enrollment-1',programId:'program-1',nativeKind:'enrollment',employmentId:'employment-1',employeePartyId:filter.employeePartyId,employeeName:'Employee',status:'active',effectiveFrom:'2026-01-01',effectiveTo:null}]}export async function listEnrollments(db,org,actor,filter){s.calls.push('list:'+filter.employmentId);if(org!=='org-1'||actor!=='actor-1')throw Error('wrong actor');return [{id:'enrollment-1'}]}`,
  '@/lib/hrm/benefit-enrollment-record': `export async function loadBenefitEnrollmentRecord(authz,row){return {record:{id:row.id},canChange:true}}`,
} })
const { GET } = await import('./route')
const request = () => GET(new Request('http://openbooks.test/api/hrm/employee-benefits?employee=00000000-0000-4000-8000-000000000001'))
test('employee benefits refuses absent permission and HR feature before reading employees', async () => {
  for (const [allowed, feature] of [[false,true],[true,false]]) { Object.assign(state,{allowed,feature,calls:[]}); assert.equal((await request()).status,404); assert.equal(state.calls.length,0) }
})
test('hidden legal employers disclose no benefit or policy records', async () => {
  Object.assign(state,{allowed:true,feature:true,visible:false,calls:[]}); assert.equal((await request()).status,404); assert.deepEqual(state.calls,['db'])
})
test('employee benefits reads only visible employments and exposes sanitized records with independent permissions', async () => {
  Object.assign(state,{allowed:true,feature:true,visible:true,calls:[]}); const response=await request(); assert.equal(response.status,200); const body=await response.json(); assert.deepEqual(state.calls,['db','catalog','participants','list:employment-1','db','db']); assert.equal(body.assignments[0].programId,'program-1'); assert.equal(body.assignments[0].employeePartyId,'00000000-0000-4000-8000-000000000001'); assert.equal(body.enrollments[0].record.id,'enrollment-1'); assert.equal(body.canManage,false); assert.equal(body.canReadBanks,false); assert.ok(!JSON.stringify(body).includes('sourceSnapshot'))
})

test('a program-scope mismatch returns its usable remedy instead of successful partial assignments', async () => {
  Object.assign(state,{allowed:true,feature:true,visible:true,catalogVisible:false,calls:[]})
  try {
    const response = await request()
    assert.equal(response.status,409)
    const body = await response.json()
    assert.match(body.error,/no accessible program.*legal-employer scope/)
    assert.equal(body.code,'PROGRAM_SCOPE_MISMATCH')
    assert.equal(body.assignments,undefined)
  } finally { state.catalogVisible=true }
})
