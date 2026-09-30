import { sql } from 'drizzle-orm'
import { db, withOrgTransaction, type SqlExecutor } from '../platform/db.ts'
import { lockActorCommandAuthority as authority } from '../organization/actor-command-authority.ts'
import { constructionBasis, constructionSubject, measureConstructionLoss, type ConstructionForecast } from './construction.ts'
import { actorHasPermission } from '../organization/actor-permissions.ts'
import { lockAndCheckOrgFeature } from '../organization/org-feature-lock.ts'
import { ScopeNotFoundError } from '../organization/subsidiary-scope.ts'
import { isIsoCalendarDate } from '../platform/business-date.ts'
import { orgReportingFramework, type ReportingFramework } from '../platform/reporting-framework.ts'
import { existingFinancialChange, proposeFinancialChange, loadFinancialChange, assertFinancialChangeApproved, completeFinancialChange } from '../platform/financial-changes.ts'
import { resolveCoveringPeriod } from '../periods/period-resolution.ts'
import { assertPeriodModulesOpen, CloseError } from '../periods/period-policy.ts'
import { postEntry } from '../journal/post-entry.ts'
import { add, neg, isZero, normalizeMoney } from '../money/money.ts'
import { measureProvision, ProvisionError, type ProvisionAssessment } from './measurement.ts'

export type ProvisionIdentity = {
  id: string
  subsidiaryId: string
  bookId: string
  name: string
  currency: string
  expenseAccountId: string
  liabilityAccountId: string
  projectId?: string | null
}

export interface ProvisionProposal {
  obligation: ProvisionIdentity
  effectiveOn: string
  reason: string
  idempotencyKey: string
  assessment: ProvisionAssessment
  construction?: ConstructionForecast
}


function visibleEntity(column: ReturnType<typeof sql>, allowed: Set<string> | null) {
  if (allowed === null) return sql``
  if (!allowed.size) return sql`and false`
  return sql`and ${column} in (${sql.join([...allowed].map(id => sql`${id}::uuid`), sql`, `)})`
}

/** Scoped native editor choices, using the same account types enforced by
 * the command. All selected values are revalidated inside its write. */
export async function provisionEditorOptions(orgId: string, actorId: string) {
  return withOrgTransaction(orgId, async () => {
    const allowed = await authority(db, orgId, actorId, null, 'gl.manage')
    const subsidiaries = (await db.execute<{ id: string; name: string; currency: string }>(sql`
      select id,name,base_currency as currency from subsidiaries where org_id=${orgId}
        and is_active and not is_elimination ${visibleEntity(sql`id`, allowed)} order by name,id
    `)).rows
    const books = (await db.execute<{ id: string; name: string }>(sql`
      select id,name from accounting_books where org_id=${orgId} and is_active and posts_gl order by name,id
    `)).rows
    const accounts = (await db.execute<{ id: string; name: string; type: string }>(sql`
      select id,concat_ws(' — ',number,name) as name,type from accounts where org_id=${orgId}
        and is_active and not is_summary and type in ('expense','expense_other','liability_current_other','liability_long_term')
        order by number,name,id
    `)).rows
    const projects = await actorHasPermission(db,orgId,actorId,'projects.read') && await lockAndCheckOrgFeature(db,orgId,'projects')
      ? (await db.execute<{id:string;name:string;subsidiaryId:string}>(sql`select id,concat_ws(' — ',code,name) as name,subsidiary_id as "subsidiaryId" from projects
        where org_id=${orgId} and is_active and contract_value is not null ${visibleEntity(sql`subsidiary_id`,allowed)} order by code,id`)).rows : []
    return { subsidiaries, books, accounts, projects, reportingFramework: await framework(db, orgId) }
  })
}

