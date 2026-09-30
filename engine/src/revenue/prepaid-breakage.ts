import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db,withOrgTransaction } from '../platform/db.ts'
import { existingFinancialChange,proposeFinancialChange,loadFinancialChange,assertFinancialChangeApproved,completeFinancialChange } from '../platform/financial-changes.ts'
import { isIsoCalendarDate } from '../platform/business-date.ts'
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts'
import { lockAndCheckOrgFeature } from '../organization/org-feature-lock.ts'
import { ScopeNotFoundError,subsidiaryVisibleFilter } from '../organization/subsidiary-scope.ts'
import { resolveCoveringPeriod } from '../periods/period-resolution.ts'
import { assertPeriodModulesOpen,CloseError } from '../periods/period-policy.ts'
import { canonicalDecimal } from '../money/exact-decimal.ts'
import { add,cmp,fromUnits,isZero,neg,normalizeMoney,roundDiv,sum,toUnits } from '../money/money.ts'
import { lockRevenueContract } from './recognition-schedule-build.ts'
import { recordRecognitionEvent } from './recognition-events.ts'

export class BreakageError extends Error {readonly status=422; readonly name='BreakageError'}
export interface BreakageEstimate {
  method:'expected_proportional'|'remaining_use_remote'
  expectedBreakage:string
  entitled:boolean
  meetsReversalConstraint:boolean
  thirdPartyObligation:boolean
  evidence:string
}
export interface BreakageProposal {
  grantId:string
  effectiveOn:string
  reason:string
  idempotencyKey:string
  estimate:BreakageEstimate
}
async function features(orgId:string) {
  if (!await lockAndCheckOrgFeature(db,orgId,'usageBilling') || !await lockAndCheckOrgFeature(db,orgId,'revenueRecognition'))
    throw new BreakageError('Turn on Usage Billing and Revenue Recognition in Company Settings → Features before assessing prepaid breakage')
}
async function source(orgId:string,grantId:string,allowed:ReadonlySet<string>|null=null) {
  const row=(await db.execute<{grant_id:string;amount:string;currency:string;obligation_id:string;contract_id:string;subsidiary_id:string;document_id:string;allocated_price:string;line_amount:string;source_line_id:string}>(sql`
    select grant_record.id as grant_id,grant_record.amount::text,grant_record.currency_code as currency,
      obligation.id as obligation_id,obligation.contract_id,coalesce(contract.subsidiary_id,line.subsidiary_id,document.subsidiary_id) as subsidiary_id,
      document.id as document_id,obligation.allocated_price::text,line.amount::text as line_amount,line.id as source_line_id
    from usage_prepaid_grants grant_record join document_lines line on line.org_id=grant_record.org_id and line.id=grant_record.source_document_line_id
      join documents document on document.org_id=line.org_id and document.id=line.document_id
      join performance_obligations obligation on obligation.org_id=line.org_id and obligation.document_line_id=line.id
      join revenue_contracts contract on contract.org_id=obligation.org_id and contract.id=obligation.contract_id
      join recognition_rules rule on rule.org_id=obligation.org_id and rule.id=obligation.recognition_rule_id
    where grant_record.org_id=${orgId} and grant_record.id=${grantId} and document.kind='customer_invoice' and document.status='posted'
      and rule.method='usage' and obligation.status<>'cancelled' and contract.status<>'cancelled'
      and not exists(select 1 from recognition_schedules schedule where schedule.org_id=obligation.org_id and schedule.obligation_id=obligation.id and schedule.change_basis->>'retired'='true')
      ${subsidiaryVisibleFilter(sql`coalesce(contract.subsidiary_id,line.subsidiary_id,document.subsidiary_id)`,allowed)}`)).rows
  if (row.length!==1 || !row[0]!.subsidiary_id) throw new ScopeNotFoundError()
  return row[0]!
}
async function lockSource(orgId:string,grantId:string) {
  const initial=await source(orgId,grantId)
  // All usage plan writers own the contract mutex. Hold it before the grant
  // and obligation row locks so estimates cannot race plan rebuilding.
  await lockRevenueContract(db,orgId,initial.contract_id)
  await db.execute(sql`select id from usage_prepaid_grants where org_id=${orgId} and id=${grantId} for update`)
  await db.execute(sql`select id from performance_obligations where org_id=${orgId} and id=${initial.obligation_id} for update`)
  const current=await source(orgId,grantId)
  if (JSON.stringify(current)!==JSON.stringify(initial)) throw new BreakageError('The prepaid obligation changed — reload the source invoice before preparing this estimate')
  return current
}
async function basis(orgId:string,grantId:string,date:string) {
  const grant=await lockSource(orgId,grantId)
  const draws=(await db.execute<{id:string;amount:string}>(sql`select id,amount::text from usage_prepaid_draws where org_id=${orgId} and grant_id=${grantId} and period_month<=${date}::date order by id`)).rows
  const events=(await db.execute<{id:string;amount:string}>(sql`select id,amount::text from recognition_events where org_id=${orgId} and obligation_id=${grant.obligation_id}
    and source_reference like 'prepaid-breakage:%' order by id`)).rows
  const estimates=(await db.execute<{id:string;effective_on:string}>(sql`select id,effective_on::text from financial_changes where org_id=${orgId} and domain='revenue' and operation='expected_breakage_estimate'
    and subject_id=${grant.contract_id} and status='applied' and payload->>'grantId' in
      (select id::text from usage_prepaid_grants where org_id=${orgId} and source_document_line_id=${grant.source_line_id}) order by effective_on,id`)).rows
  if (estimates.some(row=>row.effective_on>date)) throw new BreakageError('A later breakage estimate is already applied — use that date or a later date for the correcting assessment')
  const pool=(await db.execute<{id:string;amount:string;drawn:string}>(sql`select grant_record.id,grant_record.amount::text,
    coalesce((select sum(amount) from usage_prepaid_draws draw where draw.org_id=grant_record.org_id and draw.grant_id=grant_record.id and draw.period_month<=${date}::date),0)::text as drawn
    from usage_prepaid_grants grant_record where grant_record.org_id=${orgId} and grant_record.source_document_line_id=${grant.source_line_id} order by grant_record.id`)).rows
  const policies=(await db.execute<{grant_id:string;estimate:BreakageEstimate}>(sql`select distinct on(payload->>'grantId') payload->>'grantId' as grant_id,payload->'estimate' as estimate
    from financial_changes where org_id=${orgId} and domain='revenue' and operation='expected_breakage_estimate' and subject_id=${grant.contract_id} and status='applied'
      and payload->>'grantId' in (select id::text from usage_prepaid_grants where org_id=${orgId} and source_document_line_id=${grant.source_line_id})
    order by payload->>'grantId',effective_on desc,jsonb_array_length(before_state->'estimates') desc,created_at desc,id desc`)).rows
  return {grant,draws,events,estimates,pool,policies,drawn:sum(draws.map(row=>row.amount)),recognizedBreakage:sum(events.map(row=>row.amount))}
}
function measure(amount:string,drawn:string,estimate:BreakageEstimate) {
  const parsed=canonicalDecimal(estimate.expectedBreakage)
  if (!['expected_proportional','remaining_use_remote'].includes(estimate.method)) throw new BreakageError('Choose proportional expected breakage or a supported remote-use assessment')
  if (parsed===null || cmp(parsed,'0')<0 || cmp(parsed,amount)>0 || (estimate.method==='expected_proportional' && cmp(parsed,amount)>=0))
    throw new BreakageError('Expected proportional breakage must be below the original grant amount; a remote-use assessment measures the remaining unexercised rights')
  if (typeof estimate.entitled!=='boolean' || typeof estimate.meetsReversalConstraint!=='boolean' || typeof estimate.thirdPartyObligation!=='boolean'
    || typeof estimate.evidence!=='string' || estimate.evidence.trim().length<40 || estimate.evidence.length>10000)
    throw new BreakageError('Document entitlement, the significant-reversal constraint and unclaimed-property obligations with 40–10,000 characters of supporting evidence')
  if (cmp(drawn,'0')<0 || cmp(drawn,amount)>0) throw new BreakageError('Reconcile the prepaid grant draws and reversals before assessing breakage')
  const eligible=estimate.entitled && estimate.meetsReversalConstraint && !estimate.thirdPartyObligation
  const expectedRedemptions=add(amount,neg(parsed))
  if (estimate.method==='remaining_use_remote') {
    const remaining=add(amount,neg(drawn))
    if (cmp(parsed,remaining)!==0) throw new BreakageError('A remote-use assessment must measure the current remaining rights — revise and approve the estimate on the Revenue contract after any draw or reversal')
    return {eligible,expectedRedemptions:drawn,target:eligible ? remaining : '0.0000'}
  }
  if (eligible && cmp(drawn,expectedRedemptions)>0)
    throw new BreakageError(`Customer use of ${drawn} exceeds this estimate’s expected total redemptions of ${expectedRedemptions} — approve a revised breakage estimate on the Revenue contract before committing further draws`)
  return {eligible,expectedRedemptions,target:eligible ? fromUnits(roundDiv(toUnits(parsed)*toUnits(drawn),toUnits(expectedRedemptions))) : '0.0000'}
}
async function ensureOpen(orgId:string,grant:Awaited<ReturnType<typeof source>>,date:string) {
  const period=await resolveCoveringPeriod(db,orgId,date)
  if (!period) throw new BreakageError('Create an open accounting period covering the breakage assessment date')
  const books=(await db.execute<{id:string}>(sql`select distinct book.id from recognition_schedules schedule join accounting_books book on book.org_id=schedule.org_id and book.id=schedule.book_id
    where schedule.org_id=${orgId} and schedule.obligation_id=${grant.obligation_id} and book.is_active and book.posts_gl order by book.id`)).rows
  if (!books.length) throw new BreakageError('Restore the prepaid obligation’s native recognition schedules before assessing breakage')
  try {for (const book of books) await assertPeriodModulesOpen(db,{orgId,periodId:period.id,bookId:book.id,subsidiaryIds:[grant.subsidiary_id],modules:[]})}
  catch(error){if(error instanceof CloseError)throw new BreakageError(`${error.message} — use an open assessment date or the controlled reopen workflow in Accounting → Close`);throw error}
}
async function adjustEvents(orgId:string,current:Awaited<ReturnType<typeof basis>>,estimate:BreakageEstimate,date:string,policyId:string,actorId:string|null) {
  const measurement=measure(current.grant.amount,current.drawn,estimate)
  // Grants are denominated in billed credit value. Financial recognition
  // uses the source promise's allocated price. Pool before rounding so many
  // small grants cannot lose or invent the source's allocation residual.
  const faceTargets=current.pool.map(grant=>{
    const policy=grant.id===current.grant.grant_id ? estimate : current.policies.find(policy=>policy.grant_id===grant.id)?.estimate
    return policy ? measure(grant.amount,grant.drawn,policy).target : '0.0000'
  })
  const sourceTarget=allocatedAmount(current.grant.allocated_price,current.grant.line_amount,sum(faceTargets))
  const target=allocatedAmount(current.grant.allocated_price,current.grant.line_amount,measurement.target)
  const delta=add(sourceTarget,neg(current.recognizedBreakage))
  await ensureOpen(orgId,current.grant,date)
  let eventId:string|null=null
  if (!isZero(delta)) {
    const fingerprint=createHash('sha256').update(JSON.stringify({policyId,date,draws:current.draws,events:current.events})).digest('hex')
    eventId=(await recordRecognitionEvent({orgId,actorId,obligationId:current.grant.obligation_id,periodMonth:date.slice(0,7)+'-01',amount:delta,
      description:'Expected prepaid breakage under the approved estimate',sourceReference:`prepaid-breakage:${current.grant.grant_id}:${policyId}:${fingerprint}`})).eventId
  }
  return {...measurement,target,sourceRecognitionTarget:sourceTarget,expectedBreakage:normalizeMoney(estimate.expectedBreakage),drawn:current.drawn,currentAdjustment:delta,eventId}
}
export async function proposeExpectedBreakage(orgId:string,actorId:string,input:BreakageProposal) {
  if (typeof input.reason!=='string' || input.reason.trim().length<8 || input.reason.trim().length>1000 || typeof input.idempotencyKey!=='string' || !input.idempotencyKey || input.idempotencyKey.length>120)
    throw new BreakageError('Record an assessment reason of 8–1,000 characters and a request key of 1–120 characters')
  if (!isIsoCalendarDate(input.effectiveOn)) throw new BreakageError('Enter a valid calendar assessment date')
  return withOrgTransaction(orgId,async()=> {
    const allowed=await lockActorCommandAuthority(db,orgId,actorId,null,'ar.post')
    await features(orgId)
    const initial=await source(orgId,input.grantId,allowed)
    await lockActorCommandAuthority(db,orgId,actorId,initial.subsidiary_id,'ar.post')
    const proposal={orgId,subsidiaryId:initial.subsidiary_id,domain:'revenue' as const,subjectId:initial.contract_id,
      operation:'expected_breakage_estimate',effectiveOn:input.effectiveOn,reason:input.reason,actorId,idempotencyKey:input.idempotencyKey,
      payload:{grantId:input.grantId,estimate:input.estimate,requiredSubsidiaryIds:[initial.subsidiary_id]}}
    const prior=await existingFinancialChange(db,proposal)
    if (prior) return prior
    const current=await basis(orgId,input.grantId,input.effectiveOn)
    measure(current.grant.amount,current.drawn,input.estimate)
    return proposeFinancialChange(db,{...proposal,beforeState:current})
  })
}
export async function applyExpectedBreakage(orgId:string,changeId:string,actorId:string) {
  return withOrgTransaction(orgId,async()=> {
    await lockActorCommandAuthority(db,orgId,actorId,null,'ar.post')
    await features(orgId)
    if (!(await db.execute(sql`select id from financial_changes where org_id=${orgId} and id=${changeId} and domain='revenue' and operation='expected_breakage_estimate' for update`)).rows.length) throw new ScopeNotFoundError()
    const change=await loadFinancialChange(db,orgId,changeId)
    await lockActorCommandAuthority(db,orgId,actorId,change.subsidiary_id,'ar.post')
    if (change.status==='applied') return change.result!
    const current=await basis(orgId,String(change.payload.grantId),change.effective_on)
    if (current.grant.contract_id!==change.subject_id || current.grant.subsidiary_id!==change.subsidiary_id) throw new ScopeNotFoundError()
    try {assertFinancialChangeApproved(change,{domain:'revenue',subjectId:change.subject_id,beforeState:current})}
    catch(error){throw new BreakageError(error instanceof Error ? error.message : 'Independent approval is required')}
    const result=await adjustEvents(orgId,current,change.payload.estimate as unknown as BreakageEstimate,change.effective_on,change.id,actorId)
    await completeFinancialChange(db,orgId,change.id,actorId,result)
    return result
  })
}
/** Draw and reversal writers call this inside their transaction. Policy is
 * immutable approval evidence; new exercised rights append a native usage
 * recognition adjustment rather than a parallel deferred-revenue journal. */
