import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, inExecutorTransaction, withOrgTransaction, type SqlExecutor } from '../platform/db.ts';
import { canonicalJson } from '../platform/canonical-json.ts';
import { isUuid } from '../platform/uuid.ts';
import { actorHasPermission } from '../organization/actor-permissions.ts';
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts';
import { takeEmployeeConfigurationFence } from './fences.ts';
import { requirePayrollFeature } from './feature-gate.ts';
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from './scope.ts';
import { resolvePayrollRunContext } from './pack-run-context.ts';
import { PayrollError } from './error.ts';
import { preparePriorEarnings, priorEarningsEvidence, priorEarningsInWindow, type PriorEarningsPeriod, type PriorEarningBucket } from './prior-earnings-contract.ts';

export interface PayrollPriorEarningsRecord {
  id: string; employeePartyId: string; subsidiaryId: string; country: string; currency: string;
  historyFrom: string; historyThrough: string; periods: PriorEarningsPeriod[];
  sourceFileId: string; sourceVersionId: string; sourceHash: string;
  sourceReference: string; reason: string; revision: number; contentHash: string; updatedAt: string;
}
const COLUMNS = sql`id,employee_party_id as "employeePartyId",subsidiary_id as "subsidiaryId",country,currency,
 history_from::text as "historyFrom",history_through::text as "historyThrough",periods,
 source_file_id as "sourceFileId",source_version_id as "sourceVersionId",source_hash as "sourceHash",
 source_reference as "sourceReference",reason,revision,content_hash as "contentHash",updated_at::text as "updatedAt"`;

export async function payrollPriorEarningsForEmployee(input: {
  orgId: string; actorId: string; employeePartyId: string; subsidiaryId: string;
  allowedSubsidiaryIds: PayrollSubsidiaryScope;
}): Promise<PayrollPriorEarningsRecord | null> {
  if (![input.orgId, input.actorId, input.employeePartyId, input.subsidiaryId].every(isUuid) || input.allowedSubsidiaryIds === undefined) throw new PayrollError('Choose a native employee, legal employer and explicit payroll scope');
  return withOrgTransaction(input.orgId, async () => {
    if (!await actorHasPermission(db, input.orgId, input.actorId, 'payroll.read')) throw new PayrollError('Payroll read permission is required to review prior earnings');
    await requirePayrollFeature(db, input.orgId);
    const authority = await lockActorCommandAuthority(db, input.orgId, input.actorId, input.subsidiaryId, 'payroll.read');
    const employee = (await db.execute(sql`select p.id from parties p
      join employee_roles e on e.org_id=p.org_id and e.party_id=p.id
      where p.org_id=${input.orgId} and p.id=${input.employeePartyId} and p.subsidiary_id=${input.subsidiaryId}
      ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, input.allowedSubsidiaryIds)}
      ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, authority)}`)).rows;
    if (employee.length !== 1) throw new PayrollError('The native employee is unavailable in the selected legal employer');
    return (await db.execute<PayrollPriorEarningsRecord>(sql`select ${COLUMNS} from payroll_prior_earnings
      where org_id=${input.orgId} and employee_party_id=${input.employeePartyId} and subsidiary_id=${input.subsidiaryId}`)).rows[0] ?? null;
  });
}