export async function readProvisionObligation(orgId: string, actorId: string, id: string) {
  return withOrgTransaction(orgId, async () => {
    const allowed = await authority(db, orgId, actorId, null, 'gl.read')
    const identity = (await db.execute<ProvisionIdentity>(sql`
      select id,subsidiary_id as "subsidiaryId",book_id as "bookId",name,currency,
        expense_account_id as "expenseAccountId",liability_account_id as "liabilityAccountId",project_id as "projectId"
        from provision_obligations where org_id=${orgId} and id=${id} ${visibleEntity(sql`subsidiary_id`, allowed)}
    `)).rows[0]
    if (!identity) throw new ScopeNotFoundError()
    if (identity.projectId) await constructionSubject(db,orgId,actorId,identity,true)
    const assessments = (await db.execute<{ id: string; effectiveOn: string; reason: string; status: string; assessment: ProvisionAssessment; result: Record<string, unknown> | null }>(sql`
      select id,effective_on::text as "effectiveOn",reason,status,payload->'assessment' as assessment,result
        from financial_changes where org_id=${orgId} and domain='provision' and subject_id=${id}
        order by effective_on desc,created_at desc,id desc
    `)).rows
    return { identity, assessments }
  })
}

async function framework(tx: SqlExecutor, orgId: string): Promise<ReportingFramework> {
  // The authoritative setting is pinned through commit. Missing policy is
  // unknown here; it must never silently select a recognition framework.
  try { return await orgReportingFramework(orgId, { runner: tx, requireConfigured: true, lock: true }) }
  catch (error) { throw new ProvisionError(error instanceof Error ? error.message : 'Choose the financial reporting framework in Company Settings') }
}

async function lockIdentity(tx: SqlExecutor, orgId: string, actorId: string, identity: ProvisionIdentity, create: boolean) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`provision:${orgId}:${identity.id}`},0))`)
  const prior = (await tx.execute<ProvisionIdentity>(sql`
    select id,subsidiary_id as "subsidiaryId",book_id as "bookId",name,currency,
      expense_account_id as "expenseAccountId",liability_account_id as "liabilityAccountId",project_id as "projectId"
      from provision_obligations where org_id=${orgId} and id=${identity.id} for update
  `)).rows[0]
  if (prior) {
    if (Object.keys(prior).some(key => (prior[key as keyof ProvisionIdentity] ?? null) !== (identity[key as keyof ProvisionIdentity] ?? null)))
      throw new ProvisionError('The provision accounting identity differs from the original obligation — use its existing identity or create a separate obligation')
    return prior
  }
  if (!create) throw new ScopeNotFoundError()
  if (!identity.name.trim() || identity.name.length > 200)
    throw new ProvisionError('Name the provision obligation using 1–200 characters')
  const entity = (await tx.execute<{ currency: string }>(sql`select base_currency as currency from subsidiaries
    where org_id=${orgId} and id=${identity.subsidiaryId} and is_active and not is_elimination for share`)).rows[0]
  if (!entity || entity.currency !== identity.currency)
    throw new ProvisionError('Use the active legal entity and its functional currency for this provision')
  const book = (await tx.execute(sql`select id from accounting_books where org_id=${orgId} and id=${identity.bookId}
    and is_active and posts_gl for share`)).rows[0]
  if (!book) throw new ProvisionError('Choose an active posting accounting book for this provision')
  const accounts = (await tx.execute<{ id: string; type: string }>(sql`
    select id,type from accounts where org_id=${orgId}
      and id in (${identity.expenseAccountId},${identity.liabilityAccountId}) and is_active and not is_summary order by id for share
  `)).rows
  if (accounts.length !== 2 || !['expense', 'expense_other'].includes(accounts.find(a => a.id === identity.expenseAccountId)?.type ?? '')
      || !['liability_current_other', 'liability_long_term'].includes(accounts.find(a => a.id === identity.liabilityAccountId)?.type ?? ''))
    throw new ProvisionError('Choose distinct active posting expense and liability accounts for the provision')
  const inserted = await tx.execute(sql`insert into provision_obligations
    (id,org_id,subsidiary_id,book_id,name,currency,expense_account_id,liability_account_id,created_by,project_id)
    values (${identity.id},${orgId},${identity.subsidiaryId},${identity.bookId},${identity.name},${identity.currency},
      ${identity.expenseAccountId},${identity.liabilityAccountId},${actorId},${identity.projectId ?? null}) returning id`)
  if (inserted.rows.length !== 1) throw new ProvisionError('The provision obligation could not be recorded — reload and retry')
  await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
    values (${orgId},'provision_obligations',${identity.id},'insert',${JSON.stringify({ before: null, after: identity })}::jsonb,${actorId})`)
  return identity
}

