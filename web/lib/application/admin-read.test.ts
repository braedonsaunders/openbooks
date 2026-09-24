import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg, seedFlowActors } from '@openbooks/engine/src/testing/fixtures.ts'
import type { ApplicationContext } from './context'
import { ApplicationError } from './errors'
registerHooks({resolve(specifier,context,next){
  if(specifier === 'server-only')return {shortCircuit:true,url:'data:text/javascript,export {}'}
  return next(specifier,context)
}})
const { listApplicationAuditEvents, listApplicationUsers } = await import('./admin-read')

function context(orgId: string, permission: string, allowedSubsidiaryIds: Set<string> | null): ApplicationContext {
  return {
    authz: {user:{orgId} as ApplicationContext['authz']['user'],permissions:new Set([permission]),allowedSubsidiaryIds},
    source:'api',requestId:randomUUID(),apiKeyId:null,
  }
}

test('admin user results expose profile data but no stored credential material', async () => {
  const org = await createScratchOrg()
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId
    await withBypassContext(() => db.execute(sql`update users set password_hash = 'CREDENTIAL_SENTINEL' where id = ${actor} and org_id = ${org.orgId}`))
    await withOrgContext(org.orgId, async () => {
      const result = await listApplicationUsers(context(org.orgId,'admin.users.manage',null),{status:'all'})
      const user = result.users.find((row) => row.id === actor)
      assert.ok(user)
      assert.deepEqual(Object.keys(user).sort(), ['email','id','isActive','lastLoginAt','name','roles'])
      assert.equal(JSON.stringify(user).includes('CREDENTIAL_SENTINEL'),false)
      assert.equal(user.email, `u-${actor.slice(0,8)}@scratch.test`)
    })
  } finally { await dropScratchOrg(org.orgId) }
})

test('a subsidiary-restricted reader receives the organization-wide audit refusal', async () => {
  const org = await createScratchOrg()
  try {
    await withOrgContext(org.orgId, async () => {
      await assert.rejects(
        listApplicationAuditEvents(context(org.orgId,'admin.audit.read',new Set([org.subsidiaryId])),{}),
        (error: unknown) => error instanceof ApplicationError
          && error.code === 'forbidden'
          && error.status === 403
          && error.message === 'the audit log is organization-wide — ask an administrator with unrestricted subsidiary visibility to list it',
      )
    })
  } finally { await dropScratchOrg(org.orgId) }
})
