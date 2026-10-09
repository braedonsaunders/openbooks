import { assertAuthoritySourceCurrent, assertAuthoritySourceEdit, captureAuthoritySourceIntegrity, type AuthorityPostingInput } from "./authority-source-integrity.ts";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { contractorWithholdingScheme, type ContractorWithholdingSchemeDefinition } from "../country-tax-packs/index.ts";
import { cmp, sum, fromUnits, toUnits } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { addCalendarDays, parseIsoDate, isIsoCalendarDate } from "../platform/civil-date.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { resolveSchemeRemittanceDue, type WithholdingRemittanceCalendar } from "./remittance.ts";
import { ContractorWithholdingError } from "./scheme.ts";
import { withholdingRemittanceFx } from "./remittance-fx.ts";
import type { FxAsOfEvidence } from "../fx/spot-rate.ts";
import { captureWithholdingCarryingSource, resolveWithholdingCarrying, insertWithholdingCarryingJournalLines, withholdingCarryingChanged, assertWithholdingCarryingRelease, type WithholdingCarryingSource } from "./remittance-carrying.ts";
import { businessToday } from "../platform/business-date.ts";

export interface WithholdingRemittancePolicy {
  calendar: WithholdingRemittanceCalendar;
  lookback?: { taxYear: number; totalTax: string; sourceReference: string };
  finalAnnualLiability?: { taxYear: number; totalTax: string; sourceReference: string };
  nextDayEventOn?: string | null;
  other945Liabilities?: { date: string; amount: string; sourceReference: string }[];
}
interface DepositDeduction extends Record<string, unknown> { id: string; paymentDate: string; periodStart: string; deducted: string; currency: string }
interface DepositSource {
  enrollmentId: string; throughDate: string; dueDate: string; deductionIds: string[];
  deductions: DepositDeduction[]; snapshotSha256: string; schemeCode: string;
  scheduleCode: string; policy: WithholdingRemittancePolicy;
  sourceFX?: FxAsOfEvidence;
  carrying: WithholdingCarryingSource;
  signedAmount: string;
  baseDocumentId?: string;
  amendsDocumentId?: string;
}
interface Enrollment extends Record<string, unknown> {
  id: string; subsidiary_id: string; scheme_code: string; authority_party_id: string | null;
  liability_account_id: string; payer_scope: string | null; remittance_schedule_code: string | null; remittance_policy: unknown;
}
const refusal = (message: string): never => { throw new ContractorWithholdingError(message, "Review the effective remittance policy in Setup → Withholding enrollments."); };
function evidenceAmount(value: unknown): value is string { return typeof value === "string" && canonicalDecimal(value, 4) !== null && cmp(value, "0") >= 0; }
function reference(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }

/** Other Form 945 categories affect deadlines only; they never inflate the native deduction bill. */
export function validateWithholdingRemittancePolicy(value: unknown): WithholdingRemittancePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return refusal("An authority-confirmed remittance policy is required.");
  const policy = value as WithholdingRemittancePolicy;
  const calendar = policy.calendar;
  if (!calendar || !isIsoCalendarDate(calendar.from) || !isIsoCalendarDate(calendar.to) || calendar.from > calendar.to || !Array.isArray(calendar.closedDates) || !calendar.closedDates.every(isIsoCalendarDate) || !reference(calendar.sourceReference)) return refusal("Enter the authority calendar coverage, confirmed closed dates and source reference.");
  if (calendar.closedDates.some(date => date < calendar.from || date > calendar.to)) return refusal("A confirmed closed date falls outside the authority calendar coverage.");
  for (const evidence of [policy.lookback, policy.finalAnnualLiability]) {
    if (evidence && (!Number.isInteger(evidence.taxYear) || evidence.taxYear < 1 || evidence.taxYear > 9999 || !evidenceAmount(evidence.totalTax) || !reference(evidence.sourceReference))) return refusal("Tax-year liability evidence requires an exact nonnegative amount and source reference.");
  }
  if (policy.nextDayEventOn && !isIsoCalendarDate(policy.nextDayEventOn)) return refusal("The prior next-day event must be a valid calendar date.");
  if (policy.other945Liabilities !== undefined && (!Array.isArray(policy.other945Liabilities) || policy.other945Liabilities.some(row => !row || !isIsoCalendarDate(row.date) || !evidenceAmount(row.amount) || !reference(row.sourceReference)))) return refusal("Other Form 945 liabilities require dated exact amounts and source references.");
  return policy;
}

