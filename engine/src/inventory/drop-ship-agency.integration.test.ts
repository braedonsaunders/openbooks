import assert from 'node:assert/strict'
import test from 'node:test'
import { requestDocumentVoid } from '../ledger/document-void.ts'
import { draftDocument } from '../conformance/ledger-helpers.ts'
import { sql } from 'drizzle-orm'
import { db,withBypassContext,withOrgContext } from '../platform/db.ts'
import { createConformanceOrg } from '../conformance/roles.ts'
import { REVENUE_CASES } from '../conformance/cases/revenue.ts'
import { applyDropShipAssessment,proposeDropShipAssessment } from './drop-ship-agency.ts'
import { postDocument } from '../ledger/posting-document.ts'
import { deps } from '../conformance/ledger-helpers.ts'

test('approved agency judgments preserve native AR and AP while reporting only the arranging fee and no inventory or COGS',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await withBypassContext(()=>createConformanceOrg()),ledger=org.ledger,ctx={roles:org.roles,ledger}
  try {
    await REVENUE_CASES.find(c=>c.id==='rev-drop-ship-agent-net')!.run!(ctx)
    await withOrgContext(ledger.orgId,async()=>{
      const balances=(await db.execute<{account_id:string;amount:string}>(sql`select line.account_id,sum(line.amount)::text as amount from journal_lines line join journal_entries entry on entry.org_id=line.org_id and entry.id=line.entry_id where line.org_id=${ledger.orgId} and entry.status in ('posted','reversed') group by line.account_id`)).rows
      const amount=(id:string)=>balances.find(row=>row.account_id===id)?.amount ?? '0.0000'
      assert.equal(amount(org.roles.revenue),'-20.0000');assert.equal(amount(org.roles.cogs),'0.0000');assert.equal(amount(org.roles.vendorPassThrough),'0.0000')
      assert.equal(amount(org.roles.ar),'100.0000');assert.equal(amount(org.roles.ap),'-80.0000')
      assert.equal((await db.execute(sql`select 1 from inventory_movements where org_id=${ledger.orgId}`)).rows.length,0)
      const change=(await db.execute<{id:string;submitted_by:string;subject_id:string}>(sql`select id,submitted_by,subject_id from financial_changes where org_id=${ledger.orgId} and domain='sales' and status='applied'`)).rows[0]!
      assert.equal((await applyDropShipAssessment(ledger.orgId,change.id,change.submitted_by)).presentation,'agent_net')
      const invoice=(await db.execute<{id:string}>(sql`select id from documents where org_id=${ledger.orgId} and document_number='CONF-AGENT-INVOICE'`)).rows[0]!
      await assert.rejects(postDocument(invoice.id,deps(ctx)),/already posted/)
      assert.equal((await db.execute(sql`select 1 from drop_ship_agent_allocations where org_id=${ledger.orgId}`)).rows.length,2)
      await assert.rejects(proposeDropShipAssessment(ledger.orgId,change.submitted_by,{salesOrderLineId:change.subject_id,controlsBeforeTransfer:true,passThroughAccountId:null,
        controlEvidence:'A changed control judgment cannot reinterpret an already posted invoice or confirmed shipment.',effectiveOn:ledger.date,reason:'Change the contractual control judgment after billing',idempotencyKey:'changed-after-billing'}),/before approving an invoice/)
      await requestDocumentVoid({orgId:ledger.orgId,documentId:invoice.id,actorId:ledger.actorId,reason:'Replace the full invoice with partial deliveries',reversalDate:ledger.date,allowedSubsidiaryIds:null})
      assert.equal((await db.execute<{status:string}>(sql`select status from documents where org_id=${ledger.orgId} and id=${invoice.id}`)).rows[0]!.status,'voided')
      const order=(await db.execute<{id:string}>(sql`select document_id as id from document_lines where org_id=${ledger.orgId} and id=${change.subject_id}`)).rows[0]!
      const partials:string[]=[]
      for(const [quantity,amount,expectedVendor] of [['0.33333333','33.3333','26.6666'],['0.66666667','66.6667','53.3334']] as const) {
        const partial=await draftDocument(ledger,{kind:'customer_invoice',number:'AGENT-PARTIAL-'+quantity,partyId:ledger.customerId,lines:[{itemId:ledger.items.standard,accountId:org.roles.revenue,quantity,unitPrice:'100',amount,stockLocationId:ledger.stockLocationId}]})
        await db.execute(sql`update document_lines set unit='ea',custom=${JSON.stringify({convertedFrom:{documentId:order.id,lineId:change.subject_id,quantity}})}::jsonb where org_id=${ledger.orgId} and document_id=${partial}`)
        await db.execute(sql`insert into document_links(org_id,from_document_id,to_document_id,link_type,created_by,updated_by) values(${ledger.orgId},${order.id},${partial},'bills',${ledger.actorId},${ledger.actorId})`)
        assert.equal((await db.execute(sql`update documents set status='draft' where org_id=${ledger.orgId} and id=${order.id} and status='approved' returning id`)).rows.length,1)
        assert.equal((await db.execute(sql`update document_lines set quantity_billed=quantity_billed+${quantity}::numeric where org_id=${ledger.orgId} and id=${change.subject_id} returning id`)).rows.length,1)
        assert.equal((await db.execute(sql`update documents set status='approved' where org_id=${ledger.orgId} and id=${order.id} and status='draft' returning id`)).rows.length,1)
        partials.push(partial)
        assert.equal((await db.execute(sql`update documents set status='approved' where org_id=${ledger.orgId} and id=${partial} and status='draft' returning id`)).rows.length,1)
        await postDocument(partial,deps(ctx))
        assert.equal((await db.execute<{amount:string}>(sql`select vendor_amount::text as amount from drop_ship_agent_allocations where org_id=${ledger.orgId} and document_id=${partial}`)).rows[0]!.amount,expectedVendor)
      }
      const corrected=(await db.execute<{amount:string}>(sql`select sum(line.amount)::text as amount from journal_lines line join journal_entries entry on entry.org_id=line.org_id and entry.id=line.entry_id where line.org_id=${ledger.orgId} and line.account_id=${org.roles.revenue} and entry.status in ('posted','reversed')`)).rows[0]!.amount
      assert.equal(corrected,'-20.0000')
      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,dropShipping}','false'::jsonb) where id=${ledger.orgId}`)
      await assert.rejects(applyDropShipAssessment(ledger.orgId,change.id,change.submitted_by),/Company Settings/)
      const receipt=(await db.execute<{id:string}>(sql`select id from documents where org_id=${ledger.orgId} and document_number='CONF-AGENT-RECEIPT'`)).rows[0]!
      await assert.rejects(requestDocumentVoid({orgId:ledger.orgId,documentId:receipt.id,actorId:ledger.actorId,reason:'Cancel a shipment with posted agency invoices',reversalDate:ledger.date,allowedSubsidiaryIds:null}),/posted agency customer invoices/)
      for(const partial of partials)await requestDocumentVoid({orgId:ledger.orgId,documentId:partial,actorId:ledger.actorId,reason:'Correct agency invoices before cancelling shipment',reversalDate:ledger.date,allowedSubsidiaryIds:null})
      const bill=(await db.execute<{id:string}>(sql`select id from documents where org_id=${ledger.orgId} and document_number='CONF-AGENT-BILL'`)).rows[0]!
      await requestDocumentVoid({orgId:ledger.orgId,documentId:bill.id,actorId:ledger.actorId,reason:'Correct the billed vendor entitlement before cancelling shipment',reversalDate:ledger.date,allowedSubsidiaryIds:null})
      await requestDocumentVoid({orgId:ledger.orgId,documentId:receipt.id,actorId:ledger.actorId,reason:'Cancel the vendor shipment and its paired confirmation',reversalDate:ledger.date,allowedSubsidiaryIds:null})
      const pair=(await db.execute<{status:string}>(sql`select status from documents where org_id=${ledger.orgId} and document_number in ('CONF-AGENT-RECEIPT','CONF-AGENT-FULFILLMENT')`)).rows
      assert.equal(pair.length,2);assert.ok(pair.every(document=>document.status==='voided'))

      await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features,dropShipping}','true'::jsonb) where id=${ledger.orgId}`)
      await db.execute(sql`update user_permission_overrides set effect='deny' where org_id=${ledger.orgId} and user_id=${change.submitted_by} and permission='ar.post'`)
      await assert.rejects(applyDropShipAssessment(ledger.orgId,change.id,change.submitted_by),error=>error instanceof Error && /not found/i.test(error.message))
    })
  }finally{await org.drop()}
})