export async function refreshPrepaidBreakage(orgId:string,grantId:string,periodMonth:string) {
  // Each approved revision freezes all prior applied estimates. Its
  // predecessor count orders same-day revisions even when timestamps tie.
  const policy=(await db.execute<{id:string;effective_on:string;estimate:BreakageEstimate}>(sql`select id,effective_on::text,payload->'estimate' as estimate from financial_changes
    where org_id=${orgId} and domain='revenue' and operation='expected_breakage_estimate' and payload->>'grantId'=${grantId} and status='applied'
    order by effective_on desc,jsonb_array_length(before_state->'estimates') desc,created_at desc,id desc limit 1`)).rows[0]
  if (!policy) return
  await features(orgId)
  const date=periodMonth>policy.effective_on ? periodMonth : policy.effective_on
  const current=await basis(orgId,grantId,date)
  return adjustEvents(orgId,current,policy.estimate,date,policy.id,null)
}

/** Draw writers acquire the native contract mutex before grant row locks,
 * including when the first estimate has not been approved yet. */
export async function lockPrepaidRecognitionContract(orgId:string,grantId:string) {
  const rows=(await db.execute<{contract_id:string}>(sql`select distinct obligation.contract_id from usage_prepaid_grants grant_record
    join performance_obligations obligation on obligation.org_id=grant_record.org_id and obligation.document_line_id=grant_record.source_document_line_id
    where grant_record.org_id=${orgId} and grant_record.id=${grantId} order by obligation.contract_id`)).rows
  for (const row of rows) await lockRevenueContract(db,orgId,row.contract_id)
}

