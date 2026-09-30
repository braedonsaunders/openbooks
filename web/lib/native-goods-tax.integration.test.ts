import assert from 'node:assert/strict'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db,withBypassContext,withOrgContext } from '@openbooks/engine/src/platform/db.ts'
import { createConformanceOrg } from '@openbooks/engine/src/conformance/roles.ts'
import { draftDocument,deps } from '@openbooks/engine/src/conformance/ledger-helpers.ts'
import { provisionTaxPacks } from '@openbooks/engine/src/tax/pack-provisioning.ts'
import { computeTaxReturn } from '@openbooks/engine/src/tax-returns/return.ts'
import { loadDocumentEditCurrent,postDocument } from '@openbooks/engine/documents'
import { resolveCanadianGoodsTaxes } from '@openbooks/engine/tax'
import { applyDocumentEdit } from './documents.ts'

test('native invoice editing selects dated goods tax and preserves entity, manual precedence and immutable posting evidence',{skip:!process.env.OPENBOOKS_DB_URL},async()=>{
  const org=await withBypassContext(()=>createConformanceOrg()),ledger=org.ledger
  try {await withOrgContext(ledger.orgId,async()=>{
    await provisionTaxPacks(ledger.orgId,['JURISDICTION:CA-AB','JURISDICTION:CA-ON'],ledger.actorId)
    await db.execute(sql`update tax_codes set collected_account_id=${org.roles.taxPayable} where org_id=${ledger.orgId} and country='CA'`)
    const selection={basis:'ordinary_taxable_goods_sale',country:'CA',deliveryProvince:'AB',deliveryMethod:'supplier_arranged_shipping',agreementEvidence:'The ordinary fully taxable goods contract requires supplier-arranged delivery to Alberta.'}
    const options={kind:'customer_invoice',subsidiaryId:ledger.subsidiaryId,documentDate:ledger.date,currency:'CAD',selection}
    await assert.rejects(resolveCanadianGoodsTaxes(ledger.orgId,options,[{amount:'100'}]),/registration.*selling legal entity/)
    const registration=(await db.execute<{id:string}>(sql`update tax_registrations set subsidiary_id=${ledger.subsidiaryId},registration_number='123456789RT0001' where org_id=${ledger.orgId} and jurisdiction_id in(select id from tax_jurisdictions where org_id=${ledger.orgId} and code='CA') returning id`)).rows[0]!
    await assert.rejects(resolveCanadianGoodsTaxes(ledger.orgId,options,[{amount:'100',itemId:ledger.items.service}]),/not ordinary tangible goods/)
    const id=await draftDocument(ledger,{kind:'customer_invoice',number:'NATIVE-GOODS',partyId:ledger.customerId,lines:[{accountId:org.roles.revenue,quantity:'1',unitPrice:'100',amount:'100'}]})
    const lines=[{accountId:org.roles.revenue,quantity:'1',unitPrice:'100',amount:'100'}]
    const context={orgId:ledger.orgId,userId:ledger.actorId,source:'ui' as const,runFlows:false}
    async function edit(body:Parameters<typeof applyDocumentEdit>[2]) {const current=(await loadDocumentEditCurrent(id,ledger.orgId))!;await applyDocumentEdit(id,current,{...body,expectedUpdatedAt:current.updatedAt},context)}
    await edit({custom:{canadianGoodsTax:selection},lines})
    assert.equal((await db.execute<{tax_total:string}>(sql`select tax_total::text from documents where org_id=${ledger.orgId} and id=${id}`)).rows[0]!.tax_total,'5.0000')
    await assert.rejects(edit({custom:{canadianGoodsTax:{...selection,deliveryProvince:'ON'}}}),/Save the invoice lines/)
    await edit({custom:{canadianGoodsTax:{...selection,deliveryProvince:'ON'}},lines})
    assert.equal((await db.execute<{tax_total:string}>(sql`select tax_total::text from documents where org_id=${ledger.orgId} and id=${id}`)).rows[0]!.tax_total,'13.0000')
    await edit({lines:[{...lines[0]!,taxOverridden:true,taxAmount:'0'}]})
    assert.equal((await db.execute(sql`select 1 from document_goods_tax_snapshots where org_id=${ledger.orgId}`)).rows.length,0)
    await edit({lines})
    await db.execute(sql`update documents set status='approved' where org_id=${ledger.orgId} and id=${id}`)
    await postDocument(id,deps({roles:org.roles,ledger}))
    const posted=(await db.execute<{amount:string}>(sql`select sum(l.amount)::text as amount from journal_lines l join journal_entries e on e.org_id=l.org_id and e.id=l.entry_id where l.org_id=${ledger.orgId} and e.source_document_id=${id} and l.account_id=${org.roles.taxPayable}`)).rows[0]!
    assert.equal(posted.amount,'-13.0000')
    await assert.rejects(db.execute(sql`update tax_registrations set registration_number='999999999RT0001' where org_id=${ledger.orgId} and id=${registration.id}`),error=>{assert.match(String((error as Error & {cause?:Error}).cause?.message),/identity and coverage are immutable/);return true})
    await assert.rejects(db.execute(sql`delete from document_goods_tax_snapshots where org_id=${ledger.orgId}`),error=>{assert.match(String((error as Error & {cause?:Error}).cause?.message),/cannot be deleted/);return true})
    const returnResult=await computeTaxReturn(ledger.orgId,'CA_GST34',ledger.date,ledger.date,{}, {filingEntity:{subsidiaryIds:[],registrationId:registration.id}})
    assert.deepEqual(returnResult.subsidiaryIds,[ledger.subsidiaryId])
    await assert.rejects(computeTaxReturn(ledger.orgId,'CA_GST34',ledger.date,ledger.date,{}, {filingEntity:{subsidiaryIds:['00000000-0000-0000-0000-000000000000'],registrationId:registration.id}}),/another filing entity/)
  })} finally {await org.drop()}
})
