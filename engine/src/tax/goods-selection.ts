import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db,type SqlExecutor } from '../platform/db.ts'
import { canonicalJson } from '../platform/canonical-json.ts'
import { isUuid } from '../platform/uuid.ts'
import { CANADA_TAX_PACK } from '../country-tax-packs/ca.ts'
import { cmp } from '../money/money.ts'
import { loadSubsidiaryContext,validateSubsidiaryRestrictions } from '../organization/subsidiaries.ts'
import { quoteGoodsPlaceOfSupply,PlaceOfSupplyError } from './place-of-supply.ts'
import { loadTaxComponentConfig } from './persist.ts'
import { computeLineTaxes,type TaxComponentConfig,type ComputedTaxComponent } from './tax.ts'

export interface CanadianGoodsSelection {
  basis:'ordinary_taxable_goods_sale'
  country:'CA'
  deliveryProvince:string
  deliveryMethod:'delivered_or_made_available'|'supplier_arranged_shipping'|'recipient_collection'
  agreementEvidence:string
}
export interface GoodsTaxLine {amount:string;itemId?:string|null;taxCodeId?:string|null;taxGroupId?:string|null;taxOverridden?:boolean}
export function parseCanadianGoodsSelection(raw:unknown):CanadianGoodsSelection|null {
  if(raw===undefined || raw===null)return null
  if(typeof raw!=='object' || Array.isArray(raw))throw new PlaceOfSupplyError('Provide the Canadian goods supply classification, statutory delivery province and contractual evidence')
  const value=raw as Record<string,unknown>
  if(value.basis!=='ordinary_taxable_goods_sale' || value.country!=='CA' || typeof value.deliveryProvince!=='string'
    || !CANADA_TAX_PACK.jurisdictions.some(j=>j.region===value.deliveryProvince)
    || !['delivered_or_made_available','supplier_arranged_shipping','recipient_collection'].includes(String(value.deliveryMethod))
    || typeof value.agreementEvidence!=='string' || value.agreementEvidence.trim().length<20 || value.agreementEvidence.length>4000
    || Object.keys(value).some(key=>!['basis','country','deliveryProvince','deliveryMethod','agreementEvidence'].includes(key)))
    throw new PlaceOfSupplyError('Classify ordinary fully taxable Canadian goods, select the delivery or collection province under the applicable shipping terms, and provide 20–4,000 characters of contractual evidence; services, exemptions and special supplies need their explicit tax policy')
  return {basis:value.basis,country:value.country,deliveryProvince:value.deliveryProvince,deliveryMethod:value.deliveryMethod as CanadianGoodsSelection['deliveryMethod'],agreementEvidence:value.agreementEvidence.trim()}
}
export interface GoodsTaxSnapshot {
  selection:CanadianGoodsSelection
  subsidiaryId:string
  documentDate:string
  currency:string
  inputAmount:string
  item:{id:string;type:string}|null
  pack:{id:string;code:string;version:string;contentHash:string}
  registrations:{id:string;number:string;jurisdiction:string;effectiveFrom:string|null;effectiveTo:string|null}[]
  configs:TaxComponentConfig[]
  components:ComputedTaxComponent[]
  fingerprint:string
}

/** Only an explicit ordinary-goods election selects native tax. Existing
 * manual codes, groups and overrides remain authoritative for their lines. */
