import { sql } from 'drizzle-orm'
import { db,withOrgTransaction,type SqlExecutor } from '../platform/db.ts'
import { isUuid } from '../platform/uuid.ts'
import { isIsoCalendarDate } from '../platform/business-date.ts'
import { existingFinancialChange,proposeFinancialChange,loadFinancialChange,assertFinancialChangeApproved,completeFinancialChange } from '../platform/financial-changes.ts'
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts'
import { lockAndCheckOrgFeature } from '../organization/org-feature-lock.ts'
import { ScopeNotFoundError } from '../organization/subsidiary-scope.ts'
import { loadSubsidiaryContext,validateSubsidiaryRestrictions,restrictionAdmits } from '../organization/subsidiaries.ts'
import { resolveCoveringPeriod } from '../periods/period-resolution.ts'
import { assertPeriodModulesOpen,CloseError } from '../periods/period-policy.ts'
import { postEntry,markEntryReversed } from '../journal/post-entry.ts'
import { cmp,isZero,mulRate,neg,sum } from '../money/money.ts'

export class NetInvestmentError extends Error { readonly status=422; readonly name='NetInvestmentError' }
export interface NetInvestmentAssessment {
  pairId:string
  bookId:string
  eliminationSubsidiaryId:string
  ociAccountId:string
  profitLossAccountId:string
  sourceLineIds:string[]
  notPlannedOrLikely:boolean
  nonTrade:boolean
  qualificationEvidence:string
  effectiveOn:string
  reason:string
  idempotencyKey:string
}
type Interest={id:string;subsidiary_id:string;parent_subsidiary_id:string;method:string;ownership_percent:string;effective_from:string;effective_to:string|null}
type Pair={id:string;from_subsidiary_id:string;to_subsidiary_id:string;due_from_account_id:string;due_to_account_id:string}
type Entity={id:string;base_currency:string;is_elimination:boolean}
type Source={id:string;entry_id:string;account_id:string;subsidiary_id:string;amount:string;period_id:string;posting_date:string;reverses_entry_id:string|null;positions:{accountId:string;currency:string}[];gainLossAccountId:string;averageRate:string;translated:string}
async function features(tx:SqlExecutor,orgId:string) {
  if(!await lockAndCheckOrgFeature(tx,orgId,'multiSubsidiary') || !await lockAndCheckOrgFeature(tx,orgId,'multiCurrency'))
    throw new NetInvestmentError('Turn on Multi-Subsidiary and Multi-Currency in Company Settings → Features before assessing net-investment exchange differences')
}
function validate(input:NetInvestmentAssessment) {
  if(!input || ![input.pairId,input.bookId,input.eliminationSubsidiaryId,input.ociAccountId,input.profitLossAccountId].every(isUuid)
    || !Array.isArray(input.sourceLineIds) || !input.sourceLineIds.length || input.sourceLineIds.length>200 || !input.sourceLineIds.every(isUuid)
    || new Set(input.sourceLineIds).size!==input.sourceLineIds.length || !isIsoCalendarDate(input.effectiveOn))
    throw new NetInvestmentError('Select a paired loan, book, consolidation entity, posting accounts and distinct native FX lines for a valid assessment date')
  if(input.notPlannedOrLikely!==true || input.nonTrade!==true || typeof input.qualificationEvidence!=='string' || input.qualificationEvidence.trim().length<40 || input.qualificationEvidence.length>10000)
    throw new NetInvestmentError('Confirm this is a non-trade monetary loan whose settlement is neither planned nor likely, and document the contractual qualification evidence')
  if(typeof input.reason!=='string' || input.reason.trim().length<8 || input.reason.length>1000 || !input.idempotencyKey || input.idempotencyKey.length>120)
    throw new NetInvestmentError('Provide an 8–1,000 character review reason and a request key')
}
async function basis(tx:SqlExecutor,orgId:string,actorId:string,interestId:string,input:NetInvestmentAssessment) {
  validate(input)
  if(!isUuid(interestId))throw new NetInvestmentError('Select a valid native ownership interest')
  const allowed=await lockActorCommandAuthority(tx,orgId,actorId,null,'close.run');await features(tx,orgId)
  const interest=(await tx.execute<Interest>(sql`select id,subsidiary_id,parent_subsidiary_id,method,ownership_percent::text,effective_from::text,effective_to::text
    from subsidiary_ownership_interests where org_id=${orgId} and id=${interestId} and is_active for update`)).rows[0]
  if(!interest || (allowed && [interest.subsidiary_id,interest.parent_subsidiary_id].some(id=>!allowed.has(id))))throw new ScopeNotFoundError()
  if(interest.method!=='full' || cmp(interest.ownership_percent,'100')!==0 || interest.effective_from>input.effectiveOn || (interest.effective_to && interest.effective_to<input.effectiveOn))
    throw new NetInvestmentError('Select an effective wholly owned, fully consolidated foreign operation; ownership with non-controlling interests requires its attributable OCI assessment before using this loan review')
  const pair=(await tx.execute<Pair>(sql`select id,from_subsidiary_id,to_subsidiary_id,due_from_account_id,due_to_account_id from intercompany_pairs where org_id=${orgId} and id=${input.pairId} and is_active for share`)).rows[0]
  if(!pair || ![pair.from_subsidiary_id,pair.to_subsidiary_id].includes(interest.subsidiary_id))throw new ScopeNotFoundError()
  const ids=[...new Set([interest.parent_subsidiary_id,interest.subsidiary_id,pair.from_subsidiary_id,pair.to_subsidiary_id,input.eliminationSubsidiaryId])].sort()
  if(allowed && ids.some(id=>!allowed.has(id)))throw new ScopeNotFoundError()
  const entities=(await tx.execute<Entity>(sql`select id,base_currency,is_elimination from subsidiaries where org_id=${orgId}
    and id in (select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::uuid) and is_active order by id for share`)).rows
  if(entities.length!==ids.length)throw new ScopeNotFoundError()
  const elimination=entities.find(entity=>entity.id===input.eliminationSubsidiaryId)!
  const foreign=entities.find(entity=>entity.id===interest.subsidiary_id)!,parent=entities.find(entity=>entity.id===interest.parent_subsidiary_id)!
  if(!elimination.is_elimination || foreign.is_elimination || foreign.base_currency===parent.base_currency)
    throw new NetInvestmentError('Select a consolidation elimination entity and a foreign operation with a different functional currency')
  const other=[pair.from_subsidiary_id,pair.to_subsidiary_id].find(id=>id!==interest.subsidiary_id)!
  if(other!==parent.id && !(await tx.execute(sql`select id from subsidiary_ownership_interests where org_id=${orgId} and subsidiary_id=${other}
    and parent_subsidiary_id=${parent.id} and is_active and method='full' and ownership_percent=100 and effective_from<=${input.effectiveOn}::date
    and (effective_to is null or effective_to>=${input.effectiveOn}::date) for share`)).rows.length)
    throw new NetInvestmentError('The loan counterparty must be the consolidating parent or its effective wholly owned group subsidiary; reconcile the ownership scope before assessing it')
  const book=(await tx.execute<{id:string}>(sql`select id from accounting_books where org_id=${orgId} and id=${input.bookId} and is_active and posts_gl and is_primary for share`)).rows[0]
  if(!book)throw new ScopeNotFoundError()
  const period=await resolveCoveringPeriod(tx,orgId,input.effectiveOn)
  if(!period)throw new NetInvestmentError('Create an accounting period for the assessment date in the selected book before proposing this review')
  const accountRows=(await tx.execute<{id:string;type:string;monetary:boolean|null}>(sql`select id,type,monetary from accounts where org_id=${orgId}
    and id in (${input.ociAccountId},${input.profitLossAccountId},${pair.due_from_account_id},${pair.due_to_account_id}) and is_active and not is_summary order by id for share`)).rows
  if(accountRows.find(a=>a.id===input.ociAccountId)?.type!=='equity' || !['income_other','expense_other'].includes(accountRows.find(a=>a.id===input.profitLossAccountId)?.type ?? ''))
    throw new NetInvestmentError('Choose an active OCI equity reserve and an active FX profit-or-loss posting account')
  for(const id of [pair.due_from_account_id,pair.due_to_account_id]) {
    const a=accountRows.find(a=>a.id===id)
    if(!a || a.monetary!==true || !['asset_current_other','asset_other','liability_current_other','liability_long_term'].includes(a.type))
      throw new NetInvestmentError('Configure dedicated non-trade monetary loan accounts on the intercompany pair; trade AR and AP cannot qualify as a net investment')
    if((await tx.execute(sql`select 1 from intercompany_pairs where org_id=${orgId} and is_active and id<>${pair.id}
      and (due_from_account_id=${id} or due_to_account_id=${id}) for share`)).rows.length)
      throw new NetInvestmentError('This loan account is shared with another intercompany counterparty — use a dedicated account before attributing its FX difference')
  }
  try {await validateSubsidiaryRestrictions(tx,{orgId,ctx:await loadSubsidiaryContext(tx,orgId),lines:[input.ociAccountId,input.profitLossAccountId].map(accountId=>({accountId,amount:'0',subsidiaryId:elimination.id})),docSubsidiaryId:elimination.id})}
  catch(error){throw new NetInvestmentError(error instanceof Error ? error.message : 'Choose accounts permitted for the elimination entity')}
  const sources:Source[]=[]
  for(const id of [...input.sourceLineIds].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`net-investment-source:${orgId}:${id}`},0))`)
    const row=(await tx.execute<Omit<Source,'positions'|'gainLossAccountId'|'averageRate'|'translated'>>(sql`select line.id,line.entry_id,line.account_id,line.subsidiary_id,line.amount::text,
      entry.period_id,entry.posting_date::text,entry.reverses_entry_id from journal_lines line join journal_entries entry on entry.org_id=line.org_id and entry.id=line.entry_id
      where line.org_id=${orgId} and line.id=${id} and entry.book_id=${book.id} and entry.origin='fx_revaluation' and entry.status in ('posted','reversed')
        and entry.period_id=${period.id} and entry.posting_date<=${input.effectiveOn}::date for share of line,entry`)).rows[0]
    if(!row || !((row.subsidiary_id===pair.from_subsidiary_id && row.account_id===pair.due_from_account_id)
      || (row.subsidiary_id===pair.to_subsidiary_id && row.account_id===pair.due_to_account_id)))
      throw new NetInvestmentError('Select only the paired loan’s posted native FX monetary lines in this book and assessment period')
    if((await tx.execute(sql`select 1 from net_investment_sources where org_id=${orgId} and source_line_id=${id} and reversed_by_change_id is null`)).rows.length)
      throw new NetInvestmentError('This FX line already has an approved OCI attribution — review the recorded assessment instead of classifying the same exchange difference twice')
    const rootId=row.reverses_entry_id ?? row.entry_id
    const evidence=(await tx.execute<{changes:{positions?:Source['positions'];lines?:{accountId:string;amount:string}[];gainLossAccountId?:string}}>(sql`select changes from audit_log where org_id=${orgId}
      and table_name='journal_entries' and row_id=${rootId} and changes->>'mode'='fx_revaluation_incremental' order by at,id limit 1`)).rows[0]?.changes
    const positions=evidence?.positions?.filter(position=>position.accountId===row.account_id) ?? []
    if(!positions.length || new Set(positions.map(position=>position.currency)).size!==1)
      throw new NetInvestmentError('The native FX audit must prove one dedicated loan currency; reconcile mixed-currency exposure before attributing it to OCI')
    const holder=entities.find(entity=>entity.id===row.subsidiary_id)!
    const accounts=(await tx.execute<{id:string;type:string}>(sql`select id,type from accounts where org_id=${orgId}
      and id in (select jsonb_array_elements_text(${JSON.stringify((evidence?.lines ?? []).map(line=>line.accountId))}::jsonb)::uuid)`)).rows
    const pnl=accounts.filter(a=>['income_other','expense_other'].includes(a.type))
    if((evidence?.gainLossAccountId ?? (pnl.length===1 ? pnl[0]!.id : null))!==input.profitLossAccountId)
      throw new NetInvestmentError('Select the native revaluation’s gain-or-loss account so the consolidation adjustment cancels the actual standalone FX result')
    let averageRate='1'
    if(holder.base_currency!==elimination.base_currency) {
      const rate=(await tx.execute<{average_rate:string}>(sql`select average_rate::text from consolidated_fx_rates where org_id=${orgId} and period_id=${period.id}
        and from_currency=${holder.base_currency} and to_currency=${elimination.base_currency} for share`)).rows[0]
      if(!rate || cmp(rate.average_rate,'0')<=0)throw new NetInvestmentError('Derive the period’s consolidated average FX rate before translating its standalone profit-or-loss reclassification')
      averageRate=rate.average_rate
    }
    sources.push({...row,positions,gainLossAccountId:input.profitLossAccountId,averageRate,translated:mulRate(row.amount,averageRate)})
  }
  return {interest,pair,entities,periodId:period.id,bookId:book.id,elimination,sources,requiredSubsidiaryIds:ids}
}
export async function proposeNetInvestmentAssessment(orgId:string,interestId:string,actorId:string,input:NetInvestmentAssessment) {
  return withOrgTransaction(orgId,async()=>{
    validate(input)
    const allowed=await lockActorCommandAuthority(db,orgId,actorId,null,'close.run');await features(db,orgId)
    const old=(await db.execute<{payload:Record<string,unknown>}>(sql`select payload from financial_changes where org_id=${orgId} and idempotency_key=${input.idempotencyKey}`)).rows[0]
    if(old) {
      const required=old.payload.requiredSubsidiaryIds as string[]
      if(!Array.isArray(required) || (allowed && required.some(id=>!allowed.has(id))))throw new ScopeNotFoundError()
      const replay=await existingFinancialChange(db,{orgId,subsidiaryId:input.eliminationSubsidiaryId,domain:'consolidation',subjectId:interestId,operation:'net_investment_oci',effectiveOn:input.effectiveOn,reason:input.reason,actorId,idempotencyKey:input.idempotencyKey,payload:{...input,sourceLineIds:[...input.sourceLineIds].sort(),requiredSubsidiaryIds:required}})
      if(replay)return replay
    }
    const beforeState=await basis(db,orgId,actorId,interestId,input)
    const proposal={orgId,subsidiaryId:input.eliminationSubsidiaryId,domain:'consolidation' as const,subjectId:interestId,operation:'net_investment_oci',effectiveOn:input.effectiveOn,
      reason:input.reason,actorId,idempotencyKey:input.idempotencyKey,payload:{...input,sourceLineIds:[...input.sourceLineIds].sort(),requiredSubsidiaryIds:beforeState.requiredSubsidiaryIds}}
    const prior=await existingFinancialChange(db,proposal);if(prior)return prior
    return proposeFinancialChange(db,{...proposal,beforeState})
  })
}
export async function applyNetInvestmentAssessment(orgId:string,id:string,actorId:string) {
  return withOrgTransaction(orgId,async()=>{
    await lockActorCommandAuthority(db,orgId,actorId,null,'close.run');await features(db,orgId)
    if(!(await db.execute(sql`select id from financial_changes where org_id=${orgId} and id=${id} and domain='consolidation' and operation='net_investment_oci' for update`)).rows.length)throw new ScopeNotFoundError()
    const change=await loadFinancialChange(db,orgId,id)
    const allowed=await lockActorCommandAuthority(db,orgId,actorId,change.subsidiary_id,'close.run')
    const required=change.payload.requiredSubsidiaryIds as string[]
    if(!Array.isArray(required) || (allowed && required.some(entity=>!allowed.has(entity))))throw new ScopeNotFoundError()
    if(change.status==='applied')return change.result!
    const input=change.payload as unknown as NetInvestmentAssessment
    const beforeState=await basis(db,orgId,actorId,change.subject_id,input)
    try {assertFinancialChangeApproved(change,{domain:'consolidation',subjectId:change.subject_id,beforeState})}
    catch(error){throw new NetInvestmentError(error instanceof Error ? error.message : 'Independent approval is required')}
    try {await assertPeriodModulesOpen(db,{orgId,periodId:beforeState.periodId,bookId:input.bookId,subsidiaryIds:required,modules:['gl']})}
    catch(error){if(error instanceof CloseError)throw new NetInvestmentError(`${error.message} — use an open assessment period or the controlled reopen workflow in Accounting → Close`);throw error}
    const delta=sum(beforeState.sources.map(source=>source.translated))
    const entry=isZero(delta) ? null : await postEntry(db,{orgId,bookId:input.bookId,subsidiaryId:input.eliminationSubsidiaryId,
      entryNumber:`NETINV-${change.id}`,postingDate:change.effective_on,periodId:beforeState.periodId,origin:'net_investment_oci',actorId,
      currency:beforeState.elimination.base_currency,idempotencyKey:`net-investment:${change.id}`,memo:'Qualifying net-investment exchange differences — consolidated OCI',
      lines:[{accountId:input.profitLossAccountId,amount:delta},{accountId:input.ociAccountId,amount:neg(delta)}],auditChanges:{changeId:change.id,interestId:change.subject_id,sources:beforeState.sources}})
    const recorded=await db.execute(sql`insert into net_investment_entries(org_id,change_id,interest_id,journal_entry_id,book_id,period_id,elimination_subsidiary_id)
      values(${orgId},${change.id},${change.subject_id},${entry?.entryId ?? null},${input.bookId},${beforeState.periodId},${input.eliminationSubsidiaryId}) returning change_id`)
    if(recorded.rows.length!==1)throw new NetInvestmentError('The assessment journal linkage could not be recorded — reload the approved assessment before retrying')
    for(const source of beforeState.sources) {
      const inserted=await db.execute(sql`insert into net_investment_sources(org_id,source_line_id,change_id,amount,translated_amount,average_rate)
        values(${orgId},${source.id},${change.id},${source.amount},${source.translated},${source.averageRate}) returning source_line_id`)
      if(inserted.rows.length!==1)throw new NetInvestmentError('The source FX attribution could not be recorded — reload the approved assessment before retrying')
    }
    const result={entryIds:entry ? [entry.entryId] : [],ociMovement:delta,consolidationProfitLossOffset:delta,sourceLineIds:input.sourceLineIds}
    await completeFinancialChange(db,orgId,id,actorId,result);return result
  })
}

export interface NetInvestmentReversal {effectiveOn:string;reason:string;idempotencyKey:string}
async function reversalBasis(tx:SqlExecutor,orgId:string,actorId:string,sourceChangeId:string) {
  const allowed=await lockActorCommandAuthority(tx,orgId,actorId,null,'close.run')
  if(!isUuid(sourceChangeId) || !(await tx.execute(sql`select id from financial_changes where org_id=${orgId} and id=${sourceChangeId} and domain='consolidation' and operation='net_investment_oci' for update`)).rows.length)throw new ScopeNotFoundError()
  const source=await loadFinancialChange(tx,orgId,sourceChangeId)
  if(source.domain!=='consolidation' || source.operation!=='net_investment_oci' || source.status!=='applied')throw new ScopeNotFoundError()
  const required=source.payload.requiredSubsidiaryIds as string[]
  if(!Array.isArray(required) || (allowed && required.some(id=>!allowed.has(id))))throw new ScopeNotFoundError()
  const record=(await tx.execute<{journal_entry_id:string|null;reversed_by_change_id:string|null;book_id:string;interest_id:string}>(sql`select journal_entry_id,reversed_by_change_id,book_id,interest_id
    from net_investment_entries where org_id=${orgId} and change_id=${sourceChangeId} for update`)).rows[0]
  if(!record || record.reversed_by_change_id)throw new NetInvestmentError('This assessment has already been corrected — review its recorded reversal in Accounting changes')
  await tx.execute(sql`select id from subsidiary_ownership_interests where org_id=${orgId} and id=${record.interest_id} for update`)
  if((await tx.execute(sql`select 1 from consolidation_control_losses where org_id=${orgId} and interest_id=${record.interest_id} and reversed_by_change_id is null`)).rows.length)
    throw new NetInvestmentError('This reserve supports an approved disposal — correct that loss-of-control event in Accounting changes before reversing the underlying OCI assessment')
  const lines=record.journal_entry_id ? (await tx.execute<{account_id:string;amount:string;currency:string}>(sql`select account_id,amount::text,currency from journal_lines where org_id=${orgId} and entry_id=${record.journal_entry_id} order by line_number for share`)).rows : []
  if(record.journal_entry_id && !(await tx.execute(sql`select 1 from journal_entries e where e.org_id=${orgId} and e.id=${record.journal_entry_id} and e.status='posted'
    and not exists(select 1 from journal_entries reversal where reversal.org_id=e.org_id and reversal.reverses_entry_id=e.id and reversal.status in ('posted','reversed')) for update of e`)).rows.length)
    throw new NetInvestmentError('The source assessment journal is already reversed — review its recorded correction before proposing another reversal')
  const sources=(await tx.execute<{source_line_id:string}>(sql`select source_line_id from net_investment_sources where org_id=${orgId} and change_id=${sourceChangeId} order by source_line_id for update`)).rows
  return {sourceChangeId,interestId:source.subject_id,subsidiaryId:source.subsidiary_id,sourceDate:source.effective_on,requiredSubsidiaryIds:required,record,lines,sources}
}
export async function proposeNetInvestmentReversal(orgId:string,sourceChangeId:string,actorId:string,input:NetInvestmentReversal) {
  if(!isIsoCalendarDate(input.effectiveOn) || typeof input.reason!=='string' || input.reason.trim().length<8 || input.reason.length>1000 || !input.idempotencyKey || input.idempotencyKey.length>120)
    throw new NetInvestmentError('Provide a valid correction date, an 8–1,000 character reason and a request key')
  return withOrgTransaction(orgId,async()=>{
    const allowed=await lockActorCommandAuthority(db,orgId,actorId,null,'close.run')
    const old=(await db.execute<{subject_id:string;subsidiary_id:string;payload:{requiredSubsidiaryIds:string[]}}>(sql`select subject_id,subsidiary_id,payload from financial_changes where org_id=${orgId} and idempotency_key=${input.idempotencyKey}`)).rows[0]
    if(old) {
      const required=old.payload.requiredSubsidiaryIds
      if(!Array.isArray(required) || (allowed && required.some(id=>!allowed.has(id))))throw new ScopeNotFoundError()
      const replay=await existingFinancialChange(db,{orgId,subsidiaryId:old.subsidiary_id,domain:'consolidation',subjectId:old.subject_id,operation:'net_investment_oci_reversal',effectiveOn:input.effectiveOn,reason:input.reason,actorId,idempotencyKey:input.idempotencyKey,payload:{sourceChangeId,requiredSubsidiaryIds:required}})
      if(replay)return replay
    }
    const beforeState=await reversalBasis(db,orgId,actorId,sourceChangeId)
    if(input.effectiveOn<beforeState.sourceDate)throw new NetInvestmentError('Use a reversal date on or after the original assessment')
    return proposeFinancialChange(db,{orgId,subsidiaryId:beforeState.subsidiaryId,domain:'consolidation',subjectId:beforeState.interestId,
      operation:'net_investment_oci_reversal',effectiveOn:input.effectiveOn,reason:input.reason,actorId,idempotencyKey:input.idempotencyKey,
      payload:{sourceChangeId,requiredSubsidiaryIds:beforeState.requiredSubsidiaryIds},beforeState})
  })
}
export async function applyNetInvestmentReversal(orgId:string,id:string,actorId:string) {
  return withOrgTransaction(orgId,async()=>{
    const allowed=await lockActorCommandAuthority(db,orgId,actorId,null,'close.run')
    if(!isUuid(id) || !(await db.execute(sql`select id from financial_changes where org_id=${orgId} and id=${id} and domain='consolidation' and operation='net_investment_oci_reversal' for update`)).rows.length)throw new ScopeNotFoundError()
    const change=await loadFinancialChange(db,orgId,id)
    if(change.domain!=='consolidation' || change.operation!=='net_investment_oci_reversal')throw new ScopeNotFoundError()
    const required=change.payload.requiredSubsidiaryIds as string[]
    if(!Array.isArray(required) || (allowed && required.some(entity=>!allowed.has(entity))))throw new ScopeNotFoundError()
    if(change.status==='applied')return change.result!
    const beforeState=await reversalBasis(db,orgId,actorId,String(change.payload.sourceChangeId))
    try{assertFinancialChangeApproved(change,{domain:'consolidation',subjectId:beforeState.interestId,beforeState})}
    catch(error){throw new NetInvestmentError(error instanceof Error ? error.message : 'Independent approval is required')}
    const period=await resolveCoveringPeriod(db,orgId,change.effective_on)
    if(!period)throw new NetInvestmentError('Create an accounting period for the correction date in the original book')
    try{await assertPeriodModulesOpen(db,{orgId,periodId:period.id,bookId:beforeState.record.book_id,subsidiaryIds:required,modules:['gl']})}
    catch(error){if(error instanceof CloseError)throw new NetInvestmentError(`${error.message} — use the controlled reopen workflow in Accounting → Close or an open correction date`);throw error}
    const entry=beforeState.record.journal_entry_id ? await postEntry(db,{orgId,bookId:beforeState.record.book_id,subsidiaryId:beforeState.subsidiaryId,
      entryNumber:`NETINV-REV-${change.id}`,postingDate:change.effective_on,periodId:period.id,origin:'net_investment_oci',actorId,
      reversesEntryId:beforeState.record.journal_entry_id,idempotencyKey:`net-investment-reversal:${change.id}`,
      lines:beforeState.lines.map(line=>({accountId:line.account_id,amount:neg(line.amount),currency:line.currency})),auditChanges:{changeId:id,sourceChangeId:beforeState.sourceChangeId}}) : null
    if(beforeState.record.journal_entry_id)await markEntryReversed(db,{orgId,entryId:beforeState.record.journal_entry_id,actorId})
    if((await db.execute(sql`update net_investment_entries set reversed_by_change_id=${id} where org_id=${orgId} and change_id=${beforeState.sourceChangeId} and reversed_by_change_id is null returning change_id`)).rows.length!==1)
      throw new NetInvestmentError('The source assessment could not be marked corrected — reload it before retrying')
    if((await db.execute(sql`update net_investment_sources set reversed_by_change_id=${id} where org_id=${orgId} and change_id=${beforeState.sourceChangeId} and reversed_by_change_id is null returning source_line_id`)).rows.length!==beforeState.sources.length)
      throw new NetInvestmentError('The corrected source attributions could not be released — reload the assessment before retrying')
    const result={entryIds:entry ? [entry.entryId] : [],sourceChangeId:beforeState.sourceChangeId}
    await completeFinancialChange(db,orgId,id,actorId,result);return result
  })
}

/** Scoped selector for the existing ownership drawer. Qualification and exact
 * source attribution are rechecked by the proposal and apply commands. */
export async function loadNetInvestmentOptions(orgId:string,interestId:string,actorId:string) {
  return withOrgTransaction(orgId,async()=>{
    const allowed=await lockActorCommandAuthority(db,orgId,actorId,null,'close.run');await features(db,orgId)
    const interest=(await db.execute<Pick<Interest,'subsidiary_id'|'parent_subsidiary_id'>>(sql`select subsidiary_id,parent_subsidiary_id from subsidiary_ownership_interests where org_id=${orgId} and id=${interestId} and is_active for share`)).rows[0]
    if(!interest || (allowed && [interest.subsidiary_id,interest.parent_subsidiary_id].some(id=>!allowed.has(id))))throw new ScopeNotFoundError()
    const entities=(await db.execute<Entity & {name:string}>(sql`select id,name,base_currency,is_elimination from subsidiaries where org_id=${orgId} and is_active order by name`)).rows.filter(entity=>allowed===null || allowed.has(entity.id))
    const pairs=(await db.execute<Pair & {label:string}>(sql`select p.id,p.from_subsidiary_id,p.to_subsidiary_id,p.due_from_account_id,p.due_to_account_id,
      creditor.name || ' → ' || debtor.name as label from intercompany_pairs p join subsidiaries creditor on creditor.org_id=p.org_id and creditor.id=p.from_subsidiary_id
      join subsidiaries debtor on debtor.org_id=p.org_id and debtor.id=p.to_subsidiary_id where p.org_id=${orgId} and p.is_active and ${interest.subsidiary_id} in(p.from_subsidiary_id,p.to_subsidiary_id) order by p.id`)).rows.filter(pair=>allowed===null || [pair.from_subsidiary_id,pair.to_subsidiary_id].every(id=>allowed.has(id)))
    const books=(await db.execute<{id:string;name:string}>(sql`select id,name from accounting_books where org_id=${orgId} and is_active and posts_gl and is_primary order by name`)).rows
    const accounts=(await db.execute<{id:string;number:string;name:string;type:string;subsidiary_id:string|null;subsidiary_include_children:boolean}>(sql`select id,number,name,type,subsidiary_id,subsidiary_include_children from accounts where org_id=${orgId} and is_active and not is_summary and type in('equity','income_other','expense_other') order by number`)).rows
    const context=await loadSubsidiaryContext(db,orgId)
    const admissible=accounts.filter(account=>entities.filter(entity=>entity.is_elimination).some(entity=>restrictionAdmits(context,account.subsidiary_id,account.subsidiary_include_children,entity.id)))
    const sources=(await db.execute<{id:string;pairId:string;bookId:string;label:string;postingDate:string}>(sql`select line.id,p.id as "pairId",entry.book_id as "bookId",entry.posting_date::text as "postingDate",
      entry.entry_number || ' — ' || holder.name || ' — ' || account.name || ' ' || line.amount::text || ' ' || holder.base_currency as label
      from journal_lines line join journal_entries entry on entry.org_id=line.org_id and entry.id=line.entry_id
      join subsidiaries holder on holder.org_id=line.org_id and holder.id=line.subsidiary_id join accounts account on account.org_id=line.org_id and account.id=line.account_id
      join intercompany_pairs p on p.org_id=line.org_id and ((p.from_subsidiary_id=line.subsidiary_id and p.due_from_account_id=line.account_id) or (p.to_subsidiary_id=line.subsidiary_id and p.due_to_account_id=line.account_id))
      where line.org_id=${orgId} and entry.origin='fx_revaluation' and entry.status in ('posted','reversed') and p.is_active
        and p.id in (select jsonb_array_elements_text(${JSON.stringify(pairs.map(pair=>pair.id))}::jsonb)::uuid)
        and not exists(select 1 from net_investment_sources used where used.org_id=line.org_id and used.source_line_id=line.id and used.reversed_by_change_id is null)
      order by entry.posting_date desc,entry.entry_number,line.line_number limit 1000`)).rows
    return {pairs,books,accounts:admissible.map(({id,number,name,type})=>({id,number,name,type})),eliminations:entities.filter(entity=>entity.is_elimination),sources}
  })
}
