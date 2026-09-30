import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { SqlExecutor } from '../platform/db.ts'
import type { ReportingFramework } from '../platform/reporting-framework.ts'
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts'
import { featureEnabled } from '../organization/feature-registry.ts'
import { lockAndCheckOrgFeature } from '../organization/org-feature-lock.ts'
import { ScopeNotFoundError } from '../organization/subsidiary-scope.ts'
import { add, cmp, neg, normalizeMoney, sum } from '../money/money.ts'
import { ProvisionError, provisionMoney, type ProvisionAssessment } from './measurement.ts'
import type { ProvisionIdentity } from './assessments.ts'

export interface ConstructionForecast {
  remainingCost: string
  terminationAvailable: boolean
  terminationCost: string | null
  relatedAssetsReviewed: boolean
  impairmentEvidence: string
}

/** Forecast inputs are approved evidence, not a replacement for the native
 * contract value or posted project results. Repeated reviews recognize only
 * the liability still required after losses already expensed on the project. */
export async function constructionSubject(tx: SqlExecutor, orgId: string, actorId: string, identity: ProvisionIdentity, reading = false) {
  if (!identity.projectId) return null
  await lockActorCommandAuthority(tx,orgId,actorId,identity.subsidiaryId,'projects.read')
  if (!await lockAndCheckOrgFeature(tx,orgId,'projects'))
    throw reading ? new ScopeNotFoundError() : new ProvisionError('Turn on Projects in Company Settings → Features before assessing a construction contract')
  const project = (await tx.execute<{id:string;name:string;contract_value:string|null;status:string}>(sql`
    select id,name,contract_value::text,status from projects where org_id=${orgId} and id=${identity.projectId}
      and subsidiary_id=${identity.subsidiaryId} ${reading ? sql`for share` : sql`for update`}`)).rows[0]
  if (!project) throw new ScopeNotFoundError()
  return project
}

export async function constructionBasis(tx: SqlExecutor, orgId: string, actorId: string, identity: ProvisionIdentity, date: string) {
  const project = await constructionSubject(tx,orgId,actorId,identity)
  if (!project) return null
  if (!['awarded','active','substantially_complete','closed','cancelled'].includes(project.status) || project.contract_value === null)
    throw new ProvisionError('Record the agreed construction contract value on the awarded project before forecasting its loss')
  const contractValue = provisionMoney(project.contract_value,'Agreed project contract value')
  // The liability's own charge is excluded: treating that provision as a
  // newly incurred contract cost would recognize the same forecast twice.
  // New project legs take the project's FK key-share lock, which conflicts
  // with the subject update lock. Pin existing headers and lines as well: a
  // draft journal may already carry its project FK before being posted.
  await tx.execute(sql`select entry.id from journal_entries entry where entry.org_id=${orgId}
    and exists(select 1 from journal_lines line where line.org_id=entry.org_id and line.entry_id=entry.id and line.project_id=${identity.projectId})
    order by entry.id for share`)
  await tx.execute(sql`select id from journal_lines where org_id=${orgId} and project_id=${identity.projectId} order by id for share`)
  const rows = (await tx.execute<{id:string;amount:string;type:string}>(sql`
    select line.id,line.amount::text,account.type from journal_lines line
      join journal_entries entry on entry.org_id=line.org_id and entry.id=line.entry_id
      join accounts account on account.org_id=line.org_id and account.id=line.account_id
    where line.org_id=${orgId} and line.project_id=${identity.projectId} and line.subsidiary_id=${identity.subsidiaryId}
      and entry.book_id=${identity.bookId} and entry.status in ('posted','reversed') and entry.posting_date<=${date}::date
      and account.type in ('expense','expense_other','cogs','income','income_other')
      and line.custom->>'provisionId' is distinct from ${identity.id} order by line.id`)).rows
  return { project, contractValue, incurredCost:sum(rows.filter(row=>['expense','expense_other','cogs'].includes(row.type)).map(row=>row.amount)),
    recognizedRevenue:neg(sum(rows.filter(row=>['income','income_other'].includes(row.type)).map(row=>row.amount))),
    sourceFingerprint:createHash('sha256').update(JSON.stringify(rows)).digest('hex') }
}

export function measureConstructionLoss(framework: ReportingFramework, basis: NonNullable<Awaited<ReturnType<typeof constructionBasis>>>, forecast: ConstructionForecast, assessment: ProvisionAssessment) {
  if (assessment.reliablyEstimable !== true) throw new ProvisionError('A construction-loss forecast requires a reliably supported estimate — resolve the missing cost evidence before proposing it')
  if (!forecast || forecast.relatedAssetsReviewed !== true || typeof forecast.impairmentEvidence !== 'string' || forecast.impairmentEvidence.trim().length<20)
    throw new ProvisionError('Review and post required impairments of related contract assets first, then document that review before assessing the loss provision')
  if (typeof forecast.terminationAvailable !== 'boolean' || (forecast.terminationAvailable && forecast.terminationCost===null)
      || (!forecast.terminationAvailable && forecast.terminationCost!==null))
    throw new ProvisionError('State whether the contract can be terminated and record its supported termination cost when termination is available')
  const remainingCost = provisionMoney(forecast.remainingCost,'Remaining direct and allocated contract cost')
  const terminationCost = forecast.terminationCost===null ? null : provisionMoney(forecast.terminationCost,'Contract termination cost')
  if (cmp(basis.incurredCost,'0')<0 || cmp(basis.recognizedRevenue,'0')<0 || cmp(basis.recognizedRevenue,basis.contractValue)>0)
    throw new ProvisionError('Reconcile posted project costs and recognized revenue to the agreed contract value before preparing this forecast')
  if (assessment.discounting==='included_in_estimate')
    throw new ProvisionError('This construction forecast uses nominal remaining costs — record an immaterial-time-value assessment; a material discounted estimate requires its supported cash-flow model')
  const positive = (value:string) => cmp(value,'0')>0 ? normalizeMoney(value) : '0.0000'
  const totalForecastCost = add(basis.incurredCost,remainingCost)
  const expectedLoss = positive(add(totalForecastCost,neg(basis.contractValue)))
  const recognizedLoss = positive(add(basis.incurredCost,neg(basis.recognizedRevenue)))
  const remainingBenefits = add(basis.contractValue,neg(basis.recognizedRevenue))
  const fulfilmentLoss = positive(add(remainingCost,neg(remainingBenefits)))
  const liability = framework==='ifrs' ? (terminationCost!==null && cmp(terminationCost,fulfilmentLoss)<0 ? terminationCost : fulfilmentLoss)
    : positive(add(expectedLoss,neg(recognizedLoss)))
  return { totalForecastCost,expectedLoss,recognizedLoss,remainingBenefits,fulfilmentLoss,liability,
    assessment:{...assessment,presentObligation:cmp(liability,'0')>0,outflow:cmp(liability,'0')>0 ? 'probable' as const : 'remote' as const,
      estimate:cmp(liability,'0')>0 ? {method:'best_estimate' as const,amount:liability} : null} }
}

/** List composition uses the same authoritative parent-feature default. */
export function provisionProjectVisibility() {
  return sql`(p.project_id is null or exists(select 1 from orgs setting_org where setting_org.id=p.org_id
    and case when jsonb_typeof(setting_org.settings->'features'->'projects')='boolean'
      then setting_org.settings->'features'->'projects'='true'::jsonb else ${featureEnabled({},'projects')} end))`
}