export async function resolveCanadianGoodsTaxes(orgId:string,options:{kind:string;subsidiaryId?:string|null;documentDate:string;currency:string;selection:unknown},lines:GoodsTaxLine[],tx:SqlExecutor=db) {
  const selection=parseCanadianGoodsSelection(options.selection),resolved=new Map<number,{computed:ReturnType<typeof computeLineTaxes>;snapshot:GoodsTaxSnapshot}>()
  if(!selection)return resolved
  if(options.kind!=='customer_invoice')throw new PlaceOfSupplyError('Use the native ordinary-goods election on a customer invoice; other document kinds require their explicit tax profile or source-document tax treatment')
  const automatic=lines.map((line,index)=>({line,index})).filter(({line})=>!line.taxCodeId && !line.taxGroupId && !line.taxOverridden)
  if(!automatic.length)return resolved
  if(!options.subsidiaryId) {
    const legal=(await tx.execute<{id:string}>(sql`select id from subsidiaries where org_id=${orgId} and is_active and not is_elimination order by id for share`)).rows
    if(legal.length===1)options={...options,subsidiaryId:legal[0]!.id}
  }
  if(!options.subsidiaryId || !isUuid(options.subsidiaryId))throw new PlaceOfSupplyError('Select the selling legal entity before automatically calculating Canadian goods tax')
  const entity=(await tx.execute<{id:string;country:string}>(sql`select id,country from subsidiaries where org_id=${orgId} and id=${options.subsidiaryId} and is_active and not is_elimination for share`)).rows[0]
  if(!entity || entity.country!=='CA')throw new PlaceOfSupplyError('Select an active Canadian selling legal entity; a foreign or elimination entity requires its separately assessed tax treatment')
  const pack=(await tx.execute<{id:string;code:string;version:string;contentHash:string}>(sql`select id,pack_code as code,version,content_hash as "contentHash" from tax_country_pack_installations
    where org_id=${orgId} and pack_code=${CANADA_TAX_PACK.code} and country='CA' and status='active' for share`)).rows[0]
  if(!pack || pack.version!==CANADA_TAX_PACK.version)throw new PlaceOfSupplyError('Install the current Canada tax pack in Tax → Setup before selecting native Canadian goods tax')
  const quote=quoteGoodsPlaceOfSupply({taxableAmount:'0',quotedOn:options.documentDate,country:'CA',deliveryProvince:selection.deliveryProvince,basis:selection.basis})
  const configs:TaxComponentConfig[]=[],registrations:GoodsTaxSnapshot['registrations']=[]
  for(const [sequence,component] of quote.components.entries()) {
    const code=(await tx.execute<{id:string;jurisdiction_id:string;collected_account_id:string|null}>(sql`select id,jurisdiction_id,collected_account_id from tax_codes where org_id=${orgId} and code=${component.code}
      and is_active and country='CA' and applies_to in ('both','sales') for share`)).rows[0]
    if(!code || !code.collected_account_id)throw new PlaceOfSupplyError(`Configure the installed ${component.code} code and its collected-tax account in Tax → Setup before automatically calculating this supply`)
    const jurisdiction=component.code==='CA-GST' || component.code.endsWith('-HST') ? 'CA' : 'CA-'+selection.deliveryProvince
    const regs=(await tx.execute<{id:string;number:string;jurisdiction:string;effectiveFrom:string|null;effectiveTo:string|null}>(sql`select r.id,r.registration_number as number,j.code as jurisdiction,r.effective_from::text as "effectiveFrom",r.effective_to::text as "effectiveTo"
      from tax_registrations r join tax_jurisdictions j on j.org_id=r.org_id and j.id=r.jurisdiction_id
      where r.org_id=${orgId} and r.subsidiary_id=${entity.id} and r.is_active and j.is_active and j.code=${jurisdiction}
        and nullif(btrim(r.registration_number),'') is not null and (r.effective_from is null or r.effective_from<=${options.documentDate}::date)
        and (r.effective_to is null or r.effective_to>=${options.documentDate}::date) for share of r,j`)).rows
    if(regs.length!==1)throw new PlaceOfSupplyError(`Configure one effective ${jurisdiction} tax registration with its number and selling legal entity in Tax → Setup → Registrations before automatically charging ${component.code}; assess a non-registration or exemption treatment with an explicit tax profile`)
    if(!registrations.some(reg=>reg.id===regs[0]!.id))registrations.push(regs[0]!)
    const rates=(await tx.execute<{id:string}>(sql`select id from tax_rates where org_id=${orgId} and tax_code_id=${code.id} and effective_from<=${options.documentDate}::date
      and (effective_to is null or effective_to>=${options.documentDate}::date) for share`)).rows
    if(rates.length!==1)throw new PlaceOfSupplyError(`Configure exactly one effective rate for ${component.code} on ${options.documentDate}`)
    const config=(await loadTaxComponentConfig(orgId,code.id,options.documentDate,tx))[0]!
    if(cmp(config.ratePercent,component.ratePercent)!==0 || config.calculationType!=='standard' || config.priceIncludesTax || config.compoundOnPrevious || config.roundingScale!==2)
      throw new PlaceOfSupplyError(`Reconcile ${component.code} to the maintained statutory standard rate, exclusive-price treatment and two-decimal rounding before selecting native goods tax`)
    configs.push({...config,sequence:sequence+1})
  }
  try {await validateSubsidiaryRestrictions(tx,{orgId,ctx:await loadSubsidiaryContext(tx,orgId),lines:configs.map(config=>({accountId:config.collectedAccountId!,amount:'0',subsidiaryId:entity.id})),docSubsidiaryId:entity.id})}
  catch(error){throw new PlaceOfSupplyError(error instanceof Error ? error.message : 'Choose collected-tax accounts permitted for the selling legal entity')}
  const accounts=(await tx.execute<{id:string;type:string}>(sql`select id,type from accounts where org_id=${orgId} and id in (select jsonb_array_elements_text(${JSON.stringify(configs.map(config=>config.collectedAccountId))}::jsonb)::uuid)
    and is_active and not is_summary for share`)).rows
  if(configs.some(config=>!accounts.some(account=>account.id===config.collectedAccountId && ['liability_current_other','liability_long_term'].includes(account.type))))
    throw new PlaceOfSupplyError('Select active collected-tax liability accounts for the native tax codes before automatically charging tax')
  for(const {line,index} of automatic) {
    let item:GoodsTaxSnapshot['item']=null
    if(line.itemId) {
      if(!isUuid(line.itemId))throw new PlaceOfSupplyError(`Line ${index+1}: select a valid goods item`)
      item=(await tx.execute<{id:string;type:string}>(sql`select id,kind as type from items where org_id=${orgId} and id=${line.itemId} and is_active for share`)).rows[0] ?? null
      if(!item || !['inventory','non_inventory','assembly'].includes(item.type))throw new PlaceOfSupplyError(`Line ${index+1}: this item is not ordinary tangible goods — select its explicit service, exemption or special-supply tax profile`)
    }
    const statutory=quoteGoodsPlaceOfSupply({taxableAmount:line.amount,quotedOn:options.documentDate,country:'CA',deliveryProvince:selection.deliveryProvince,basis:selection.basis})
    const computed=computeLineTaxes(statutory.taxableAmount,configs)
    const evidence={selection,subsidiaryId:entity.id,documentDate:options.documentDate,currency:options.currency,inputAmount:computed.inputAmount,item,pack,registrations,configs,components:computed.components}
    resolved.set(index,{computed,snapshot:{...evidence,fingerprint:createHash('sha256').update(canonicalJson(evidence)).digest('hex')}})
  }
  return resolved
}