export async function breakageGrantOptions(orgId:string,actorId:string,contractId:string) {
  return withOrgTransaction(orgId,async()=> {
    const allowed=await lockActorCommandAuthority(db,orgId,actorId,null,'ar.post')
    if (!await lockAndCheckOrgFeature(db,orgId,'usageBilling') || !await lockAndCheckOrgFeature(db,orgId,'revenueRecognition')) return []
    return (await db.execute<{id:string;amount:string;currency:string;description:string}>(sql`
      select grant_record.id,grant_record.amount::text,grant_record.currency_code as currency,obligation.description
      from usage_prepaid_grants grant_record join document_lines line on line.org_id=grant_record.org_id and line.id=grant_record.source_document_line_id
        join documents document on document.org_id=line.org_id and document.id=line.document_id
        join performance_obligations obligation on obligation.org_id=line.org_id and obligation.document_line_id=line.id
        join revenue_contracts contract on contract.org_id=obligation.org_id and contract.id=obligation.contract_id
        join recognition_rules rule on rule.org_id=obligation.org_id and rule.id=obligation.recognition_rule_id
      where grant_record.org_id=${orgId} and contract.id=${contractId} and rule.method='usage' and document.status='posted'
        and obligation.status<>'cancelled' and contract.status<>'cancelled'
        and not exists(select 1 from recognition_schedules schedule where schedule.org_id=obligation.org_id and schedule.obligation_id=obligation.id and schedule.change_basis->>'retired'='true')
        ${subsidiaryVisibleFilter(sql`coalesce(contract.subsidiary_id,line.subsidiary_id,document.subsidiary_id)`,allowed)}
      order by obligation.description,grant_record.id`)).rows
  })
}

