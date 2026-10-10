import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db,withBypassContext,withOrgContext } from '../platform/db.ts'
import { createConformanceOrg } from '../conformance/roles.ts'
import { draftDocument,deps } from '../conformance/ledger-helpers.ts'
import { seedFlowActors,seedApprovalFlow } from '../testing/fixtures.ts'
import { postDocument } from '../ledger/posting-document.ts'
import { submitFinancialChange } from '../flows/financial-changes-adapter.ts'
import { decideGate } from '../flows/gates.ts'
import { createPrepaidGrant,recordPrepaidDraw,reversePrepaidDraw } from '../billing/usage/prepaid.ts'
import { recordRecognitionEvent } from './recognition-events.ts'
import { runRevenueRecognition } from './recognition-run.ts'
import { proposeExpectedBreakage,applyExpectedBreakage,type BreakageProposal,prepaidRecognitionAdjustment } from './prepaid-breakage.ts'

test('approved breakage follows customer use and reversals through the native recognition ledger, never third-party revenue', {skip:!process.env.OPENBOOKS_DB_URL},async()=> {
  const org=await withBypassContext(()=>createConformanceOrg()),ledger=org.ledger,ctx={roles:org.roles,ledger}
  try {
    const actors=await withBypassContext(async()=> {
      const actors=await seedFlowActors(ledger.orgId)
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)||'{"subscriptionBilling":true,"usageBilling":true}'::jsonb) where id=${ledger.orgId}`)
      await db.execute(sql`update recognition_rules set method='usage' where org_id=${ledger.orgId}`)
      await db.execute(sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values (${ledger.orgId},${actors.submitterId},'ar.post','grant')`)
      await seedApprovalFlow(ledger.orgId,{subjectKind:'financial_change',assignees:[{type:'user',userId:actors.approver1Id}],mode:'any',preventSelfApproval:true})
      return actors
    })
    await withOrgContext(ledger.orgId,async()=> {
      const date=(await db.execute<{ends_on:string}>(sql`select ends_on::text from accounting_periods where org_id=${ledger.orgId} and id=${ledger.periodId}`)).rows[0]!.ends_on,month=date.slice(0,7)+'-01'
      const document=await draftDocument(ledger,{kind:'customer_invoice',number:'PREPAID-BREAKAGE',partyId:ledger.customerId,lines:[{itemId:ledger.items.service,accountId:org.roles.revenue,quantity:'1',unitPrice:'100',amount:'100'}]})
      await db.execute(sql`update documents set status='approved' where org_id=${ledger.orgId} and id=${document}`)
      await postDocument(document,deps(ctx))
      const source=(await db.execute<{id:string;obligation_id:string}>(sql`select line.id,obligation.id as obligation_id from document_lines line join performance_obligations obligation on obligation.org_id=line.org_id and obligation.document_line_id=line.id where line.org_id=${ledger.orgId} and line.document_id=${document}`)).rows[0]!
      const grant=await createPrepaidGrant(ledger.orgId,actors.submitterId,{customerId:ledger.customerId,sourceDocumentLineId:source.id,amount:'100',currency:'CAD'})
      await recordPrepaidDraw(ledger.orgId,{grantId:grant.id,periodMonth:month,amount:'60'})
      const usage=async(amount:string,key:string)=>recordRecognitionEvent({orgId:ledger.orgId,actorId:actors.submitterId,obligationId:source.obligation_id,periodMonth:month,amount,sourceReference:key})
      const recognize=async()=>{const result=await runRevenueRecognition(ledger.orgId,date,actors.submitterId,source.obligation_id);assert.deepEqual(result.problems,[]);return result.totalAmount}
      await usage('60','draw-60');assert.equal(await recognize(),'60.0000')
      const approve=async(id:string)=>{await submitFinancialChange(ledger.orgId,id,actors.submitterId);const gate=(await db.execute<{id:string}>(sql`select id from flow_gates where org_id=${ledger.orgId} and subject_id=${id} and status='pending'`)).rows[0]!;await decideGate({gateId:gate.id,userId:actors.approver1Id,decision:'approved'})}
      const input:BreakageProposal={grantId:grant.id,effectiveOn:date,reason:'Recognize the supported expected prepaid breakage',idempotencyKey:randomUUID(),estimate:{method:'expected_proportional',expectedBreakage:'20',entitled:true,meetsReversalConstraint:true,thirdPartyObligation:false,evidence:'Reviewed redemption history supports twenty of expected breakage and no significant reversal; legal review confirms entitlement and no unclaimed-property liability.'}}
      const id=await proposeExpectedBreakage(ledger.orgId,actors.submitterId,input)
      assert.equal(await proposeExpectedBreakage(ledger.orgId,actors.submitterId,input),id)
      await assert.rejects(applyExpectedBreakage(ledger.orgId,id,actors.submitterId),/approval policy/)
      const stale=await proposeExpectedBreakage(ledger.orgId,actors.submitterId,{...input,idempotencyKey:randomUUID()})
      await approve(id);await approve(stale)
      const result=await applyExpectedBreakage(ledger.orgId,id,actors.submitterId)
      assert.equal(result.target,'15.0000');assert.equal(result.currentAdjustment,'15.0000')
      assert.deepEqual(await applyExpectedBreakage(ledger.orgId,id,actors.submitterId),result)
      await assert.rejects(applyExpectedBreakage(ledger.orgId,stale,actors.submitterId),/changed after this proposal/)
      assert.equal(await recognize(),'15.0000')
      const draw=await recordPrepaidDraw(ledger.orgId,{grantId:grant.id,periodMonth:month,amount:'4'})
      await usage('4','draw-4');assert.equal(await recognize(),'5.0000')
      await reversePrepaidDraw(ledger.orgId,draw.id)
      await usage('-4','reverse-draw-4');assert.equal(await recognize(),'-5.0000')
      const escheat=await proposeExpectedBreakage(ledger.orgId,actors.submitterId,{...input,idempotencyKey:randomUUID(),estimate:{...input.estimate,thirdPartyObligation:true}})
      await approve(escheat);assert.equal((await applyExpectedBreakage(ledger.orgId,escheat,actors.submitterId)).target,'0.0000')
      assert.equal(await recognize(),'-15.0000')
      const balance=(await db.execute<{amount:string}>(sql`select sum(line.amount)::text as amount from journal_lines line join journal_entries entry on entry.org_id=line.org_id and entry.id=line.entry_id where line.org_id=${ledger.orgId} and line.account_id=${org.roles.deferredRevenue} and entry.status in ('posted','reversed')`)).rows[0]!.amount
      assert.equal(balance,'-40.0000')
      await assert.rejects(proposeExpectedBreakage(ledger.orgId,actors.submitterId,{...input,idempotencyKey:randomUUID(),estimate:{...input.estimate,expectedBreakage:'90'}}),/approve a revised breakage estimate/)
      const remote=await proposeExpectedBreakage(ledger.orgId,actors.submitterId,{...input,idempotencyKey:randomUUID(),estimate:{...input.estimate,method:'remaining_use_remote',expectedBreakage:'40',evidence:'The controller confirms that remaining customer use is remote and that the entity is legally entitled to all remaining rights without an unclaimed-property obligation.'}})
      await approve(remote);assert.equal((await applyExpectedBreakage(ledger.orgId,remote,actors.submitterId)).target,'40.0000')
      assert.equal(await recognize(),'40.0000')
      // A bundled invoice's billed credits and allocated transaction price
      // differ. Both ordinary usage and breakage must use the native allocation.
      const otherItem=randomUUID()
      await withBypassContext(async()=> {
        await db.execute(sql`update items set standalone_selling_price='40' where org_id=${ledger.orgId} and id=${ledger.items.service}`)
        await db.execute(sql`insert into items(id,org_id,kind,name,income_account_id,recognition_rule_id,deferred_account_id,standalone_selling_price)
          select ${otherItem},org_id,'service','Additional bundled promise',income_account_id,recognition_rule_id,deferred_account_id,'60' from items where org_id=${ledger.orgId} and id=${ledger.items.service}`)
      })
      const bundled=await draftDocument(ledger,{kind:'customer_invoice',number:'BUNDLED-CREDITS',partyId:ledger.customerId,lines:[
        {itemId:ledger.items.service,accountId:org.roles.revenue,quantity:'1',unitPrice:'100',amount:'100'},
        {itemId:otherItem,accountId:org.roles.revenue,quantity:'1',unitPrice:'100',amount:'100'},
      ]})
      await db.execute(sql`update documents set status='approved' where org_id=${ledger.orgId} and id=${bundled}`)
      await postDocument(bundled,deps(ctx))
      const promise=(await db.execute<{id:string;obligation_id:string;allocated_price:string}>(sql`select line.id,obligation.id as obligation_id,obligation.allocated_price::text from document_lines line join performance_obligations obligation on obligation.org_id=line.org_id and obligation.document_line_id=line.id where line.org_id=${ledger.orgId} and line.document_id=${bundled} and line.item_id=${ledger.items.service}`)).rows[0]!
      assert.equal(promise.allocated_price,'80.0000')
      const bundleGrant=await createPrepaidGrant(ledger.orgId,actors.submitterId,{customerId:ledger.customerId,sourceDocumentLineId:promise.id,amount:'100',currency:'CAD'})
      await recordPrepaidDraw(ledger.orgId,{grantId:bundleGrant.id,periodMonth:month,amount:'60'})
      const earned=await prepaidRecognitionAdjustment(ledger.orgId,bundleGrant.id)
      assert.equal(earned,'48.0000')
      await recordRecognitionEvent({orgId:ledger.orgId,actorId:actors.submitterId,obligationId:promise.obligation_id,periodMonth:month,amount:earned,sourceReference:`usage-run:bundle:grant:${bundleGrant.id}`})
      const bundleUsage=await runRevenueRecognition(ledger.orgId,date,actors.submitterId,promise.obligation_id)
      assert.deepEqual(bundleUsage.problems,[]);assert.equal(bundleUsage.totalAmount,'48.0000')
      const bundlePolicy=await proposeExpectedBreakage(ledger.orgId,actors.submitterId,{...input,grantId:bundleGrant.id,idempotencyKey:randomUUID()})
      await approve(bundlePolicy)
      assert.equal((await applyExpectedBreakage(ledger.orgId,bundlePolicy,actors.submitterId)).target,'12.0000')
      const bundleBreakage=await runRevenueRecognition(ledger.orgId,date,actors.submitterId,promise.obligation_id)
      assert.deepEqual(bundleBreakage.problems,[]);assert.equal(bundleBreakage.totalAmount,'12.0000')
      const unused=(await db.execute<{id:string;obligation_id:string}>(sql`select line.id,obligation.id as obligation_id from document_lines line join performance_obligations obligation on obligation.org_id=line.org_id and obligation.document_line_id=line.id where line.org_id=${ledger.orgId} and line.document_id=${bundled} and line.item_id=${otherItem}`)).rows[0]!
      const unusedGrant=await createPrepaidGrant(ledger.orgId,actors.submitterId,{customerId:ledger.customerId,sourceDocumentLineId:unused.id,amount:'100',currency:'CAD'})
      const unusedPolicy=await proposeExpectedBreakage(ledger.orgId,actors.submitterId,{...input,grantId:unusedGrant.id,idempotencyKey:randomUUID(),estimate:{...input.estimate,method:'remaining_use_remote',expectedBreakage:'100',evidence:'Further customer use of this unused grant is assessed as remote, and legal review confirms entitlement to its balance without an unclaimed-property obligation.'}})
      await approve(unusedPolicy)
      assert.equal((await applyExpectedBreakage(ledger.orgId,unusedPolicy,actors.submitterId)).target,'120.0000')
      const unusedRecognition=await runRevenueRecognition(ledger.orgId,date,actors.submitterId,unused.obligation_id)
      assert.deepEqual(unusedRecognition.problems,[]);assert.equal(unusedRecognition.totalAmount,'120.0000')


    })
  } finally {await org.drop()}
})