async function basis(tx: SqlExecutor, orgId: string, actorId: string, identity: ProvisionIdentity, effectiveOn: string) {
  const reportingFramework = await framework(tx, orgId)
  const period = await resolveCoveringPeriod(tx, orgId, effectiveOn)
  if (!period) throw new ProvisionError('Create the regular accounting period covering the assessment date in the active posting calendar')
  const events = (await tx.execute<{ id: string; effective_on: string; status: string; result: Record<string, unknown> }>(sql`
    select id,effective_on::text,status,result from financial_changes where org_id=${orgId}
      and domain='provision' and subject_id=${identity.id} and status='applied' order by effective_on,id
  `)).rows
  if (events.some(event => event.effective_on > effectiveOn))
    throw new ProvisionError('A later assessment has already been applied — use its date or a later date for the correcting assessment')
  // Reversed journal headers remain accounting history: their original legs
  // and the separately posted reversing legs must both participate.
  const balance = (await tx.execute<{ amount: string }>(sql`
    select coalesce(sum(-line.amount),0)::text as amount from journal_lines line
      join journal_entries entry on entry.org_id=line.org_id and entry.id=line.entry_id
     where line.org_id=${orgId} and entry.book_id=${identity.bookId} and line.subsidiary_id=${identity.subsidiaryId}
       and line.account_id=${identity.liabilityAccountId} and line.custom->>'provisionId'=${identity.id} and entry.status in ('posted','reversed')
  `)).rows[0]!.amount
  return { identity, reportingFramework, periodId: period.id, balance: normalizeMoney(balance), events,
    construction:await constructionBasis(tx,orgId,actorId,identity,effectiveOn) }
}

/** A proposal and its immutable obligation commit together. Submission uses
 * the existing Accounting event Flows approval path; this never self-approves. */
export async function proposeProvisionAssessment(orgId: string, actorId: string, input: ProvisionProposal): Promise<string> {
  if (!isIsoCalendarDate(input.effectiveOn)) throw new ProvisionError('Enter a calendar assessment date (YYYY-MM-DD)')
  if (typeof input.reason !== 'string' || input.reason.trim().length < 8 || input.reason.trim().length > 1000)
    throw new ProvisionError('Record an assessment reason using 8–1,000 characters')
  if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey || input.idempotencyKey.length > 120)
    throw new ProvisionError('Provide an assessment request key using 1–120 characters')
  return withOrgTransaction(orgId, async () => {
    const tx = db
    await authority(tx, orgId, actorId, input.obligation.subsidiaryId, 'gl.manage')
    const identity = await lockIdentity(tx, orgId, actorId, {...input.obligation,projectId:input.obligation.projectId ?? null}, true)
    if (Boolean(identity.projectId) !== Boolean(input.construction)) throw new ProvisionError('A project obligation requires its construction forecast; generic provisions cannot carry an unrelated project forecast')
    if (identity.projectId) await constructionSubject(tx,orgId,actorId,identity)
    const payload = { assessment: input.assessment, ...(input.construction ? {construction:input.construction} : {}), requiredSubsidiaryIds: [identity.subsidiaryId] }
    const proposal = { orgId, subsidiaryId: identity.subsidiaryId, domain: 'provision' as const,
      subjectId: identity.id, operation: 'provision_assessment', effectiveOn: input.effectiveOn,
      reason: input.reason, actorId, idempotencyKey: input.idempotencyKey, payload }
    const prior = await existingFinancialChange(tx, proposal)
    if (prior) return prior
    const beforeState = await basis(tx, orgId, actorId, identity, input.effectiveOn)
    measureProvision(beforeState.reportingFramework, beforeState.construction
      ? measureConstructionLoss(beforeState.reportingFramework,beforeState.construction,input.construction!,input.assessment).assessment : input.assessment)
    return proposeFinancialChange(tx, { ...proposal, beforeState })
  })
}

