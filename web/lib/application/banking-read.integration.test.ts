import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { after, before, test } from 'node:test'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg, seedFlowActors } from '@openbooks/engine/src/testing/fixtures.ts'
import type { ApplicationContext } from './context'
import { startReconciliation } from '@openbooks/engine/src/banking/banking.ts'
registerHooks({resolve(specifier,context,next){
  if(specifier === 'server-only')return {shortCircuit:true,url:'data:text/javascript,export {}'}
  return next(specifier,context)
}})
const {
  getApplicationReconciliation,
  listApplicationBankFeeds,
  listApplicationReconciliations,
  listApplicationUnmatchedBankLines,
} = await import('./banking')

const exactBalance = '999999999999999.9999'
const sealedCredential = 'SEALED_BANK_FEED_CREDENTIAL_SENTINEL'
let org: Awaited<ReturnType<typeof createScratchOrg>>
let actorId: string
let reconciliationId: string
let unmatchedLineId: string
let matchedLineId: string
let feedId: string

function context(permission: string): ApplicationContext {
  return {
    authz: {
      user: { id:actorId,email:'bank-reader@scratch.test',name:'Bank reader',orgId:org.orgId,roles:[],envKind:'sandbox',productionOrgId:org.orgId,isSuperAdmin:false,homeUserId:actorId,homeOrgId:org.orgId },
      permissions:new Set([permission]),allowedSubsidiaryIds:null,
    },
    source:'api',requestId:randomUUID(),apiKeyId:null,
  }
}

before(async () => {
  org = await withBypassContext(() => createScratchOrg())
  actorId = (await withBypassContext(() => seedFlowActors(org.orgId))).adminId
  const statementId = randomUUID()
  unmatchedLineId = randomUUID()
  matchedLineId = randomUUID()
  feedId = randomUUID()
  await withBypassContext(async () => {
    await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"banking":true,"bankFeeds":true}'::jsonb, true) where id = ${org.orgId}`)
    await db.execute(sql`update accounts set reconcilable = true, currency_restriction = 'CAD' where id = ${org.accounts.bank} and org_id = ${org.orgId}`)
    await db.execute(sql`insert into bank_statements(id,org_id,account_id,source,statement_date,closing_balance,raw_file_ref) values (${statementId},${org.orgId},${org.accounts.bank},'read-test','2026-07-31',${exactBalance},'read-test.raw')`)
    await db.execute(sql`
      insert into bank_statement_lines(id,org_id,statement_id,line_number,posted_on,amount,currency,description,match_status,account_id) values
        (${unmatchedLineId},${org.orgId},${statementId},1,'2026-07-15',${exactBalance},'CAD','Exact unmatched line','unmatched',${org.accounts.bank}),
        (${matchedLineId},${org.orgId},${statementId},2,'2026-07-16','10.0000','CAD','Already matched line','matched',${org.accounts.bank})
    `)
    await db.execute(sql`insert into bank_feed_connections(id,org_id,name,provider,account_id,status,credentials) values (${feedId},${org.orgId},'Credential redaction probe','manual',${org.accounts.bank},'connected',${sealedCredential})`)
  })
  reconciliationId = (await withOrgContext(org.orgId, () => startReconciliation(
    {accountId:org.accounts.bank,throughDate:'2026-07-31',statementBalance:exactBalance},
    {orgId:org.orgId,userId:actorId,allowedSubsidiaryIds:null},
  ))).id
})

after(async () => {
  if (org) await dropScratchOrg(org.orgId)
})

test('reconciliation application reads preserve exact balances from the shared engine', async () => {
  await withOrgContext(org.orgId, async () => {
    const listed = await listApplicationReconciliations(context('banking.read'),{})
    assert.equal(listed.reconciliations.length,1)
    assert.equal(listed.reconciliations[0]!.statementBalance,exactBalance)
    const detail = await getApplicationReconciliation(context('banking.read'),reconciliationId)
    assert.deepEqual([detail.statementBalance,detail.clearedBalance,detail.difference],[exactBalance,'0.0000',exactBalance])
  })
})

test('unmatched bank-line reads preserve decimal text and omit matched rows', async () => {
  await withOrgContext(org.orgId, async () => {
    const result = await listApplicationUnmatchedBankLines(context('banking.reconcile'),{})
    assert.equal(result.total,1)
    assert.deepEqual(result.lines.map((line) => [line.id,line.amount]),[[unmatchedLineId,exactBalance]])
    assert.equal(result.lines.some((line) => line.id === matchedLineId),false)
  })
})

test('bank-feed read exposes credential presence without returning the credential', async () => {
  await withOrgContext(org.orgId, async () => {
    const result = await listApplicationBankFeeds(context('admin.setup.manage'))
    const feed = result.connections.find((connection) => connection.id === feedId)
    assert.ok(feed)
    assert.equal(feed.hasCredentials,true)
    assert.equal(Object.hasOwn(feed,'credentials'),false)
    assert.equal(JSON.stringify(feed).includes(sealedCredential),false)
  })
})
