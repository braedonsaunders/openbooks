import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg, seedFlowActors } from '@openbooks/engine/src/testing/fixtures.ts'

registerHooks({resolve(specifier, context, next) {
  if (specifier === 'server-only') return {shortCircuit:true,url:'data:text/javascript,export {}'}
  if (specifier.startsWith('@/')) return {url:new URL(`${specifier.slice(2)}.ts`, new URL('../../', import.meta.url)).href,shortCircuit:true}
  return next(specifier,context)
}})
const { generateApiKey } = await import('../api-auth')
const {
  v1CreateAliasedRecord,
  v1DeleteAliasedRecord,
  v1GetAliasedRecord,
  v1ListAliasedRecords,
  v1UpdateAliasedRecord,
} = await import('./v1-records')

test('reserved v1 aliases refuse before list, body parsing, or item commands', async () => {
  const org = await createScratchOrg()
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId
    const generated = generateApiKey()
    await withBypassContext(async () => {
      await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"apiAccess":true}'::jsonb, true) where id = ${org.orgId}`)
      await db.execute(sql`
        insert into api_keys (org_id,user_id,name,key_prefix,key_hash,key_preview,scopes,is_active)
        values (${org.orgId},${actor},'reserved alias test',${generated.keyPrefix},${generated.keyHash},${generated.keyPreview},'["parties.read","parties.manage"]'::jsonb,true)
      `)
    })
    const request = (method: string, body?: string) => new Request('http://openbooks.test/api/v1/records', {
      method,
      headers: {
        authorization: `Bearer ${generated.plaintext}`,
        ...(body === undefined ? {} : {'content-type':'application/json'}),
      },
      ...(body === undefined ? {} : {body}),
    })
    const responses = await withOrgContext(org.orgId, async () => Promise.all([
      v1ListAliasedRecords(request('GET'), 'records'),
      v1CreateAliasedRecord(request('POST', '{broken'), 'records'),
      v1GetAliasedRecord(request('GET'), 'records', 'record-1'),
      v1UpdateAliasedRecord(request('PATCH', '{broken'), 'records', 'record-1'),
      v1DeleteAliasedRecord(request('DELETE'), 'records', 'record-1'),
    ]))

    for (const response of responses) {
      assert.equal(response.status, 404)
      assert.equal((await response.json() as {error:string}).error, 'not_found')
    }
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
