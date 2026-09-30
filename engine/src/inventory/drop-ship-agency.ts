import { sql } from 'drizzle-orm'
import { db,withOrgTransaction,type SqlExecutor } from '../platform/db.ts'
import { existingFinancialChange,proposeFinancialChange,loadFinancialChange,assertFinancialChangeApproved,completeFinancialChange } from '../platform/financial-changes.ts'
import { canonicalJson } from '../platform/canonical-json.ts'
import { isIsoCalendarDate } from '../platform/business-date.ts'
import { toQuantityUnits } from '../money/quantity.ts'
import { canonicalDecimal } from '../money/exact-decimal.ts'
import { add,cmp,neg,fromUnits,toUnits,roundDiv } from '../money/money.ts'
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts'
import { lockAndCheckOrgFeature } from '../organization/org-feature-lock.ts'
import { loadSubsidiaryContext,validateSubsidiaryRestrictions } from '../organization/subsidiaries.ts'
import { isUuid } from '../platform/uuid.ts'
import { ScopeNotFoundError } from '../organization/subsidiary-scope.ts'

export class AgencyError extends Error { readonly name='AgencyError'; readonly status=422 }
export interface AgencyAssessment {
  salesOrderLineId:string
  controlsBeforeTransfer:boolean
  passThroughAccountId:string|null
  controlEvidence:string
  effectiveOn:string
  reason:string
  idempotencyKey:string
}
type Source={sales_line_id:string;sales_order_id:string;purchase_line_id:string;purchase_order_id:string;subsidiary_id:string;currency:string;sales_amount:string;purchase_amount:string;quantity:string;purchase_quantity:string;item_id:string;sales_unit:string|null;purchase_unit:string|null;sales_tax:string;purchase_tax:string;recognition_rule_id:string|null;sales_status:string;purchase_status:string;sales_party_id:string|null;purchase_party_id:string|null}
async function feature(tx:SqlExecutor,orgId:string) {
  if(!await lockAndCheckOrgFeature(tx,orgId,'dropShipping'))throw new AgencyError('Turn on Drop Shipping in Company Settings → Features before assessing or posting an agency sale')
}
async function source(tx:SqlExecutor,orgId:string,lineId:string):Promise<Source> {
  if(!isUuid(lineId))throw new AgencyError('The assessed order line requires a valid source identifier — recreate the document through native order conversion')
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`agency-source:${orgId}:${lineId}`},0))`)
  const row=(await tx.execute<Source>(sql`select sale.id as sales_line_id,sale.document_id as sales_order_id,purchase.id as purchase_line_id,purchase.document_id as purchase_order_id,
    sales_order.subsidiary_id,sales_order.currency,sales_order.party_id as sales_party_id,purchase_order.party_id as purchase_party_id,sale.amount::text as sales_amount,purchase.amount::text as purchase_amount,
    sale.quantity::text,purchase.quantity::text as purchase_quantity,sale.item_id,sale.unit as sales_unit,purchase.unit as purchase_unit,
    sale.tax_amount::text as sales_tax,purchase.tax_amount::text as purchase_tax,item.recognition_rule_id,
    sales_order.status as sales_status,purchase_order.status as purchase_status
    from drop_ship_lines route join document_lines sale on sale.org_id=route.org_id and sale.id=route.sales_order_line_id
    join document_lines purchase on purchase.org_id=route.org_id and purchase.id=route.purchase_order_line_id
    join documents sales_order on sales_order.org_id=sale.org_id and sales_order.id=sale.document_id
    join documents purchase_order on purchase_order.org_id=purchase.org_id and purchase_order.id=purchase.document_id
    join drop_ship_orders pairing on pairing.org_id=route.org_id and pairing.sales_order_id=sales_order.id and pairing.purchase_order_id=purchase_order.id
    join items item on item.org_id=sale.org_id and item.id=sale.item_id
    where route.org_id=${orgId} and route.sales_order_line_id=${lineId} and sales_order.kind='sales_order' and purchase_order.kind='purchase_order'
      and purchase.item_id=sale.item_id and purchase_order.subsidiary_id=sales_order.subsidiary_id and purchase_order.currency=sales_order.currency
    for share of route,sale,purchase,sales_order,purchase_order,item`)).rows[0]
  if(!row || !row.subsidiary_id)throw new ScopeNotFoundError()
  return row
}
async function account(tx:SqlExecutor,orgId:string,id:string|null,subsidiaryId:string) {
  if(!id || !isUuid(id))throw new AgencyError('Select an active vendor pass-through liability account for the agency assessment')
  const row=(await tx.execute<{type:string}>(sql`select type from accounts where org_id=${orgId} and id=${id} and is_active and not is_summary for share`)).rows[0]
  if(!row || !['liability_current_other','liability_long_term'].includes(row.type))throw new AgencyError('Choose an active posting liability account outside the AP control accounts for vendor pass-through consideration')
  try{await validateSubsidiaryRestrictions(tx,{orgId,ctx:await loadSubsidiaryContext(tx,orgId),lines:[{accountId:id,amount:'0',subsidiaryId}],docSubsidiaryId:subsidiaryId})}catch(error){throw new AgencyError(error instanceof Error ? error.message : 'Choose an account permitted for the assessed legal entity')}
}
function validate(s:Source,input:Pick<AgencyAssessment,'controlsBeforeTransfer'|'controlEvidence'|'passThroughAccountId'>) {
  if(typeof input.controlsBeforeTransfer!=='boolean' || typeof input.controlEvidence!=='string' || input.controlEvidence.trim().length<40 || input.controlEvidence.length>10000)
    throw new AgencyError('Document whether the company controls the specified goods before customer transfer, with 40–10,000 characters of contractual evidence')
  if(!['approved','posted'].includes(s.sales_status) || !['approved','posted'].includes(s.purchase_status))throw new AgencyError('Approve both linked orders before assessing control of the specified goods')
  if(!input.controlsBeforeTransfer) {
    if(cmp(s.sales_amount,'0')<=0 || cmp(s.purchase_amount,'0')<0 || cmp(s.purchase_amount,s.sales_amount)>0 || toQuantityUnits(s.quantity)<=0n
      || toQuantityUnits(s.quantity)!==toQuantityUnits(s.purchase_quantity) || s.sales_unit!==s.purchase_unit)
      throw new AgencyError('Reconcile the paired order quantities, units and contracted consideration before assessing an agency sale; the vendor entitlement must not exceed the customer consideration')
    if(cmp(s.sales_tax,'0')!==0 || cmp(s.purchase_tax,'0')!==0 || s.recognition_rule_id)
      throw new AgencyError('This agency arrangement requires a separately assessed tax and performance-obligation treatment — correct the paired orders through their native tax and revenue configuration before using net-fee posting')
  }
}
async function unused(tx:SqlExecutor,orgId:string,s:Source) {
  const used=(await tx.execute(sql`select 1 from documents child join document_links link on link.org_id=child.org_id and link.to_document_id=child.id
    where child.org_id=${orgId} and link.from_document_id in (${s.sales_order_id},${s.purchase_order_id})
      and child.kind in ('customer_invoice','vendor_bill','purchase_receipt','sales_fulfillment') and child.status in ('approved','posted','voided') limit 1`)).rows.length
  if(used)throw new AgencyError('Assess control before approving an invoice, bill or shipment confirmation; correct existing accounting through the controlled document reversal workflow and use a new order for the changed arrangement')
}
export async function proposeDropShipAssessment(orgId:string,actorId:string,input:AgencyAssessment) {
  if(!isIsoCalendarDate(input.effectiveOn) || typeof input.reason!=='string' || input.reason.trim().length<8 || input.reason.length>1000
    || typeof input.idempotencyKey!=='string' || !input.idempotencyKey || input.idempotencyKey.length>120)throw new AgencyError('Provide a valid assessment date, an 8–1,000 character reason and a request key')
  return withOrgTransaction(orgId,async()=>{
    const allowed=await lockActorCommandAuthority(db,orgId,actorId,null,'ar.post');await feature(db,orgId)
    const s=await source(db,orgId,input.salesOrderLineId)
    if(allowed && !allowed.has(s.subsidiary_id))throw new ScopeNotFoundError()
    validate(s,input);if(!input.controlsBeforeTransfer)await account(db,orgId,input.passThroughAccountId,s.subsidiary_id)
    const proposal={orgId,subsidiaryId:s.subsidiary_id,domain:'sales' as const,subjectId:s.sales_line_id,operation:'drop_ship_control_assessment',effectiveOn:input.effectiveOn,reason:input.reason,actorId,idempotencyKey:input.idempotencyKey,
      payload:{controlsBeforeTransfer:input.controlsBeforeTransfer,passThroughAccountId:input.controlsBeforeTransfer ? null : input.passThroughAccountId,controlEvidence:input.controlEvidence,requiredSubsidiaryIds:[s.subsidiary_id]}}
    const prior=await existingFinancialChange(db,proposal);if(prior)return prior
    await unused(db,orgId,s)
    return proposeFinancialChange(db,{...proposal,beforeState:s})
  })
}
export async function applyDropShipAssessment(orgId:string,id:string,actorId:string) {
  return withOrgTransaction(orgId,async()=>{
    await lockActorCommandAuthority(db,orgId,actorId,null,'ar.post');await feature(db,orgId)
    if(!(await db.execute(sql`select id from financial_changes where org_id=${orgId} and id=${id} and domain='sales' and operation='drop_ship_control_assessment' for update`)).rows.length)throw new ScopeNotFoundError()
    const c=await loadFinancialChange(db,orgId,id);await lockActorCommandAuthority(db,orgId,actorId,c.subsidiary_id,'ar.post')
    if(c.status==='applied')return c.result!
    const s=await source(db,orgId,c.subject_id)
    try{assertFinancialChangeApproved(c,{domain:'sales',subjectId:s.sales_line_id,beforeState:s})}catch(error){throw new AgencyError(error instanceof Error ? error.message : 'Independent approval is required')}
    const assessment=c.payload as unknown as AgencyAssessment;validate(s,assessment)
    if(!assessment.controlsBeforeTransfer)await account(db,orgId,assessment.passThroughAccountId,s.subsidiary_id)
    await unused(db,orgId,s)
    if((await db.execute(sql`select id from financial_changes where org_id=${orgId} and domain='sales' and subject_id=${s.sales_line_id} and status='applied'`)).rows.length)
      throw new AgencyError('An approved control assessment already governs this line; use a new order for a changed contractual arrangement')
    const result={presentation:assessment.controlsBeforeTransfer ? 'principal_gross' : 'agent_net',fee:add(s.sales_amount,neg(s.purchase_amount)),source:s}
    await completeFinancialChange(db,orgId,id,actorId,result);return result
  })
}
/** Applied judgments remain authoritative through posting, replay and controlled
 * reversals. No caller-provided custom flag can elect net revenue. */
async function policy(tx:SqlExecutor,orgId:string,lineId:string,date:string) {
  const c=(await tx.execute<{id:string;effective_on:string;payload:AgencyAssessment;before_state:Source}>(sql`select id,effective_on::text,payload,before_state from financial_changes
    where org_id=${orgId} and domain='sales' and subject_id=${lineId} and operation='drop_ship_control_assessment' and status='applied' for share`)).rows[0]
  if(!c)return null
  await feature(tx,orgId)
  const s=await source(tx,orgId,lineId)
  if(canonicalJson(s)!==canonicalJson(c.before_state))throw new AgencyError('The paired order no longer matches its approved control assessment — reconcile the contractual source before posting')
  if(c.effective_on>date)throw new AgencyError('Use a posting date on or after the approved control assessment date')
  validate(s,c.payload)
  if(c.payload.controlsBeforeTransfer)return null
  await account(tx,orgId,c.payload.passThroughAccountId,s.subsidiary_id)
  return {change:c,source:s,accountId:c.payload.passThroughAccountId!}
}
export async function agencyForPurchaseLine(tx:SqlExecutor,orgId:string,lineId:string,date:string) {
  if(!isUuid(lineId))throw new AgencyError('The vendor bill requires a valid purchase-order source line — create it through native order conversion')
  const route=(await tx.execute<{id:string}>(sql`select sales_order_line_id as id from drop_ship_lines where org_id=${orgId} and purchase_order_line_id=${lineId}`)).rows[0]
  return route ? policy(tx,orgId,route.id,date) : null
}
export interface AgencyPosting {accountId:string;vendorAmount:string}
/** The source-line mutex serializes cumulative rounding and covered value.
 * Allocation evidence survives voids; the remaining live allocations, rather
 * than recomputed past rounding, determine each correcting posting. */
export async function resolveAgencyPosting(tx:SqlExecutor,orgId:string,documentId:string):Promise<Map<string,AgencyPosting>> {
  const result=new Map<string,AgencyPosting>()
  const document=(await tx.execute<{kind:string;document_date:string;subsidiary_id:string;currency:string;party_id:string|null}>(sql`select kind,document_date::text,subsidiary_id,currency,party_id from documents where org_id=${orgId} and id=${documentId}`)).rows[0]
  if(!document || !['customer_invoice','vendor_bill'].includes(document.kind))return result
  const lines=(await tx.execute<{id:string;item_id:string;amount:string;quantity:string;unit:string|null;tax_amount:string;custom:Record<string,unknown>}>(sql`select id,item_id,amount::text,quantity::text,unit,tax_amount::text,custom from document_lines where org_id=${orgId} and document_id=${documentId} order by id`)).rows
  const governed=(await tx.execute(sql`select 1 from document_links link join drop_ship_lines route on route.org_id=link.org_id
    join document_lines source_line on source_line.org_id=route.org_id and source_line.id=case when ${document.kind}='vendor_bill' then route.purchase_order_line_id else route.sales_order_line_id end
    join financial_changes change on change.org_id=route.org_id and change.subject_id=route.sales_order_line_id and change.domain='sales' and change.status='applied'
    where link.org_id=${orgId} and link.to_document_id=${documentId} and link.from_document_id=source_line.document_id and link.link_type='bills' and change.payload->>'controlsBeforeTransfer'='false' limit 1`)).rows.length>0
  const sourceIds=new Set<string>()
  for(const line of lines){
    const converted=line.custom?.convertedFrom as {lineId?:string}|undefined
    if(document.kind==='customer_invoice' && converted?.lineId)sourceIds.add(converted.lineId)
    const purchaseId=typeof line.custom?.purchaseOrderLineId==='string' ? line.custom.purchaseOrderLineId : (line.custom?.apCaptureEvidence as {purchaseOrderLineId?:string}|undefined)?.purchaseOrderLineId
    if(document.kind==='vendor_bill' && purchaseId){const route=(await tx.execute<{id:string}>(sql`select sales_order_line_id as id from drop_ship_lines where org_id=${orgId} and purchase_order_line_id=${purchaseId}`)).rows[0];if(route)sourceIds.add(route.id)}
  }
  for(const id of [...sourceIds].sort())await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`agency-source:${orgId}:${id}`},0))`)
  for(const l of lines) {
    const converted=l.custom?.convertedFrom as {lineId?:string;documentId?:string;quantity?:string}|undefined
    const purchaseId=typeof l.custom?.purchaseOrderLineId==='string' ? l.custom.purchaseOrderLineId : ((l.custom?.apCaptureEvidence as {purchaseOrderLineId?:string}|undefined)?.purchaseOrderLineId)
    if(governed && (document.kind==='customer_invoice' ? !converted?.lineId : !purchaseId))throw new AgencyError('Create the invoice or bill from its assessed order so every line retains its source-line evidence')
    if(governed){
      const sourceId=document.kind==='vendor_bill' ? purchaseId : converted?.lineId
      if(!isUuid(sourceId) || !(await tx.execute(sql`select 1 from document_lines source_line join document_links link on link.org_id=source_line.org_id and link.from_document_id=source_line.document_id and link.to_document_id=${documentId} and link.link_type='bills' where source_line.org_id=${orgId} and source_line.id=${sourceId} and source_line.item_id=${l.item_id}`)).rows.length)throw new AgencyError('Every agency invoice or bill line must preserve the item and source line of its linked assessed order')
    }
    const p=document.kind==='vendor_bill' ? (purchaseId ? await agencyForPurchaseLine(tx,orgId,purchaseId,document.document_date) : null) : (converted?.lineId ? await policy(tx,orgId,converted.lineId,document.document_date) : null)
    if(!p)continue
    const s=p.source,sourceDocumentId=document.kind==='vendor_bill' ? s.purchase_order_id : s.sales_order_id
    if(document.party_id!==(document.kind==='vendor_bill' ? s.purchase_party_id : s.sales_party_id) || document.subsidiary_id!==s.subsidiary_id || document.currency!==s.currency || l.item_id!==s.item_id || l.unit!==s.sales_unit || cmp(l.tax_amount,'0')!==0
      || (converted && converted.documentId!==sourceDocumentId))throw new AgencyError('The invoice or bill must preserve its assessed order’s item, unit, legal entity, currency and tax treatment')
    if(!(await tx.execute(sql`select 1 from document_links where org_id=${orgId} and from_document_id=${sourceDocumentId} and to_document_id=${documentId} and link_type='bills'`)).rows.length)
      throw new AgencyError('Create this invoice or bill through the assessed order’s native conversion so its contractual source is retained')
    const q=canonicalDecimal(l.quantity,8)
    const sourceAmount=document.kind==='vendor_bill' ? s.purchase_amount : s.sales_amount
    if(q===null || toQuantityUnits(q)<=0n || toQuantityUnits(q)>toQuantityUnits(s.quantity) || (converted && (canonicalDecimal(converted.quantity,8)===null || toQuantityUnits(converted.quantity!)!==toQuantityUnits(q))))
      throw new AgencyError('Reconcile invoice quantities to the approved paired order; price changes require a new assessed arrangement')
    const previous=(await tx.execute<{gross:string;vendor:string;quantity:string}>(sql`select coalesce(sum(allocation.gross_amount),0)::text as gross,coalesce(sum(allocation.vendor_amount),0)::text as vendor,coalesce(sum(allocation.quantity),0)::text as quantity
      from drop_ship_agent_allocations allocation join documents prior on prior.org_id=allocation.org_id and prior.id=allocation.document_id
      where allocation.org_id=${orgId} and allocation.sales_order_line_id=${s.sales_line_id} and allocation.kind=${document.kind}
        and (prior.status='posted' or prior.id=${documentId}) and allocation.document_line_id<>${l.id}`)).rows[0]!
    const cancelled=(await tx.execute<{quantity:string}>(sql`select quantity_cancelled::text as quantity from document_lines where org_id=${orgId} and id=${document.kind==='vendor_bill' ? s.purchase_line_id : s.sales_line_id} for share`)).rows[0]!
    const availableQuantity=toQuantityUnits(s.quantity)-toQuantityUnits(cancelled.quantity)
    const totalQuantity=toQuantityUnits(previous.quantity)+toQuantityUnits(q)
    if(totalQuantity>availableQuantity)throw new AgencyError('The assessed order quantity was cancelled or already billed — review the native order cancellation and use a new approved order for additional goods')
    if(totalQuantity>toQuantityUnits(s.quantity) || cmp(add(previous.gross,l.amount),sourceAmount)>0)throw new AgencyError('The posted invoices or bills already cover this assessed order quantity — void the incorrect document through its controlled reversal workflow before replacing it')
    const expected=add(fromUnits(roundDiv(toUnits(sourceAmount)*totalQuantity,toQuantityUnits(s.quantity))),neg(previous.gross))
    if(cmp(l.amount,expected)!==0)throw new AgencyError('Reconcile cumulative invoice consideration to the approved order; create the document through native order conversion and assess contractual price changes on a new arrangement')
    if(document.kind==='customer_invoice') {
      const delivered=(await tx.execute<{quantity:string}>(sql`select coalesce(sum(line.quantity),0)::text as quantity from document_lines line join documents receipt on receipt.org_id=line.org_id and receipt.id=line.document_id
        where line.org_id=${orgId} and receipt.kind='purchase_receipt' and receipt.status in ('approved','posted') and receipt.custom ? 'dropShipConfirmation'
          and line.custom->'receipt'->>'sourceLineId'=${s.purchase_line_id}
          and receipt.subsidiary_id=${s.subsidiary_id} and receipt.currency=${s.currency}`)).rows[0]!.quantity
      if(totalQuantity>toQuantityUnits(delivered))throw new AgencyError('Confirm the vendor shipment from the paired purchase order before recognizing the arranging fee for these quantities')
    }
    const vendor=document.kind==='vendor_bill' ? l.amount : add(fromUnits(roundDiv(toUnits(add(previous.gross,l.amount))*toUnits(s.purchase_amount),toUnits(s.sales_amount))),neg(previous.vendor))
    const old=(await tx.execute<{vendor_amount:string;gross_amount:string;quantity:string;change_id:string}>(sql`select vendor_amount::text,gross_amount::text,quantity::text,change_id from drop_ship_agent_allocations where org_id=${orgId} and document_line_id=${l.id}`)).rows[0]
    if(old) {
      if(old.change_id!==p.change.id || cmp(old.gross_amount,l.amount)!==0 || cmp(old.quantity,q)!==0)throw new AgencyError('The stored agency allocation differs from this document — use a controlled reversal and replacement')
      result.set(l.id,{accountId:p.accountId,vendorAmount:old.vendor_amount});continue
    }
    if(cmp(vendor,'0')<0 || cmp(vendor,l.amount)>0)throw new AgencyError('Reconcile earlier agency invoice reversals before replacing this allocation; the resulting vendor entitlement cannot exceed the billed consideration')
    const inserted=await tx.execute(sql`insert into drop_ship_agent_allocations(org_id,document_line_id,document_id,sales_order_line_id,change_id,kind,gross_amount,vendor_amount,quantity)
      values(${orgId},${l.id},${documentId},${s.sales_line_id},${p.change.id},${document.kind},${l.amount},${vendor},${q}) returning document_line_id`)
    if(inserted.rows.length!==1)throw new AgencyError('The agency allocation could not be recorded — reload the document before retrying')
    result.set(l.id,{accountId:p.accountId,vendorAmount:vendor})
  }
  return result
}