/** Approved reviews post only the delta to the existing liability. The
 * frozen balance and assessment history refuse stale or reordered approvals. */
export async function applyProvisionAssessment(orgId: string, changeId: string, actorId: string) {
  return withOrgTransaction(orgId, async () => {
    const tx = db
    if (!(await tx.execute(sql`select id from financial_changes where org_id=${orgId} and id=${changeId} and domain='provision' for update`)).rows.length)
      throw new ScopeNotFoundError()
    const change = await loadFinancialChange(tx, orgId, changeId)
    if (change.domain !== 'provision' || change.operation !== 'provision_assessment')
      throw new ScopeNotFoundError()
    await authority(tx, orgId, actorId, change.subsidiary_id, 'gl.post')
    const identity = change.before_state.identity as ProvisionIdentity
    if (!identity || identity.id !== change.subject_id || identity.subsidiaryId !== change.subsidiary_id)
      throw new ProvisionError('The assessment identity is incomplete — reject it and propose a new assessment')
    await lockIdentity(tx, orgId, actorId, identity, false)
    if (identity.projectId) await constructionBasis(tx,orgId,actorId,identity,change.effective_on)
    if (change.status === 'applied') return change.result!
    const beforeState = await basis(tx, orgId, actorId, identity, change.effective_on)
    try { assertFinancialChangeApproved(change, { domain: 'provision', subjectId: identity.id, beforeState }) }
    catch (error) { throw new ProvisionError(error instanceof Error ? error.message : 'Independent approval is required') }
    // A zero-delta review still changes reporting evidence. Closed-period
    // protection applies even when no journal would otherwise be necessary.
    try {
      await assertPeriodModulesOpen(tx, { orgId, periodId: beforeState.periodId, bookId: identity.bookId,
        subsidiaryIds: [identity.subsidiaryId], modules: [] })
    } catch (error) {
      if (error instanceof CloseError) throw new ProvisionError(`${error.message} — use an open assessment date or the controlled reopen workflow in Accounting → Close`)
      throw error
    }
    const construction = beforeState.construction ? measureConstructionLoss(beforeState.reportingFramework,beforeState.construction,change.payload.construction as ConstructionForecast,change.payload.assessment as ProvisionAssessment) : null
    const measurement = {...measureProvision(beforeState.reportingFramework, construction?.assessment ?? change.payload.assessment as ProvisionAssessment),...(construction ? {construction} : {})}
    const delta = add(measurement.liability, neg(beforeState.balance))
    const posted = isZero(delta) ? null : await postEntry(tx, {
      orgId, bookId: identity.bookId, subsidiaryId: identity.subsidiaryId,
      entryNumber: `PROVISION-${change.id}`, postingDate: change.effective_on, periodId: beforeState.periodId,
      memo: `${identity.name}: ${change.reason}`, origin: 'provision', currency: identity.currency, actorId,
      idempotencyKey: `provision-assessment:${change.id}`,
      custom: { provisionId: identity.id, assessmentId: change.id, measurement },
      lines: [
        { accountId: identity.expenseAccountId, amount: delta, projectId:identity.projectId ?? undefined, custom: { provisionId: identity.id } },
        { accountId: identity.liabilityAccountId, amount: neg(delta), projectId:identity.projectId ?? undefined, custom: { provisionId: identity.id } },
      ],
    })
    const result = { ...measurement, priorLiability: beforeState.balance, currentPeriodCharge: delta, entryId: posted?.entryId ?? null }
    await completeFinancialChange(tx, orgId, changeId, actorId, result)
    return result
  })
}