/** Called by the shared document writer in its locked transaction. The
 * snapshot is internal calculation output, never an HTTP input field. */
export async function persistGoodsTaxSnapshot(tx:SqlExecutor,orgId:string,lineId:string,snapshot:GoodsTaxSnapshot,actorId:string) {
  const saved=await tx.execute(sql`insert into document_goods_tax_snapshots(org_id,document_line_id,subsidiary_id,registration_ids,snapshot,fingerprint,created_by)
    values(${orgId},${lineId},${snapshot.subsidiaryId},${JSON.stringify(snapshot.registrations.map(reg=>reg.id))}::jsonb,${JSON.stringify(snapshot)}::jsonb,${snapshot.fingerprint},${actorId}) returning document_line_id`)
  if(saved.rows.length!==1)throw new PlaceOfSupplyError('The native goods tax evidence could not be saved — reload the invoice before retrying')
}

/** The posting boundary refuses a missing or stale automatic snapshot. An
 * approved invoice must be returned to draft and recalculated, never priced
 * silently under another legal entity, registration or supply assessment. */
export async function assertCanadianGoodsTaxEvidence(tx:SqlExecutor,orgId:string,documentId:string) {
  const doc=(await tx.execute<{kind:string;subsidiary_id:string;currency:string;document_date:string;custom:Record<string,unknown>}>(sql`select kind,subsidiary_id,currency,document_date::text,custom from documents where org_id=${orgId} and id=${documentId}`)).rows[0]
  if(!doc)return
  const selection=parseCanadianGoodsSelection(doc.custom?.canadianGoodsTax)
  const snapshots=(await tx.execute<{document_line_id:string;snapshot:GoodsTaxSnapshot}>(sql`select saved.document_line_id,saved.snapshot from document_goods_tax_snapshots saved join document_lines line
    on line.org_id=saved.org_id and line.id=saved.document_line_id where saved.org_id=${orgId} and line.document_id=${documentId} for share of saved`)).rows
  if(!selection && snapshots.length)throw new PlaceOfSupplyError('The invoice no longer carries its recorded goods supply assessment — return it to draft and recalculate before posting')
  if(!selection)return
  const rows=(await tx.execute<{id:string;amount:string;itemId:string|null;taxCodeId:string|null;taxGroupId:string|null;taxOverridden:boolean;taxAmount:string}>(sql`select id,amount::text,item_id as "itemId",tax_code_id as "taxCodeId",tax_group_id as "taxGroupId",tax_overridden as "taxOverridden",tax_amount::text as "taxAmount" from document_lines where org_id=${orgId} and document_id=${documentId} order by line_number for share`)).rows
  const resolved=await resolveCanadianGoodsTaxes(orgId,{kind:doc.kind,subsidiaryId:doc.subsidiary_id,documentDate:doc.document_date,currency:doc.currency,selection},rows,tx)
  for(const [index,calculation] of resolved) {
    const row=rows[index]!,saved=snapshots.find(snapshot=>snapshot.document_line_id===row.id)
    if(!saved || saved.snapshot.fingerprint!==calculation.snapshot.fingerprint || cmp(row.taxAmount,calculation.computed.taxTotal)!==0)
      throw new PlaceOfSupplyError(`Line ${index+1}: native goods tax evidence is missing or changed — return the invoice to draft, review the supply terms and recalculate before submitting it again`)
    const actual=(await tx.execute<{tax_code_id:string;rate_percent:string;taxable_amount:string;tax_amount:string;collected_account_id:string|null}>(sql`select tax_code_id,rate_percent::text,taxable_amount::text,tax_amount::text,collected_account_id from document_line_tax_components where org_id=${orgId} and document_line_id=${row.id} order by sequence for share`)).rows
    if(actual.length!==calculation.computed.components.length || actual.some((component,i)=>{const expected=calculation.computed.components[i]!;return component.tax_code_id!==expected.taxCodeId || cmp(component.rate_percent,expected.ratePercent)!==0 || cmp(component.taxable_amount,expected.taxableAmount)!==0 || cmp(component.tax_amount,expected.taxAmount)!==0 || component.collected_account_id!==expected.collectedAccountId}))
      throw new PlaceOfSupplyError(`Line ${index+1}: the native tax component evidence does not match its supply assessment — return the invoice to draft and recalculate before posting`)
  }
  if(snapshots.some(snapshot=>!rows.some((row,index)=>row.id===snapshot.document_line_id && resolved.has(index))))throw new PlaceOfSupplyError('A manual tax selection still carries automatic goods evidence — return the invoice to draft and save its intended tax policy before posting')
}