function allocatedAmount(price:string,face:string,exercised:string) {
  if (cmp(face,'0')<=0 || cmp(price,'0')<0) throw new BreakageError('The prepaid invoice requires a positive billed value and a valid allocated price — review its native revenue allocation before recognizing usage')
  return fromUnits(roundDiv(toUnits(price)*toUnits(exercised),toUnits(face)))
}

/** The native usage writer calls this after appending its draw or reversal.
 * Cumulative source allocation owns rounding across every grant on the same
 * promise; billed credit amounts are not a second transaction price. */
export async function prepaidRecognitionAdjustment(orgId:string,grantId:string) {
  const rows=(await db.execute<{obligation_id:string;allocated_price:string;line_amount:string;drawn:string;recognized:string}>(sql`
    select obligation.id as obligation_id,obligation.allocated_price::text,line.amount::text as line_amount,
      coalesce((select sum(draw.amount) from usage_prepaid_draws draw join usage_prepaid_grants sibling on sibling.org_id=draw.org_id and sibling.id=draw.grant_id
        where sibling.org_id=line.org_id and sibling.source_document_line_id=line.id),0)::text as drawn,
      coalesce((select sum(event.amount) from recognition_events event where event.org_id=obligation.org_id and event.obligation_id=obligation.id
        and event.source_reference like 'usage-run:%:grant:%'),0)::text as recognized
    from usage_prepaid_grants grant_record join document_lines line on line.org_id=grant_record.org_id and line.id=grant_record.source_document_line_id
      join performance_obligations obligation on obligation.org_id=line.org_id and obligation.document_line_id=line.id
    where grant_record.org_id=${orgId} and grant_record.id=${grantId} and obligation.status<>'cancelled'
      and not exists(select 1 from recognition_schedules schedule where schedule.org_id=obligation.org_id and schedule.obligation_id=obligation.id and schedule.change_basis->>'retired'='true')`)).rows
  if(rows.length!==1)throw new BreakageError('Restore the source invoice’s single live usage obligation through Revenue before recognizing its prepaid draws')
  const row=rows[0]!
  return add(allocatedAmount(row.allocated_price,row.line_amount,row.drawn),neg(row.recognized))
}