/** Prior-provider wages are statutory evidence, not another payment or annual tax carry-in. */
export async function savePayrollPriorEarnings(input: {
  orgId: string; actorId: string; employeePartyId: string; subsidiaryId: string;
  country: string; currency: string; historyFrom: string; historyThrough: string; periods: unknown;
  sourceFileId: string; sourceVersionId: string; sourceHash: string; sourceReference: string; reason: string;
  expectedRevision: number | null; dryRun: boolean; allowedSubsidiaryIds: PayrollSubsidiaryScope;
  authorizeFile: (fileId: string) => Promise<boolean>;
}, executor?: SqlExecutor): Promise<{ changed: boolean; record: PayrollPriorEarningsRecord | null }> {
  for (const key of ['orgId', 'actorId', 'employeePartyId', 'subsidiaryId', 'sourceFileId', 'sourceVersionId'] as const) {
    if (!isUuid(input[key])) throw new PayrollError(`Choose a valid native ${key} before recording prior earnings`);
  }
  if (input.allowedSubsidiaryIds === undefined || typeof input.dryRun !== 'boolean' || typeof input.authorizeFile !== 'function') throw new PayrollError('Prior earnings require an explicit legal-entity scope, source-file authorization and preview or apply mode');
  if (input.expectedRevision !== null && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) throw new PayrollError('Reload the current prior-earnings revision before saving');
  if (!/^[A-Z]{2}$/.test(input.country) || !/^[A-Z]{3}$/.test(input.currency) || !/^[0-9a-f]{64}$/.test(input.sourceHash)) throw new PayrollError('Prior earnings require a native payroll country, currency and exact SHA-256 source-file hash');
  const periods = preparePriorEarnings(input);
  const sourceReference = priorEarningsEvidence(input.sourceReference, 'Source reference');
  const reason = priorEarningsEvidence(input.reason, 'Change reason');
  const content = { employeePartyId: input.employeePartyId, subsidiaryId: input.subsidiaryId,
    country: input.country, currency: input.currency, historyFrom: input.historyFrom, historyThrough: input.historyThrough,
    periods, sourceFileId: input.sourceFileId, sourceVersionId: input.sourceVersionId, sourceHash: input.sourceHash, sourceReference };
  const contentHash = createHash('sha256').update(canonicalJson(content)).digest('hex');
  const apply = async (tx: SqlExecutor) => {
    if (!await actorHasPermission(tx, input.orgId, input.actorId, 'payroll.manage')) throw new PayrollError('Payroll manage permission is required to record prior earnings');
    const authority = await lockActorCommandAuthority(tx, input.orgId, input.actorId, input.subsidiaryId, 'payroll.manage');
    await requirePayrollFeature(tx, input.orgId);
    const employee = (await tx.execute<{ id: string }>(sql`select p.id from parties p
      join employee_roles e on e.org_id=p.org_id and e.party_id=p.id
      where p.org_id=${input.orgId} and p.id=${input.employeePartyId} and p.subsidiary_id=${input.subsidiaryId}
      ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, input.allowedSubsidiaryIds)}
      ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, authority)} for share of p,e`)).rows;
    if (employee.length !== 1) throw new PayrollError('The native employee is unavailable in the selected legal employer');
    const employer = (await tx.execute<{ id: string; name: string; country: string | null; baseCurrency: string | null }>(sql`
      select id,name,country,base_currency as "baseCurrency" from subsidiaries
      where org_id=${input.orgId} and id=${input.subsidiaryId} and is_active for share`)).rows[0];
    if (!employer) throw new PayrollError('Choose an active native legal employer before recording prior earnings');
    const context = resolvePayrollRunContext({ payDate: input.historyThrough, subsidiary: employer, runCurrency: input.currency });
    if (context.country !== input.country) throw new PayrollError('Prior earnings must use the legal employer’s native payroll country and currency');
    if (!await input.authorizeFile(input.sourceFileId)) throw new PayrollError('File Cabinet read access is required for the retained prior-earnings source');
    const source = (await tx.execute<{ content_hash: string | null }>(sql`select v.content_hash from file_versions v
      join files f on f.id=v.file_id where f.org_id=${input.orgId} and f.id=${input.sourceFileId}
        and v.id=${input.sourceVersionId} for share of f,v`)).rows;
    if (source.length !== 1 || source[0]!.content_hash !== input.sourceHash) throw new PayrollError('The selected source version or its hash differs — reopen the retained prior-payroll evidence');
    await takeEmployeeConfigurationFence(tx, input.orgId, input.employeePartyId);
    const current = (await tx.execute<PayrollPriorEarningsRecord>(sql`select ${COLUMNS} from payroll_prior_earnings
      where org_id=${input.orgId} and employee_party_id=${input.employeePartyId} and subsidiary_id=${input.subsidiaryId} for update`)).rows[0];
    if ((current?.revision ?? null) !== input.expectedRevision) throw new PayrollError('Prior earnings changed — reload the current record and review it before saving');
    if (current?.contentHash === contentHash) return { changed: false, record: current };
    // The employee-wide fence is also owned by native payroll commits across tax years.
    const committed = (await tx.execute<{ document_number: string }>(sql`select d.document_number
      from pay_stubs s join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
      join documents d on d.org_id=r.org_id and d.id=r.document_id
      where s.org_id=${input.orgId} and s.employee_party_id=${input.employeePartyId}
        and d.subsidiary_id=${input.subsidiaryId} and r.run_status='committed'
        and r.period_end>=least(${input.historyFrom}::date,${current?.historyFrom ?? input.historyFrom}::date)
      order by r.period_end limit 1`)).rows[0];
    if (committed) throw new PayrollError(`Pay run ${committed.document_number} already overlaps or follows this prior history — use the governed payroll void process before correcting its inputs`);
    if (input.dryRun) return { changed: true, record: current ?? null };
    const rows = current
      ? (await tx.execute<PayrollPriorEarningsRecord>(sql`update payroll_prior_earnings set
          country=${input.country},currency=${input.currency},history_from=${input.historyFrom},history_through=${input.historyThrough},
          periods=${JSON.stringify(periods)}::jsonb,source_file_id=${input.sourceFileId},source_version_id=${input.sourceVersionId},
          source_hash=${input.sourceHash},source_reference=${sourceReference},reason=${reason},content_hash=${contentHash},
          revision=revision+1,updated_by=${input.actorId},updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
          where org_id=${input.orgId} and id=${current.id} and revision=${input.expectedRevision} returning ${COLUMNS}`)).rows
      : (await tx.execute<PayrollPriorEarningsRecord>(sql`insert into payroll_prior_earnings
          (org_id,employee_party_id,subsidiary_id,country,currency,history_from,history_through,periods,
           source_file_id,source_version_id,source_hash,source_reference,reason,content_hash,created_by,updated_by)
          values(${input.orgId},${input.employeePartyId},${input.subsidiaryId},${input.country},${input.currency},
           ${input.historyFrom},${input.historyThrough},${JSON.stringify(periods)}::jsonb,${input.sourceFileId},${input.sourceVersionId},
           ${input.sourceHash},${sourceReference},${reason},${contentHash},${input.actorId},${input.actorId}) returning ${COLUMNS}`)).rows;
    if (rows.length !== 1) throw new PayrollError('The prior earnings were not saved — reload the current revision and retry');
    return { changed: true, record: rows[0]! };
  };
  return executor ? inExecutorTransaction(executor, apply) : withOrgTransaction(input.orgId, () => apply(db));
}