/** Liability accumulation resets in each monthly or semiweekly deposit period. */
export function withholdingDepositPeriod(scheme: ContractorWithholdingSchemeDefinition, scheduleCode: string, paidOn: string, policy: WithholdingRemittancePolicy): string {
  const weekday = parseIsoDate(paidOn).getUTCDay();
  if (scheme.returnKind !== "annual_945") return scheduleCode === "IT_ACCUMULATED" ? "accumulated" : paidOn.slice(0, 7);
  const year = Number(paidOn.slice(0, 4));
  const eventYear = policy.nextDayEventOn ? Number(policy.nextDayEventOn.slice(0, 4)) : null;
  const semiweekly = scheduleCode === "US_SEMIWEEKLY" ||
    (!!policy.nextDayEventOn && policy.nextDayEventOn < paidOn && year <= eventYear! + 1) ||
    (!!policy.lookback && policy.lookback.taxYear === year - 2 && cmp(policy.lookback.totalTax, "50000") > 0);
  if (!semiweekly) return paidOn.slice(0, 7);
  return addCalendarDays(paidOn, weekday >= 3 && weekday <= 5 ? 5 - weekday : (2 - weekday + 7) % 7);
}

/** Compute deadlines from every dated liability category using one declared authority policy. */
export function resolveWithholdingDepositDeadlines(scheme: ContractorWithholdingSchemeDefinition, scheduleCode: string, events: readonly { date: string; amount: string }[], policy: WithholdingRemittancePolicy): { deadlines: Map<string,string>; nextDayEventOn?: string | null } {
  validateWithholdingRemittancePolicy(policy);
  if (events.some(event => !isIsoCalendarDate(event.date) || !evidenceAmount(event.amount))) return refusal("Dated remittance liabilities require exact nonnegative amounts.");
  const dayAmounts = new Map<string, string>();
  for (const event of [...events].sort((a,b) => a.date.localeCompare(b.date))) dayAmounts.set(event.date,sum([dayAmounts.get(event.date) ?? "0", event.amount]));
  const buckets = new Map<string,string>();
  const bucketDates = new Map<string,string[]>();
  let nextDayEventOn = policy.nextDayEventOn;
  const deadlines = new Map<string,string>();
  for (const [date, amount] of dayAmounts) {
    const effectivePolicy = { ...policy, nextDayEventOn };
    const key = withholdingDepositPeriod(scheme,scheduleCode,date,effectivePolicy);
    const accumulatedLiability = sum([buckets.get(key) ?? "0",amount]);
    buckets.set(key,accumulatedLiability);
    bucketDates.set(key,[...(bucketDates.get(key) ?? []),date]);
    const due = resolveSchemeRemittanceDue({ scheme,enrollmentSchedule:scheduleCode,paidOn:date,accumulatedLiability,calendar:policy.calendar,lookback:policy.lookback,finalAnnualLiability:policy.finalAnnualLiability,nextDayEventOn });
    deadlines.set(date,due.dueDate);
    if (due.reason === "next_business_day" || (scheme.country === "IT" && scheduleCode === "IT_ACCUMULATED" && due.reason === "monthly")) {
      // A threshold reached by another category accelerates every outstanding native deduction in its period.
      for (const prior of bucketDates.get(key) ?? []) {
        const previous = deadlines.get(prior);
        if (!previous || due.dueDate < previous) deadlines.set(prior,due.dueDate);
      }
    }
    if (due.reason === "next_business_day") { nextDayEventOn = date; buckets.set(key,"0"); bucketDates.set(key,[]); }
  }
  return { deadlines,nextDayEventOn };
}

