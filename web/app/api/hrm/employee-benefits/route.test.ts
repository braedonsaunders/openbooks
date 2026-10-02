import assert from 'node:assert/strict'
import test from 'node:test'
import { NextResponse } from 'next/server'
;(globalThis as typeof globalThis & { __benefitsNextResponse: typeof NextResponse }).__benefitsNextResponse = NextResponse
import { stubModules } from '../../../../testing/stub-modules'
const state = { allowed: true, feature: true, visible: true, calls: [] as string[] }
;(globalThis as typeof globalThis & { __employeeBenefits: typeof state }).__employeeBenefits = state
stubModules({ extra: {
  '@/lib/authz': `const s=globalThis.__employeeBenefits;export function can(){return false}export function guardSubsidiaryScope(){return s.visible ? null : Response.json({error:'not_found'},{status:404})}`,
  '@/lib/feature-gates': `const s=globalThis.__employeeBenefits;export async function guardFeaturePermission(permission,feature){if(permission!=='hrm.benefits.read'||feature!=='hrm')throw Error('wrong guard');if(!s.allowed||!s.feature)return globalThis.__benefitsNextResponse.json({error:'not_found'},{status:404});return {user:{orgId:'org-1',id:'actor-1'}}}`,
  '@/lib/features': `export async function isFeatureEnabled(){return true}`,
  '@openbooks/engine/platform/database': `const s=globalThis.__employeeBenefits;export async function withOrgTransaction(org,fn){if(org!=='org-1')throw Error('wrong organization');return fn()}export const db={execute:async()=>{s.calls.push('db');return {rows:s.calls.length===1?[{id:'employment-1',employer:'Employer',subsidiaryId:'employer-1'}]:[]}}}`,
  '@openbooks/engine/hrm/benefits': `const s=globalThis.__employeeBenefits;export async function listEnrollments(db,org,actor,filter){s.calls.push('list:'+filter.employmentId);if(org!=='org-1'||actor!=='actor-1')throw Error('wrong actor');return [{id:'enrollment-1'}]}`,
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
  Object.assign(state,{allowed:true,feature:true,visible:true,calls:[]}); const response=await request(); assert.equal(response.status,200); const body=await response.json(); assert.deepEqual(state.calls,['db','list:employment-1','db','db']); assert.equal(body.enrollments[0].record.id,'enrollment-1'); assert.equal(body.canManage,false); assert.equal(body.canReadBanks,false); assert.ok(!JSON.stringify(body).includes('sourceSnapshot'))
})