/** Only the paying employer and currency may contribute historical wages to a run. */
export async function readPayrollPriorEarnings(tx: SqlExecutor, input: {
  orgId: string; employeePartyId: string; excludeDocumentId: string;
}, window: { from: string; to: string }): Promise<Record<PriorEarningBucket, string>> {
  const empty = { regular: '0', overtime: '0', vacationPay: '0', holidayPay: '0' };
  const rows = (await tx.execute<PayrollPriorEarningsRecord & { runCurrency: string; employerCountry: string; runPeriodStart: string }>(sql`select h.id,h.employee_party_id as "employeePartyId",
    h.subsidiary_id as "subsidiaryId",h.country,h.currency,h.history_from::text as "historyFrom",
    h.history_through::text as "historyThrough",h.periods,d.currency as "runCurrency",
    employer.country as "employerCountry",r.period_start::text as "runPeriodStart"
    from payroll_prior_earnings h join documents d on d.org_id=h.org_id and d.id=${input.excludeDocumentId}
    join pay_runs r on r.org_id=d.org_id and r.document_id=d.id
    join subsidiaries employer on employer.org_id=d.org_id and employer.id=d.subsidiary_id
    where h.org_id=${input.orgId} and h.employee_party_id=${input.employeePartyId}
      and h.subsidiary_id=d.subsidiary_id
      and h.history_through>=${window.from}::date for share of h`)).rows;
  if (!rows.length) return empty;
  if (rows.length !== 1) throw new PayrollError('Prior earnings do not resolve to one authoritative history for the employee and legal employer');
  const history = rows[0]!;
  if (history.country !== history.employerCountry || history.currency !== history.runCurrency) throw new PayrollError('The retained prior earnings use a different payroll country or currency — reconcile their native employer scope before calculating');
  if (history.runPeriodStart <= history.historyThrough) throw new PayrollError('This run overlaps the retained prior-payroll history — begin native payroll after its history-through date');
  if (window.from < history.historyFrom) throw new PayrollError(`The statutory lookback starts ${window.from}, before the retained prior earnings begin ${history.historyFrom} — complete the dated prior-payroll history before calculating`);
  const overlap = (await tx.execute(sql`select r.document_id from pay_stubs s
    join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
    join documents d on d.org_id=r.org_id and d.id=r.document_id
    where s.org_id=${input.orgId} and s.employee_party_id=${input.employeePartyId}
      and d.subsidiary_id=${history.subsidiaryId} and r.run_status='committed'
      and r.period_start<=${history.historyThrough}::date and r.period_end>=${history.historyFrom}::date limit 1`)).rows;
  if (overlap.length) throw new PayrollError('Prior earnings overlap committed native payroll — reconcile the source history through the governed payroll correction process before calculating');
  const periods = preparePriorEarnings({ historyFrom: history.historyFrom, historyThrough: history.historyThrough, periods: history.periods });
  return priorEarningsInWindow(periods, { from: window.from, through: window.to });
}