/** One shared reservation lock covers deposits, annual settlements and source reversals. */
export async function lockWithholdingDeposits(executor: SqlExecutor, orgId: string, enrollmentId: string): Promise<void> {
  await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`withholding-deposit:${orgId}:${enrollmentId}`},0))`);
}
function digest(rows: readonly DepositDeduction[]): string { return createHash("sha256").update(JSON.stringify(rows)).digest("hex"); }

export interface WithholdingDepositView extends Record<string, unknown> {
  documentId:string;documentNumber:string;kind:string;status:string;throughDate:string;dueDate:string;currency:string;total:string;sourceChanged:boolean;
}
export async function listWithholdingDeposits(executor:SqlExecutor,orgId:string,enrollmentId:string):Promise<WithholdingDepositView[]> {
  if(!isUuid(enrollmentId)) throw new ContractorWithholdingError("withholding enrollment not found");
  const rows=(await executor.execute<WithholdingDepositView & {source:DepositSource;subsidiaryId:string;superseded:boolean}>(sql`
    select d.id as "documentId",d.document_number as "documentNumber",d.kind,d.status,d.currency,d.total::text,
      d.custom->'withholdingDeposit'->>'throughDate' as "throughDate",d.due_date::text as "dueDate",d.subsidiary_id as "subsidiaryId",d.custom->'withholdingDeposit' as source,
      exists(select 1 from documents newer where newer.org_id=d.org_id and newer.status<>'voided' and newer.custom->'withholdingDeposit'->>'amendsDocumentId'=d.id::text) as superseded
     from documents d where d.org_id=${orgId} and d.custom->'withholdingDeposit'->>'enrollmentId'=${enrollmentId}
     order by d.created_at desc,d.id desc`)).rows;
  const result:WithholdingDepositView[]=[];
  for(const row of rows) {
    let sourceChanged=false;
    if(row.status==='posted' && !row.superseded) {
      try {
        const carrying=row.source.carrying ?? await captureWithholdingCarryingSource(executor,orgId,row.source.deductionIds,[]);
        const current=await resolveWithholdingCarrying(executor,{orgId,enrollmentId,subsidiaryId:row.subsidiaryId,source:{...carrying,previousDocumentIds:[...carrying.previousDocumentIds,row.documentId]}});
        sourceChanged=withholdingCarryingChanged(current);
      } catch(error) {if(error instanceof ContractorWithholdingError) sourceChanged=true;else throw error;}
      if(!sourceChanged) {
        const unreserved=(await executor.execute(sql`select 1 from withholding_deductions w where w.org_id=${orgId} and w.enrollment_id=${enrollmentId} and w.status='posted' and w.deducted_amount>0 and w.payment_date<=${row.throughDate}::date and not exists(select 1 from documents d where d.org_id=w.org_id and d.status<>'voided' and (d.custom->'withholdingDeposit'->'deductionIds' ? w.id::text or d.custom->'withholdingRemittance'->'deductionIds' ? w.id::text)) limit 1`)).rows[0];
        sourceChanged=!!unreserved;
      }
    }
    result.push({documentId:row.documentId,documentNumber:row.documentNumber,kind:row.kind,status:row.status,throughDate:row.throughDate,dueDate:row.dueDate,currency:row.currency,total:row.total,sourceChanged});
  }
  return result;
}

export async function createWithholdingDeposit(executor: SqlExecutor, orgId: string, input: { enrollmentId: string; throughDate: string; amendsDocumentId?: string }, actorId: string): Promise<{ documentId: string; documentNumber: string; kind?: string }> {
  if (!isUuid(input.enrollmentId) || !isIsoCalendarDate(input.throughDate)) return refusal("Select an enrollment and a valid deposit cutoff date.");
  if (!await actorHasPermission(executor, orgId, actorId, "ap.pay")) throw new ContractorWithholdingError("missing permission: ap.pay");
  if (!await lockAndCheckOrgFeature(executor, orgId, "contractorWithholding")) throw new ContractorWithholdingError("Enable Contractor withholding in Company Settings → Features.");
  await lockWithholdingDeposits(executor, orgId, input.enrollmentId);
  const enrollment = (await executor.execute<Enrollment>(sql`select id,subsidiary_id,scheme_code,authority_party_id,liability_account_id,payer_scope,remittance_schedule_code,remittance_policy from withholding_enrollments where org_id=${orgId} and id=${input.enrollmentId} for update`)).rows[0];
  const scope = await actorAllowedSubsidiaryIds(executor, orgId, actorId);
  if (!enrollment || !subsidiaryScopeAllows(scope, enrollment.subsidiary_id)) throw new ContractorWithholdingError("withholding enrollment not found");
  const scheme = contractorWithholdingScheme(enrollment.scheme_code);
  if (!scheme?.remittanceSchedules?.length || (!enrollment.remittance_schedule_code && !input.amendsDocumentId)) return refusal("Select an effective remittance schedule before preparing a deposit.");
  if (scheme.payerScope && enrollment.payer_scope !== scheme.payerScope) return refusal("This withholding scheme requires a confirmed condominium payer scope.");
  let amended: { id:string; source:DepositSource; dueDate:string;partyId:string } | undefined;
  let previousDocumentIds: string[] = [];
  if (input.amendsDocumentId!==undefined) {
    if (!isUuid(input.amendsDocumentId)) return refusal("Select a posted authority deposit to correct.");
    amended=(await executor.execute<{id:string;source:DepositSource;dueDate:string;partyId:string}>(sql`select id,party_id as "partyId",custom->'withholdingDeposit' as source,due_date::text as "dueDate" from documents where org_id=${orgId} and id=${input.amendsDocumentId} and status='posted' and subsidiary_id=${enrollment.subsidiary_id} for share`)).rows[0];
    if (!amended || amended.source?.enrollmentId!==enrollment.id || amended.source.throughDate!==input.throughDate || amended.source.schemeCode!==scheme.code) return refusal("The correction must retain the posted deposit enrollment, scheme and cutoff date.");
    const baseDocumentId=amended.source.baseDocumentId ?? amended.id;
    const chain=(await executor.execute<{id:string;status:string}>(sql`select id,status from documents where org_id=${orgId} and status<>'voided' and (id=${baseDocumentId} or custom->'withholdingDeposit'->>'baseDocumentId'=${baseDocumentId}) order by created_at,id for share`)).rows;
    if (chain.some(row=>row.status!=='posted')) throw new ContractorWithholdingError("A deposit correction is already awaiting posting.","Open and post or discard the existing correction before preparing another.");
    previousDocumentIds=chain.map(row=>row.id);
  } else {
    const replaced=(await executor.execute<{number:string}>(sql`select d.document_number as number from documents d where d.org_id=${orgId} and d.status='posted' and d.custom->'withholdingDeposit'->>'enrollmentId'=${enrollment.id} and not exists(select 1 from documents newer where newer.org_id=d.org_id and newer.status<>'voided' and newer.custom->'withholdingDeposit'->>'amendsDocumentId'=d.id::text) and exists(select 1 from withholding_deductions w where w.org_id=d.org_id and w.status='voided' and d.custom->'withholdingDeposit'->'deductionIds' ? w.id::text) limit 1`)).rows[0];
    if(replaced) throw new ContractorWithholdingError(`Deposit ${replaced.number} has changed source payments.`,"Use Correct on the posted deposit before preparing another deposit for replacement payments.");
  }
  const policy = validateWithholdingRemittancePolicy(amended?.source.policy ?? enrollment.remittance_policy);
  const scheduleCode=amended?.source.scheduleCode ?? enrollment.remittance_schedule_code;
  if(!scheduleCode || !scheme.remittanceSchedules.some(schedule=>schedule.code===scheduleCode)) return refusal("The captured deposit schedule is not declared by its withholding scheme.");
  const authorityPartyId=amended?.partyId ?? enrollment.authority_party_id;
  if(!authorityPartyId) return refusal("Select an active authority vendor before preparing a deposit.");
  const valid = (await executor.execute(sql`select 1 from subsidiaries s join vendor_roles v on v.org_id=s.org_id and v.party_id=${authorityPartyId} and v.is_active join accounts a on a.org_id=s.org_id and a.id=${enrollment.liability_account_id} and a.is_active and not a.is_summary and a.type in ('liability_current_other','liability_long_term') where s.org_id=${orgId} and s.id=${enrollment.subsidiary_id} and s.is_active for share of s,v,a`)).rows[0];
  if (!valid) return refusal("The authority vendor, postable liability account and active legal entity must remain valid.");
  const deductions = (await executor.execute<DepositDeduction>(sql`
    select w.id,w.payment_date::text as "paymentDate",w.period_start::text as "periodStart",w.deducted_amount::text as deducted,w.currency
    from withholding_deductions w where w.org_id=${orgId} and w.enrollment_id=${enrollment.id} and w.status='posted' and w.payment_date<=${input.throughDate}::date and w.deducted_amount>0
    and not exists(select 1 from documents d where d.org_id=w.org_id and d.status<>'voided' and ${previousDocumentIds.length ? sql`d.id not in (${sql.join(previousDocumentIds.map(id=>sql`${id}::uuid`),sql`,`)})` : sql`true`} and (d.custom->'withholdingDeposit'->>'enrollmentId'=${enrollment.id} and d.custom->'withholdingDeposit'->'deductionIds' ? w.id::text
      or exists(select 1 from withholding_returns r where r.org_id=w.org_id and r.enrollment_id=w.enrollment_id and r.period_start=w.period_start and r.remittance_document_id=d.id and (d.custom->'withholdingRemittance'->'deductionIds' ? w.id::text or not (d.custom->'withholdingRemittance' ? 'deductionIds')))))
    order by w.payment_date,w.id for share of w`)).rows;
  if (!deductions.length && !amended) {
    const existing = (await executor.execute<{ id: string; document_number: string; kind:string }>(sql`select id,document_number,kind from documents where org_id=${orgId} and status<>'voided' and custom->'withholdingDeposit'->>'enrollmentId'=${enrollment.id} and custom->'withholdingDeposit'->>'throughDate'=${input.throughDate} order by created_at desc limit 1`)).rows[0];
    if (existing) return { documentId: existing.id, documentNumber: existing.document_number,kind:existing.kind };
    throw new ContractorWithholdingError("No unreserved posted deductions remain through this date.", "Open the existing authority bill or select a later cutoff date after posting deductions.");
  }
  if (deductions.some(row => row.currency !== scheme.currency || !evidenceAmount(row.deducted))) return refusal("Posted deductions disagree with the scheme currency or exact amount contract.");
  // Deadline thresholds include already reserved deductions in the same deposit period.
  const firstPaymentDate=deductions[0]?.paymentDate ?? input.throughDate;
  const liabilityRows = (await executor.execute<{ paymentDate: string; deducted: string }>(sql`select payment_date::text as "paymentDate",sum(deducted_amount)::text as deducted from withholding_deductions where org_id=${orgId} and enrollment_id=${enrollment.id} and status='posted' and payment_date>=${`${firstPaymentDate.slice(0,4)}-01-01`}::date and payment_date<=${input.throughDate}::date group by payment_date order by payment_date`)).rows;
  const nativeEvents = scheme.returnKind === "annual_945" ? liabilityRows : deductions.map(row => ({ paymentDate: row.paymentDate, deducted: row.deducted }));
  const events = [...nativeEvents.map(row => ({ date: row.paymentDate, amount: row.deducted })), ...(scheme.returnKind === "annual_945" ? policy.other945Liabilities ?? [] : [])].filter(row => row.date >= `${firstPaymentDate.slice(0,4)}-01-01` && row.date <= input.throughDate).sort((a,b) => a.date.localeCompare(b.date));
  if (scheme.returnKind === "annual_945" && policy.finalAnnualLiability) {
    const knownAnnual = sum(events.filter(row => Number(row.date.slice(0,4)) === policy.finalAnnualLiability!.taxYear).map(row => row.amount));
    if (cmp(knownAnnual,policy.finalAnnualLiability.totalTax) > 0) return refusal("Final annual Form 945 liability is below its recorded category liabilities.");
  }
  const decision = resolveWithholdingDepositDeadlines(scheme,scheduleCode,events,policy);
  const deadlines = decision.deadlines;
  let nextDayEventOn = decision.nextDayEventOn;
  const dueDate = amended?.dueDate ?? deductions.map(row => deadlines.get(row.paymentDate)!).sort()[0]!;
  const previousTotal=previousDocumentIds.length ? (await executor.execute<{amount:string}>(sql`select sum(case when kind='vendor_credit' then -total when kind='journal' then 0 else total end)::text as amount from documents where org_id=${orgId} and id in (${sql.join(previousDocumentIds.map(id=>sql`${id}::uuid`),sql`,`)})`)).rows[0]!.amount : '0';
  const signedAmount=fromUnits(toUnits(sum(deductions.map(row=>row.deducted)))-toUnits(previousTotal));
  const carrying=await captureWithholdingCarryingSource(executor,orgId,deductions.map(row=>row.id),previousDocumentIds);
  const carried=await resolveWithholdingCarrying(executor,{orgId,subsidiaryId:enrollment.subsidiary_id,enrollmentId:enrollment.id,source:carrying});
  if(toUnits(signedAmount)===0n && !withholdingCarryingChanged(carried)) throw new ContractorWithholdingError("No statutory or functional carrying correction is due for this deposit.");
  const kind=toUnits(signedAmount)===0n ? 'journal' : toUnits(signedAmount)<0n ? 'vendor_credit' : 'vendor_bill';
  const amount=fromUnits(toUnits(signedAmount)<0n ? -toUnits(signedAmount) : toUnits(signedAmount));
  const documentDate=amended ? await businessToday(orgId) : input.throughDate;
  const sourceFX = await withholdingRemittanceFx(executor, orgId, enrollment.subsidiary_id, scheme.currency, documentDate);
  const source: DepositSource = { sourceFX,carrying,signedAmount,...(amended ? {amendsDocumentId:amended.id,baseDocumentId:amended.source.baseDocumentId ?? amended.id} : {}), enrollmentId:enrollment.id,throughDate:input.throughDate,dueDate,deductionIds:deductions.map(row => row.id),deductions,snapshotSha256:digest(deductions),schemeCode:scheme.code,scheduleCode,policy };
  const number = await allocateDocumentNumber(executor,orgId,kind,kind==='journal' ? 'JE-' : kind==='vendor_credit' ? 'VC-' : 'BILL-');
  const memo = `${scheme.name} deposit through ${input.throughDate}`;
  const doc = (await executor.execute<{ id:string }>(sql`insert into documents(org_id,kind,document_number,party_id,subsidiary_id,document_date,due_date,currency,fx_rate,status,memo,subtotal,tax_total,total,custom,created_by,updated_by) values(${orgId},${kind},${number},${authorityPartyId},${enrollment.subsidiary_id},${documentDate}::date,${dueDate}::date,${kind==='journal' ? sourceFX.to : scheme.currency},${kind==='journal' ? '1' : sourceFX.rate},'draft',${memo},${amount},'0',${amount},${JSON.stringify({withholdingDeposit:source})}::jsonb,${actorId},${actorId}) returning id`)).rows[0];
  if (!doc) throw new ContractorWithholdingError("The authority deposit bill was not created.");
  if(kind==='journal') await insertWithholdingCarryingJournalLines(executor,orgId,doc.id,carried,memo,actorId);
  else {
    const line = await executor.execute(sql`insert into document_lines(org_id,document_id,line_number,account_id,description,quantity,unit_price,amount,withholding_treatment,created_by,updated_by) values(${orgId},${doc.id},1,${enrollment.liability_account_id},${memo},1,${amount},${amount},'excluded',${actorId},${actorId})`);
    if (line.rowCount !== 1) throw new ContractorWithholdingError("The deposit liability line was not created.");
  }
  await captureAuthoritySourceIntegrity(executor, orgId, doc.id, "withholdingDeposit", actorId);
  if (policy.nextDayEventOn && (!nextDayEventOn || policy.nextDayEventOn > nextDayEventOn)) nextDayEventOn = policy.nextDayEventOn;
  if (!amended && nextDayEventOn && nextDayEventOn !== policy.nextDayEventOn) {
    const retained = await executor.execute(sql`update withholding_enrollments set remittance_policy=jsonb_set(remittance_policy,'{nextDayEventOn}',${JSON.stringify(nextDayEventOn)}::jsonb),updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${enrollment.id}`);
    if (retained.rowCount !== 1) throw new ContractorWithholdingError("The next-day deposit event could not be retained.");
    const policyAudit = await executor.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${orgId},'withholding_enrollments',${enrollment.id},'update',${JSON.stringify({before:{nextDayEventOn:policy.nextDayEventOn ?? null},after:{nextDayEventOn},reason:"next_day_deposit_threshold"})}::jsonb,${actorId})`);
    if (policyAudit.rowCount !== 1) throw new ContractorWithholdingError("The next-day deposit policy audit was not recorded.");
  }
  const audit = await executor.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${orgId},'documents',${doc.id},'insert',${JSON.stringify({after:{withholdingDeposit:source,total:amount},reason:"authority_deposit_prepared",nextDayEventOn})}::jsonb,${actorId})`);
  if (audit.rowCount !== 1) throw new ContractorWithholdingError("The deposit bill audit was not recorded.");
  return {documentId:doc.id,documentNumber:number,kind};
}

export async function assertWithholdingDepositEdit(executor: SqlExecutor, orgId: string, documentId: string, lines: unknown[] | null, patch: Record<string, unknown>): Promise<boolean> {
  const row = (await executor.execute(sql`select id from documents where org_id=${orgId} and id=${documentId} and (custom ? 'withholdingDeposit' or exists(select 1 from audit_log a where a.org_id=${orgId} and a.table_name='documents' and a.row_id=${documentId} and a.action='insert' and a.changes->>'reason'='authority_source_captured' and a.changes->>'sourceKey'='withholdingDeposit'))`)).rows[0];
  if (!row) return false;
  await assertAuthoritySourceEdit(executor, orgId, documentId, "withholdingDeposit", lines, patch);
  return true;
}
export async function assertWithholdingDepositCurrent(executor:SqlExecutor,orgId:string,documentId:string,input?:AuthorityPostingInput):Promise<void> {
  const row = (await executor.execute<{source:DepositSource;total:string;fx_rate:string;document_date:string;kind:string}>(sql`select kind,document_date::text as document_date,fx_rate::text as fx_rate,custom->'withholdingDeposit' as source,total::text as total from documents where org_id=${orgId} and id=${documentId} and (custom ? 'withholdingDeposit' or exists(select 1 from audit_log a where a.org_id=${orgId} and a.table_name='documents' and a.row_id=${documentId} and a.action='insert' and a.changes->>'reason'='authority_source_captured' and a.changes->>'sourceKey'='withholdingDeposit'))`)).rows[0];
  if (!row) return;
  const source = row.source;
  if (!source || !isUuid(source.enrollmentId) || !Array.isArray(source.deductionIds) || (!source.deductionIds.length && !source.amendsDocumentId) || !source.deductionIds.every(isUuid)) throw new ContractorWithholdingError("The deposit source identity is invalid.");
  if (!source.sourceFX || canonicalDecimal(source.sourceFX.rate,10)===null || canonicalDecimal(row.kind==='journal' ? '1' : source.sourceFX.rate,10)!==canonicalDecimal(row.fx_rate,10) || source.sourceFX.asOf!==row.document_date) throw new ContractorWithholdingError("The deposit exchange rate no longer matches its captured source evidence.","Delete or void the bill and prepare a replacement.");
  await lockWithholdingDeposits(executor,orgId,source.enrollmentId);
  if(!source.carrying || JSON.stringify([...source.deductionIds].sort())!==JSON.stringify(source.carrying.deductionIds)) throw new ContractorWithholdingError("The deposit carrying membership no longer matches its source deductions.");
  const deductions = source.deductionIds.length ? (await executor.execute<DepositDeduction>(sql`select id,payment_date::text as "paymentDate",period_start::text as "periodStart",deducted_amount::text as deducted,currency from withholding_deductions where org_id=${orgId} and enrollment_id=${source.enrollmentId} and status='posted' and id in (${sql.join(source.deductionIds.map(id=>sql`${id}::uuid`),sql`,`)}) order by payment_date,id for share`)).rows : [];
  let previousTotal='0';
  if(source.carrying?.previousDocumentIds.length) {
    const prior=(await executor.execute<{amount:string;count:number}>(sql`select coalesce(sum(case when kind='vendor_credit' then -total when kind='journal' then 0 else total end),0)::text as amount,count(*)::int as count from documents where org_id=${orgId} and id in (${sql.join(source.carrying.previousDocumentIds.map(id=>sql`${id}::uuid`),sql`,`)}) and status='posted'`)).rows[0]!;
    if(prior.count!==source.carrying.previousDocumentIds.length) throw new ContractorWithholdingError("An earlier posted deposit changed after this correction was prepared.");
    previousTotal=prior.amount;
  }
  const actual=fromUnits(row.kind==='journal' ? 0n : row.kind==='vendor_credit' ? -toUnits(row.total) : toUnits(row.total));
  if (deductions.length!==source.deductionIds.length || digest(deductions)!==source.snapshotSha256 || cmp(fromUnits(toUnits(sum(deductions.map(row=>row.deducted)))-toUnits(previousTotal)),actual)!==0 || cmp(source.signedAmount ?? actual,actual)!==0) throw new ContractorWithholdingError("The deposit no longer matches its posted source deductions.","Delete or void the authority bill and prepare a replacement from the current deductions.");
  await assertAuthoritySourceCurrent(executor, orgId, documentId, "withholdingDeposit", input);
  if(source.amendsDocumentId) {
    if(!isUuid(source.baseDocumentId) || !isUuid(source.amendsDocumentId)) throw new ContractorWithholdingError("The deposit correction chain identity is invalid.");
    const priorIds=(await executor.execute<{id:string}>(sql`select id from documents where org_id=${orgId} and id<>${documentId} and status='posted' and (id=${source.baseDocumentId} or custom->'withholdingDeposit'->>'baseDocumentId'=${source.baseDocumentId}) order by id`)).rows.map(item=>item.id);
    if(JSON.stringify(priorIds)!==JSON.stringify(source.carrying.previousDocumentIds)) throw new ContractorWithholdingError("The posted deposit correction chain changed after preparation.","Discard this draft and prepare the correction again.");
    const newer=(await executor.execute(sql`select 1 from withholding_deductions w where w.org_id=${orgId} and w.enrollment_id=${source.enrollmentId} and w.status='posted' and w.payment_date<=${source.throughDate}::date and w.deducted_amount>0 and not (w.id=any(ARRAY[${sql.join(source.deductionIds.map(id => sql`${id}::uuid`), sql`, `)}]::uuid[])) and not exists(select 1 from documents d where d.org_id=w.org_id and d.id<>${documentId} and d.status<>'voided' and (d.custom->'withholdingDeposit'->'deductionIds' ? w.id::text or d.custom->'withholdingRemittance'->'deductionIds' ? w.id::text)) limit 1`)).rows[0];
    if(newer) throw new ContractorWithholdingError("Replacement deductions changed after this deposit correction was prepared.","Discard this draft and prepare the correction again.");
  }
  if (!(await lockAndCheckOrgFeature(executor, orgId, 'contractorWithholding'))) throw new ContractorWithholdingError("Enable Contractor withholding in Company Settings → Features before posting this authority document.");
}
/** Draft deletion and native governed void release reservations through the document lifecycle. */
export async function releaseWithholdingDeposit(executor:SqlExecutor,orgId:string,documentId:string,actorId:string|null):Promise<void> {
  const row=(await executor.execute<{source:DepositSource}>(sql`select custom->'withholdingDeposit' as source from documents where org_id=${orgId} and id=${documentId} and custom ? 'withholdingDeposit'`)).rows[0];
  if(!row) return;
  if(!isUuid(row.source?.enrollmentId)) throw new ContractorWithholdingError("The deposit source enrollment is invalid.");
  await lockWithholdingDeposits(executor,orgId,row.source.enrollmentId);
  await assertWithholdingCarryingRelease(executor,orgId,documentId);
  const audit=await executor.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${orgId},'documents',${documentId},'update',${JSON.stringify({before:{reservedDeductionIds:row.source.deductionIds},after:{reservedDeductionIds:[]},reason:"authority_deposit_released"})}::jsonb,${actorId})`);
  if(audit.rowCount!==1) throw new ContractorWithholdingError("The deposit release audit was not recorded.");
}
