import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext, withOrgTransaction } from '../platform/db.ts'
import { fromUnits, toUnits } from '../money/money.ts'
import { postEntry } from '../journal/post-entry.ts'
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from '../testing/fixtures.ts'
import { setPeriodLockState } from '../periods/period-locks.ts'
import { importStatement, startReconciliation, createMatch, markReconciled, reconciliationStaleness } from './banking.ts'
import { previewSignOffRevalidation, revalidateReconciliationSignOff } from './reconciliation-revalidation.ts'

const enabled = {skip:!process.env.OPENBOOKS_DB_URL}
const reason = 'Independent review of neutral late history against the retained statement and sign-off'
async function fixture() {
  const org = await createScratchOrg()
  const signer = await createScratchUser(org.orgId,'Original reconciler','bank-sign-off')
  const reviewer = await createScratchUser(org.orgId,'Independent reconciler','bank-review')
  await withBypassContext(async()=>{
    assert.equal((await db.execute(sql`update app_roles set permissions='["banking.reconcile","gl.post"]'::jsonb
      where org_id=${org.orgId} and key in ('bank-sign-off','bank-review') returning id`)).rows.length,2)
    assert.equal((await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
      coalesce(settings->'features','{}'::jsonb)||'{"banking":true}'::jsonb)
      where id=${org.orgId} returning id`)).rows.length,1)
    assert.equal((await db.execute(sql`update accounts set reconcilable=true,currency_restriction='CAD',
      subsidiary_id=${org.subsidiaryId} where org_id=${org.orgId} and id=${org.accounts.bank} returning id`)).rows.length,1)
  })
  const ctx = (userId=reviewer)=>({orgId:org.orgId,userId,allowedSubsidiaryIds:null})
  const inOrg = <T>(fn:()=>Promise<T>)=>withOrgContext(org.orgId,fn)
  const post = async (amount:string,date=org.date)=>inOrg(async()=>{
    const result = await postEntry(db,{orgId:org.orgId,bookId:org.bookId,subsidiaryId:org.subsidiaryId,
      periodId:org.periodId,postingDate:date,entryNumber:`REV-${randomUUID()}`,origin:'manual',actorId:signer,currency:'CAD',
      lines:[{accountId:org.accounts.bank,amount,txnAmount:amount,fxRate:'1'},
        {accountId:org.accounts.adjustment,amount:fromUnits(-toUnits(amount)),txnAmount:fromUnits(-toUnits(amount)),fxRate:'1'}]})
    const row=(await db.execute<{id:string}>(sql`select id from journal_lines where org_id=${org.orgId}
      and entry_id=${result.entryId} and account_id=${org.accounts.bank}`)).rows[0]
    assert.ok(row)
    return row.id
  })
  const signed = async (date:string,amount:string,balance:string)=>{
    const line = await post(amount,date)
    return inOrg(async()=>{
      const transaction = randomUUID()
      const content=`date,amount,description,bank_transaction_id\n${date},${amount},Deposit,${transaction}\n`
      const imported=await importStatement({accountId:org.accounts.bank,source:'csv',statementDate:date,currency:'CAD',
        lines:[{postedOn:date,amount,description:'Deposit',bankTransactionId:transaction}],
        sourceEvidence:{content,filename:'bank.csv',contentType:'text/csv',
          csvMapping:{date:0,amount:1,description:2,bankTransactionId:3}}},ctx(signer))
      const statement=(await db.execute<{id:string}>(sql`select id from bank_statement_lines
        where org_id=${org.orgId} and statement_id=${imported.statementId}`)).rows[0]
      assert.ok(statement)
      const recon=await startReconciliation({accountId:org.accounts.bank,throughDate:date,statementBalance:balance},ctx(signer))
      await createMatch({reconciliationId:recon.id,statementLineIds:[statement.id],journalLineIds:[line]},ctx(signer))
      await markReconciled(recon.id,ctx(signer))
      return recon.id
    })
  }
  const snapshot=()=>inOrg(async()=>({
    sessions:(await db.execute(sql`select to_jsonb(r)::text as value from reconciliations r where org_id=${org.orgId} order by id`)).rows,
    matches:(await db.execute(sql`select to_jsonb(m)::text as value from reconciliation_matches m where org_id=${org.orgId} order by id`)).rows,
    statements:(await db.execute(sql`select to_jsonb(l)::text as value from bank_statement_lines l where org_id=${org.orgId} order by id`)).rows,
    lines:(await db.execute(sql`select to_jsonb(l)::text as value from journal_lines l where org_id=${org.orgId} order by id`)).rows,
  }))
  const auditCount=()=>inOrg(async()=>(await db.execute<{count:number}>(sql`select count(*)::int as count from audit_log
    where org_id=${org.orgId} and table_name='reconciliations' and changes->>'operation'='revalidate_sign_off'`)).rows[0]!.count)
  const close=()=>dropScratchOrgReporting(org.orgId)
  return {org,signer,reviewer,ctx,inOrg,post,signed,snapshot,auditCount,close}
}

test('neutral late history is independently reviewed once without changing signed evidence, and later sign-offs inherit only identical current proof',enabled,async()=>{
  const f=await fixture()
  try {
    const first=await f.signed(f.org.date,'250.00','250.00')
    const next=new Date(f.org.date+'T00:00:00Z');next.setUTCDate(next.getUTCDate()+1)
    const later=await f.signed(next.toISOString().slice(0,10),'100.00','350.00')
    await f.post('10.00');await f.post('-10.00')
    const before=await f.snapshot()
    assert.equal((await f.inOrg(()=>reconciliationStaleness(first,f.ctx()))).stale,true)
    assert.equal((await f.inOrg(()=>reconciliationStaleness(later,f.ctx()))).stale,true)
    const preview=await f.inOrg(()=>previewSignOffRevalidation(first,f.ctx()))
    assert.equal(preview.proof.lateEffect,'0.0000')
    assert.equal(preview.proof.lateEntries,2)
    const results=await Promise.all([1,2].map(()=>f.inOrg(()=>revalidateReconciliationSignOff(first,
      {expectedDigest:preview.proof.digest,reason},f.ctx()))))
    assert.equal(results.filter(result=>result.replayed).length,1)
    assert.equal(await f.auditCount(),1)
    assert.deepEqual(await f.snapshot(),before,'review preserves all original statements, matches, stamps and sign-offs')
    const own=await f.inOrg(()=>reconciliationStaleness(first,f.ctx()))
    const inherited=await f.inOrg(()=>reconciliationStaleness(later,f.ctx()))
    assert.equal(own.stale,false);assert.equal(own.revalidation?.inherited,false)
    assert.equal(inherited.stale,false);assert.equal(inherited.revalidation?.inherited,true)
    assert.equal(inherited.revalidation?.reviewedReconciliationId,first)
    assert.equal(inherited.lateEntries.length,2,'reviewed late lines remain visible and uncleared')
    await f.post('1.00')
    assert.equal((await f.inOrg(()=>reconciliationStaleness(first,f.ctx()))).stale,true)
    assert.equal((await f.inOrg(()=>reconciliationStaleness(later,f.ctx()))).stale,true)
    assert.equal(await f.auditCount(),1)
  }finally{await f.close()}
})

test('review requires current evidence, independent live authority, requested scope and an open Banking period; caught rollback records no certificate',enabled,async()=>{
  const f=await fixture()
  try {
    const id=await f.signed(f.org.date,'250.00','250.00');await f.post('5.00');await f.post('-5.00')
    const before=await f.snapshot()
    const preview=await f.inOrg(()=>previewSignOffRevalidation(id,f.ctx()))
    await assert.rejects(f.inOrg(()=>previewSignOffRevalidation(id,f.ctx(f.signer))),/Another authorized/)
    await assert.rejects(f.inOrg(()=>previewSignOffRevalidation(id,{...f.ctx(),allowedSubsidiaryIds:new Set([randomUUID()])})))
    await assert.rejects(f.inOrg(()=>revalidateReconciliationSignOff(id,{expectedDigest:'0'.repeat(64),reason},f.ctx())),/evidence changed/)
    await f.inOrg(()=>setPeriodLockState({orgId:f.org.orgId,periodId:f.org.periodId,bookId:f.org.bookId,
      module:'banking',state:'soft_closed',actorId:f.signer,reason:'Independent close before revalidation'}))
    await assert.rejects(f.inOrg(()=>revalidateReconciliationSignOff(id,{expectedDigest:preview.proof.digest,reason},f.ctx())),/Banking is closed/)
    await f.inOrg(()=>setPeriodLockState({orgId:f.org.orgId,periodId:f.org.periodId,bookId:f.org.bookId,
      module:'banking',state:'open',actorId:f.signer,reason:'Controlled test review window'}))
    await withBypassContext(()=>db.execute(sql`update app_roles set permissions='[]'::jsonb
      where org_id=${f.org.orgId} and key='bank-review'`))
    await assert.rejects(f.inOrg(()=>revalidateReconciliationSignOff(id,{expectedDigest:preview.proof.digest,reason},f.ctx())))
    await withBypassContext(()=>db.execute(sql`update app_roles set permissions='["banking.reconcile"]'::jsonb
      where org_id=${f.org.orgId} and key='bank-review'`))
    await assert.rejects(f.inOrg(()=>withOrgTransaction(f.org.orgId,async()=>{
      await revalidateReconciliationSignOff(id,{expectedDigest:preview.proof.digest,reason},f.ctx())
      throw new Error('Caller rolls back the review')
    })),/Caller rolls back/)
    await withBypassContext(()=>db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,banking}','false'::jsonb)
      where id=${f.org.orgId}`))
    await assert.rejects(f.inOrg(()=>revalidateReconciliationSignOff(id,{expectedDigest:preview.proof.digest,reason},f.ctx())))
    assert.equal(await f.auditCount(),0)
    assert.deepEqual(await f.snapshot(),before)
  }finally{await f.close()}
})


test('a balance-changing late posting refuses neutral review without changing any signed evidence',enabled,async()=>{
  const f=await fixture()
  try {
    const id=await f.signed(f.org.date,'250.00','250.00')
    await f.post('0.01')
    const before=await f.snapshot()
    await assert.rejects(f.inOrg(()=>previewSignOffRevalidation(id,f.ctx())),/Late postings change the balance/)
    assert.equal(await f.auditCount(),0)
    assert.deepEqual(await f.snapshot(),before)
  }finally{await f.close()}
})