/** Reversal reads the frozen judgment rather than today's feature, item or
 * account configuration. A no-cost confirmation must still prove every line
 * belongs to an approved agency arrangement in the same legal entity. */
export async function isAgencyConfirmationLine(tx:SqlExecutor,orgId:string,receiptId:string,lineId:string) {
  return (await tx.execute(sql`select 1 from document_lines line join documents receipt on receipt.org_id=line.org_id and receipt.id=line.document_id
    join financial_changes change on change.org_id=line.org_id and change.domain='sales' and change.status='applied'
      and change.payload->>'controlsBeforeTransfer'='false' and change.before_state->>'purchase_line_id'=line.custom->'receipt'->>'sourceLineId'
    where line.org_id=${orgId} and line.id=${lineId} and receipt.id=${receiptId} and receipt.kind='purchase_receipt'
      and receipt.custom ? 'dropShipConfirmation' and receipt.subsidiary_id=change.subsidiary_id and receipt.currency=change.before_state->>'currency'
      and line.item_id::text=change.before_state->>'item_id' and line.unit is not distinct from change.before_state->>'purchase_unit'
      and line.quantity>0 and line.quantity<=(change.before_state->>'purchase_quantity')::numeric
      and line.tax_amount=0 and line.amount=round((change.before_state->>'purchase_amount')::numeric*line.quantity/(change.before_state->>'purchase_quantity')::numeric,4)
      and exists(select 1 from document_links link where link.org_id=receipt.org_id and link.to_document_id=receipt.id and link.link_type='fulfills'
        and link.from_document_id::text=change.before_state->>'purchase_order_id') for share of change`)).rows.length===1
}
