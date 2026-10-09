/**
 * Contractor withholding service — the database side of the scheme engine.
 *
 * Deductions are taken when a subcontractor is PAID, because that is when
 * every declared scheme makes them due: a vendor payment computes them on
 * save, carries them as a credit leg to the enrollment's liability account,
 * and freezes them into withholding_deductions when it posts. Voiding the
 * payment voids its deductions; nothing is ever edited.
 *
 * A payment is subject when its legal entity is enrolled in a scheme on the
 * payment date and the payee holds a standing under the same scheme. Bills
 * are read line by line so the base follows each line's labour, materials or
 * excluded treatment.
 */
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { assertUnrestrictedScope, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  CONTRACTOR_WITHHOLDING_SCHEMES,
  contractorWithholdingScheme,
  type ContractorWithholdingSchemeDefinition,
} from "../country-tax-packs/index.ts";
import { add, cmp, fromUnits, isZero, mulRatio, sum, toUnits } from "../money/money.ts";
import { orgFeatureEnabled, lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { db, type SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { isIsoCalendarDate, businessToday } from "../platform/business-date.ts";
import { addCalendarDays } from "../platform/civil-date.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { withholdingRemittanceFx } from "./remittance-fx.ts";
import { lookupSpotRateWithEvidence, type FxAsOfEvidence } from "../fx/spot-rate.ts";
import { withholdingCurrencyRate, withholdingTransactionAmount } from "./payment-currency.ts";
import {
  aggregateReturn,
  composeBill,
  retainedBillLines,
  computeDeduction,
  paymentShare,
  ContractorWithholdingError,
  withholdingPeriod,
  WITHHOLDING_LINE_TREATMENTS,
  type ReturnDeduction,
  type ReturnPayeeLine,
  type ReturnTotals,
  type WithholdingBillLine,
  type WithholdingLineTreatment,
  type WithholdingReason,
  type WithholdingStanding,
} from "./scheme.ts";

export const CONTRACTOR_WITHHOLDING_FEATURE = "contractorWithholding";

async function authorizeMutation(executor: SqlExecutor, orgId: string, actorId: string, permission: string, subsidiaryId?: string): Promise<void> {
  if (!(await actorHasPermission(executor, orgId, actorId, permission))) throw new ContractorWithholdingError(`missing permission: ${permission}`);
  if (!(await lockAndCheckOrgFeature(executor, orgId, CONTRACTOR_WITHHOLDING_FEATURE))) throw new ContractorWithholdingError("Enable Contractor withholding in Company Settings → Features before changing withholding records.");
  const scope = await actorAllowedSubsidiaryIds(executor, orgId, actorId);
  if (subsidiaryId === undefined) assertUnrestrictedScope(scope);
  else if (!subsidiaryScopeAllows(scope, subsidiaryId)) throw new ContractorWithholdingError("withholding record not found");
}

async function lockDeposits(executor: SqlExecutor, orgId: string, enrollmentId: string): Promise<void> {
  await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`withholding-deposit:${orgId}:${enrollmentId}`}, 0))`);
}

async function lockPeriod(executor: SqlExecutor, orgId: string, enrollmentId: string, periodStart: string): Promise<void> {
  await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`withholding-period:${orgId}:${enrollmentId}:${periodStart}`}, 0))`);
}

/** Item kinds whose bill lines are materials (supplies and plant) unless a line says otherwise. */
const MATERIAL_ITEM_KINDS: ReadonlySet<string> = new Set(["inventory", "non_inventory", "assembly", "kit", "equipment_charge"]);

/** One allocation's deduction, carried on the draft payment and frozen at posting. */
export interface PaymentWithholding {
  billDocumentId: string;
  billDocumentNumber: string;
  openLineId: string;
  schemeCode: string;
  enrollmentId: string;
  standingId: string | null;
  payeeName: string;
  payeeReference: string | null;
  verificationReference: string | null;
  liabilityAccountId: string;
  bandCode: string;
  ratePercent: string;
  downgradedFrom: string | null;
  paid: string;
  net: string;
  materials: string;
  vat: string;
  consideration: string;
  base: string;
  catchUpBase: string;
  deducted: string;
  uncollected: string;
  belowThreshold: boolean;
  periodStart: string;
  periodEnd: string;
  reasons: WithholdingReason[];
  /** Statutory figures and the exact native quote frozen when the draft was saved. */
  reporting: {
    currency: string;
    paid: string; net: string; materials: string; vat: string; consideration: string; base: string;
    catchUpBase: string; deducted: string; uncollected: string;
    fx: FxAsOfEvidence & { rate: string };
    transactionMinorUnits: number;
  };
}

export interface PaymentWithholdingInput {
  orgId: string;
  subsidiaryId: string | null;
  partyId: string | null;
  paymentDate: string;
  currency: string;
  allocations: ReadonlyArray<{ openLineId: string; targetTransactionAmount: string }>;
  discountAmount: string;
  /** The payment being computed; its own posted deductions never count as history. */
  paymentDocumentId: string | null;
  /** Lock the payee's standings so concurrent payments read one threshold history. */
  lockStandings?: boolean;
}

interface EnrollmentRow extends Record<string, unknown> {
  id: string;
  scheme_code: string;
  liability_account_id: string;
  threshold_basis: string | null;
  payer_scope: string | null;
  remittance_schedule_code: string | null;
  remittance_policy: unknown;
  return_frequency: "monthly" | "quarterly" | "annual" | null;
}

interface StandingRow extends Record<string, unknown> {
  id: string | null;
  subsidiary_id: string | null;
  payee_name: string;
  payee_reference: string | null;
  scheme_code: string;
  band_code: string;
  verification_reference: string | null;
  valid_from: string;
  valid_to: string | null;
  status: "active" | "revoked";
  apply_from_first_payment: boolean;
}

async function entityId(executor: SqlExecutor, orgId: string, subsidiaryId: string | null): Promise<string> {
  const rows = (await executor.execute<{ id: string }>(sql`
    select id from subsidiaries where org_id = ${orgId} and is_active
    and (${subsidiaryId}::uuid is not null and id = ${subsidiaryId}::uuid or ${subsidiaryId}::uuid is null and parent_id is null)`)).rows;
  if (rows.length !== 1) throw new ContractorWithholdingError("the payment has no unambiguous active legal entity");
  return rows[0]!.id;
}

function schemeOf(code: string): ContractorWithholdingSchemeDefinition {
  const scheme = contractorWithholdingScheme(code);
  if (!scheme) {
    throw new ContractorWithholdingError(
      `withholding scheme ${code} is not declared by any country pack`,
      "End the enrollment for this scheme under Setup → Withholding enrollments.",
    );
  }
  return scheme;
}

function standingOf(row: StandingRow): WithholdingStanding {
  return {
    id: row.id ?? "native-vendor",
    bandCode: row.band_code,
    verificationReference: row.verification_reference,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    status: row.status,
    applyFromFirstPayment: row.apply_from_first_payment,
  };
}

/** The enrollment and payee standing that make a payment subject, or null when it is not. */
async function resolveSubjectScheme(
  executor: SqlExecutor,
  input: { orgId: string; entityId: string; partyId: string; paymentDate: string; lockStandings: boolean },
): Promise<{ enrollment: EnrollmentRow; standing: StandingRow; scheme: ContractorWithholdingSchemeDefinition } | null> {
  if (input.lockStandings) {
    await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`withholding:${input.orgId}:${input.entityId}:${input.partyId}`}, 0))`);
  }
  const enrollments = (await executor.execute<EnrollmentRow>(sql`
    select id, scheme_code, liability_account_id, threshold_basis, payer_scope, remittance_schedule_code, remittance_policy, return_frequency
      from withholding_enrollments
     where org_id = ${input.orgId} and subsidiary_id = ${input.entityId} and is_active
       and effective_from <= ${input.paymentDate}::date
       and (effective_to is null or effective_to >= ${input.paymentDate}::date)`)).rows;
  if (enrollments.length === 0) return null;
  const schemeCodes = enrollments.map((row) => row.scheme_code);
  const standings = (await executor.execute<StandingRow>(sql`
    select
           s.id, s.subsidiary_id, p.display_name as payee_name, s.payee_reference, scheme_code, band_code, verification_reference, valid_from::text as valid_from,
           valid_to::text as valid_to, status, apply_from_first_payment
      from withholding_standings s join parties p on p.id = s.party_id and p.org_id = s.org_id
     where s.org_id = ${input.orgId} and s.party_id = ${input.partyId}
       and (s.subsidiary_id = ${input.entityId} or s.subsidiary_id is null)
       and scheme_code in (${sql.join(schemeCodes.map((code) => sql`${code}`), sql`, `)})
       and valid_from <= ${input.paymentDate}::date
     order by scheme_code, s.subsidiary_id nulls last, valid_from desc, s.created_at desc
     ${input.lockStandings ? sql`for share of s, p` : sql``}`)).rows;
  const selectedStandings: StandingRow[] = [];
  for (const enrollment of enrollments) {
    if (schemeOf(enrollment.scheme_code).standingSource === "vendor_backup_withholding") continue;
    const candidates = standings.filter(row => row.scheme_code === enrollment.scheme_code);
    const explicit = candidates.find(row => row.subsidiary_id === input.entityId);
    if (explicit) { selectedStandings.push(explicit); continue; }
    const legacy = candidates.find(row => row.subsidiary_id === null);
    if (!legacy) continue;
    const eligible = (await executor.execute<{ subsidiary_id: string }>(sql`
      select distinct e.subsidiary_id from withholding_enrollments e
        join subsidiaries s on s.org_id=e.org_id and s.id=e.subsidiary_id
       where e.org_id=${input.orgId} and e.scheme_code=${enrollment.scheme_code} and e.is_active and s.is_active
         and e.effective_from<=${input.paymentDate}::date
         and (e.effective_to is null or e.effective_to>=${input.paymentDate}::date)`)).rows;
    if (eligible.length !== 1 || eligible[0]!.subsidiary_id !== input.entityId) {
      throw new ContractorWithholdingError("The subcontractor's withholding standing has no unambiguous paying legal entity.", "In Setup → Withholding standings, record an effective standing for this paying legal entity and its own verification reference.");
    }
    selectedStandings.push(legacy);
  }
  for (const enrollment of enrollments) {
    const scheme = schemeOf(enrollment.scheme_code);
    if (scheme.standingSource !== "vendor_backup_withholding") continue;
    const vendor = (await executor.execute<{ backup_withholding: boolean; display_name: string; tin_last4: string | null }>(sql`select v.backup_withholding,p.display_name,v.tin_last4 from vendor_roles v join parties p on p.id=v.party_id and p.org_id=v.org_id where v.org_id=${input.orgId} and v.party_id=${input.partyId} and v.is_active ${input.lockStandings ? sql`for share of v,p` : sql``}`)).rows[0];
    if (vendor?.backup_withholding) selectedStandings.push({ id:null,subsidiary_id:input.entityId,payee_name:vendor.display_name,payee_reference:vendor.tin_last4,scheme_code:scheme.code,band_code:scheme.defaultBandCode,verification_reference:null,valid_from:input.paymentDate,valid_to:null,status:'active',apply_from_first_payment:true });
  }
  if (selectedStandings.length === 0) return null;
  const latest = [...new Map(selectedStandings.slice().reverse().map(row => [row.scheme_code, row])).values()];
  if (latest.length > 1) {
    throw new ContractorWithholdingError(
      `the payee holds standings under ${latest.map((row) => row.scheme_code).join(" and ")}, and the paying entity is enrolled in both`,
      "A payment can be deducted under one scheme only; end the standing that does not apply to this subcontractor.",
    );
  }
  const standing = latest[0]!;
  const enrollment = enrollments.find((row) => row.scheme_code === standing.scheme_code)!;
  return { enrollment, standing, scheme: schemeOf(enrollment.scheme_code) };
}

interface BillLineRow extends Record<string, unknown> {
  amount: string;
  vat: string;
  withholding_tax: string;
  treatment: WithholdingLineTreatment | null;
  materials_cost: string | null;
  item_kind: string | null;
  retainage: boolean;
}

/** Classify a bill line: its own treatment, else materials for supply items, else labour. */
export function lineTreatment(treatment: WithholdingLineTreatment | null, itemKind: string | null): WithholdingLineTreatment {
  if (treatment) return treatment;
  if (itemKind && MATERIAL_ITEM_KINDS.has(itemKind)) return "materials";
  if (itemKind === "labor") return "labour";
  throw new ContractorWithholdingError("a subcontractor bill line has no withholding treatment", "Edit the bill and classify each line as labour, materials or excluded before paying it.");
}

async function loadBill(
  executor: SqlExecutor,
  orgId: string,
  openLineId: string,
  subject: { partyId: string; entityId: string; nativeBackupFlag: boolean },
): Promise<{ documentId: string; documentNumber: string; currency: string; lines: WithholdingBillLine[] } | null> {
  const bill = (await executor.execute<{ id: string; document_number: string; currency: string; kind: string; party_id: string | null; subsidiary_id: string | null }>(sql`
    select d.id, d.document_number, d.currency, d.kind, d.party_id, d.subsidiary_id
      from journal_lines jl
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
      join documents d on d.id = je.source_document_id and d.org_id = je.org_id
     where jl.org_id = ${orgId} and jl.id = ${openLineId} and jl.is_open_item and je.status = 'posted'
       and d.status = 'posted'`)).rows[0];
  if (!bill || bill.kind !== "vendor_bill") throw new ContractorWithholdingError("the subcontractor payment does not reference a posted vendor bill", "Record and post the construction bill before paying it under the scheme.");
  if (bill.party_id !== subject.partyId || bill.subsidiary_id !== subject.entityId) throw new ContractorWithholdingError("the bill does not belong to this subcontractor and paying legal entity");
  const readLines = async (documentId: string, nativeRelease = false): Promise<WithholdingBillLine[]> => {
    const lines = (await executor.execute<BillLineRow>(sql`
    select dl.amount::text as amount,
           coalesce(sum(c.tax_amount) filter (where c.calculation_type = 'standard'),
                    case when count(c.id) = 0 then dl.tax_amount else 0 end, 0)::text as vat,
           coalesce(sum(c.tax_amount) filter (where c.calculation_type = 'withholding'), 0)::text as withholding_tax,
           dl.withholding_treatment as treatment, dl.withholding_materials_cost::text as materials_cost, i.kind as item_kind,
           (dl.account_id is not distinct from nullif(o.settings->'controlAccounts'->>'retainagePayable', '')::uuid) as retainage
      from document_lines dl
      join orgs o on o.id = dl.org_id
      left join items i on i.id = dl.item_id and i.org_id = dl.org_id
      left join document_line_tax_components c on c.document_line_id = dl.id and c.org_id = dl.org_id
     where dl.org_id = ${orgId} and dl.document_id = ${documentId}
     group by dl.id, i.kind, o.settings
     order by dl.line_number`)).rows;
  if (lines.some((line) => !isZero(line.withholding_tax))) {
    throw new ContractorWithholdingError(
      `bill ${bill.document_number} already withholds tax through a withholding tax code`,
      "Remove the withholding tax code from the bill's lines; the scheme deducts at payment.",
    );
  }
    // The native backup-withholding flag identifies reportable vendor payments;
    // construction-only labour/material controls are not required for that scheme.
    return lines.map((line) => ({
      amount: line.amount,
      vat: line.vat,
      treatment: line.retainage && (nativeRelease || lines.some(source => !source.retainage)) ? "excluded" : lineTreatment(line.treatment ?? (subject.nativeBackupFlag ? "labour" : null), line.item_kind),
      materialsCost: line.materials_cost,
      retainage: line.retainage,
    }));
  };
  const release = (await executor.execute<{ id: string; subcontract_id: string; amount: string; sources: unknown }>(sql`
    select r.id, r.subcontract_id, r.amount::text, r.source_bill_allocations as sources
      from vendor_retainage_releases r where r.org_id=${orgId} and r.vendor_bill_document_id=${bill.id}
  `)).rows[0];
  let lines = await readLines(bill.id, Boolean(release));
  if (release) {
    const refuse = (): never => { throw new ContractorWithholdingError(
      "the retainage release cannot resolve its original posted bills and direct materials costs",
      "Delete an unposted release bill and recreate it from Subcontracts → Retainage after correcting the source bills; posted history requires a governed void and replacement.",
    ); };
    if (!Array.isArray(release.sources) || release.sources.length === 0 || lines.some(line => !line.retainage || !isZero(line.vat)) || cmp(sum(lines.map(line => line.amount)), release.amount) !== 0) refuse();
    const expanded: WithholdingBillLine[] = [];
    const seen = new Set<string>();
    let reserved = "0.0000";
    for (const raw of release.sources as unknown[]) {
      if (!raw || typeof raw !== "object") refuse();
      const source = raw as Record<string, unknown>;
      if (typeof source.documentId !== "string" || !isUuid(source.documentId) || seen.has(source.documentId) ||
          canonicalDecimal(source.held, 4) === null || canonicalDecimal(source.amount, 4) === null || canonicalDecimal(source.previousAmount, 4) === null) refuse();
      const documentId = source.documentId as string, held = source.held as string, amount = source.amount as string, previous = source.previousAmount as string;
      seen.add(documentId);
      const origin = (await executor.execute<{ held: string }>(sql`
        select a.retainage_this_period::text as held
          from vendor_pay_applications a join documents d on d.id=a.vendor_bill_document_id and d.org_id=a.org_id
         where a.org_id=${orgId} and a.subcontract_id=${release.subcontract_id} and a.vendor_bill_document_id=${documentId}
           and a.status='billed' and d.status='posted' and d.kind='vendor_bill'
           and d.party_id=${subject.partyId} and d.subsidiary_id=${subject.entityId} and d.currency=${bill.currency}
      `)).rows[0];
      if (!origin || cmp(origin.held, held) !== 0 || cmp(amount, "0") <= 0 || cmp(previous, "0") < 0 || cmp(add(previous, amount), held) > 0) refuse();
      expanded.push(...retainedBillLines(await readLines(documentId), amount, previous));
      reserved = add(reserved, amount);
    }
    if (cmp(reserved, release.amount) !== 0) refuse();
    lines = expanded;
  }
  return { documentId: bill.id, documentNumber: bill.document_number, currency: bill.currency, lines };
}

/** The payee's position earlier in the calendar year, from posted deductions. */
async function thresholdHistory(
  executor: SqlExecutor,
  input: { orgId: string; entityId: string; partyId: string; schemeCode: string; currency: string; paymentDate: string; paymentDocumentId: string | null },
): Promise<{ consideration: string; pendingBase: string }> {
  const year = input.paymentDate.slice(0, 4);
  const incompatible = (await executor.execute(sql`select 1 from withholding_deductions
    where org_id=${input.orgId} and subsidiary_id=${input.entityId} and party_id=${input.partyId} and scheme_code=${input.schemeCode}
      and status='posted' and payment_date between ${`${year}-01-01`}::date and ${input.paymentDate}::date
      and payment_document_id is distinct from ${input.paymentDocumentId}::uuid and currency<>${input.currency} limit 1`)).rows[0];
  if (incompatible) throw new ContractorWithholdingError("The withholding history is not denominated in the scheme's statutory currency.", "Review the original payment evidence and correct affected payments through governed reversals before continuing.");
  const row = (await executor.execute<{ consideration: string; pending: string }>(sql`
    select coalesce(sum(consideration_amount) filter (where rate_percent > 0), 0)::text as consideration,
           (coalesce(sum(base_amount) filter (where below_threshold and rate_percent > 0), 0) - coalesce(sum(catch_up_base), 0))::text as pending
      from withholding_deductions
     where org_id = ${input.orgId} and subsidiary_id = ${input.entityId} and party_id = ${input.partyId} and scheme_code = ${input.schemeCode}
       and status = 'posted'
       and payment_date between ${`${year}-01-01`}::date and ${input.paymentDate}::date
       and payment_document_id is distinct from ${input.paymentDocumentId}::uuid`)).rows[0];
  return { consideration: row?.consideration ?? "0", pendingBase: row?.pending ?? "0" };
}

/** Split a header discount across allocations in proportion to what each applies. */
function discountShares(allocations: ReadonlyArray<{ targetTransactionAmount: string }>, discount: string): string[] {
  const total = toUnits(sum(allocations.map((a) => a.targetTransactionAmount)));
  if (isZero(discount) || total === 0n) return allocations.map(() => "0.0000");
  const shares = allocations.map((a) => mulRatio(discount, toUnits(a.targetTransactionAmount), total));
  const residual = toUnits(discount) - toUnits(sum(shares));
  shares[shares.length - 1] = fromUnits(toUnits(shares[shares.length - 1]!) + residual);
  return shares;
}

/**
 * Compute the deductions a vendor payment carries. Returns an empty list
 * when the feature is off, the paying entity is not enrolled, or the payee
 * holds no standing; refuses when a deduction cannot be computed honestly.
 */
export async function computePaymentWithholdings(
  input: PaymentWithholdingInput,
  executor: SqlExecutor = db,
): Promise<PaymentWithholding[]> {
  if (!input.partyId || input.allocations.length === 0) return [];
  const featureOn = await (input.lockStandings ? lockAndCheckOrgFeature(executor, input.orgId, CONTRACTOR_WITHHOLDING_FEATURE) : orgFeatureEnabled(input.orgId, CONTRACTOR_WITHHOLDING_FEATURE, executor));
  const entity = await entityId(executor, input.orgId, input.subsidiaryId);
  const backup = (await executor.execute<{ subject: boolean }>(sql`select backup_withholding and (exists(select 1 from subsidiaries where org_id=${input.orgId} and id=${entity} and country='US') or exists(select 1 from withholding_enrollments where org_id=${input.orgId} and subsidiary_id=${entity} and scheme_code='US_BACKUP_WITHHOLDING' and is_active and effective_from<=${input.paymentDate}::date and (effective_to is null or effective_to>=${input.paymentDate}::date))) as subject from vendor_roles where org_id=${input.orgId} and party_id=${input.partyId} and is_active`)).rows[0]?.subject === true;
  if (!featureOn) {
    const enrolled = (await executor.execute(sql`select 1 from withholding_enrollments e where e.org_id=${input.orgId} and e.subsidiary_id=${entity} and e.is_active and e.effective_from <= ${input.paymentDate}::date and (e.effective_to is null or e.effective_to >= ${input.paymentDate}::date) and exists(select 1 from withholding_standings s where s.org_id=e.org_id and s.party_id=${input.partyId} and s.scheme_code=e.scheme_code and (s.subsidiary_id=e.subsidiary_id or s.subsidiary_id is null) and s.valid_from<=${input.paymentDate}::date) limit 1`)).rows[0];
    if (backup || enrolled) throw new ContractorWithholdingError("This vendor has an active withholding obligation.", "Enable Contractor withholding in Company Settings → Features before making the payment.");
    return [];
  }
  const subject = await resolveSubjectScheme(executor, {
    orgId: input.orgId,
    entityId: entity,
    partyId: input.partyId,
    paymentDate: input.paymentDate,
    lockStandings: input.lockStandings ?? false,
  });
  if (!subject) {
    if (backup) throw new ContractorWithholdingError("The vendor is subject to backup withholding but the paying legal entity has no applicable enrollment.", "Configure the payer's withholding liability account and deposit schedule in Setup before making this payment.");
    const marked = (await executor.execute(sql`
      select 1 from document_lines l join documents d on d.id = l.document_id and d.org_id = l.org_id
      join journal_entries j on j.source_document_id = d.id and j.org_id = d.org_id
      join journal_lines jl on jl.entry_id = j.id and jl.org_id = j.org_id
      where d.org_id = ${input.orgId} and d.party_id = ${input.partyId} and d.subsidiary_id = ${entity}
        and jl.id in (${sql.join(input.allocations.map(a => sql`${a.openLineId}::uuid`), sql`, `)})
        and l.withholding_treatment in ('labour','materials')
        and exists(select 1 from withholding_enrollments e where e.org_id = d.org_id and e.subsidiary_id = d.subsidiary_id and e.is_active
          and e.effective_from <= ${input.paymentDate}::date and (e.effective_to is null or e.effective_to >= ${input.paymentDate}::date))
      limit 1`)).rows[0];
    if (marked) throw new ContractorWithholdingError("the subcontractor has no withholding standing", "Record the subcontractor's scheme standing in Setup before saving its payment.");
    return [];
  }
  const { enrollment, standing, scheme } = subject;
  if (scheme.payerScope && enrollment.payer_scope !== scheme.payerScope) throw new ContractorWithholdingError("This withholding scheme requires an explicitly recorded payer scope.", "Confirm the payer's applicable legal status on its enrollment in Setup.");
  if (scheme.remittanceSchedules?.length && !enrollment.remittance_schedule_code) throw new ContractorWithholdingError("This withholding enrollment has no deposit schedule.", "Record the effective authority deposit schedule in Setup before making a subject payment.");
  if (scheme.threshold) {
    const later = (await executor.execute(sql`select 1 from withholding_deductions where org_id = ${input.orgId} and subsidiary_id = ${entity}
      and party_id = ${input.partyId} and scheme_code = ${scheme.code} and status = 'posted'
      and payment_date > ${input.paymentDate}::date and payment_date <= ${`${input.paymentDate.slice(0,4)}-12-31`}::date limit 1`)).rows[0];
    if (later) throw new ContractorWithholdingError("a later payment already established this year's withholding threshold", "Use a current payment date or reverse and reprocess the affected payments in date order.");
  }
  const period = withholdingPeriod(scheme, input.paymentDate, enrollment.return_frequency ?? scheme.returnFrequency ?? "monthly");
  if (input.lockStandings) { await lockDeposits(executor, input.orgId, enrollment.id); await lockPeriod(executor, input.orgId, enrollment.id, period.start); }
  const history = await thresholdHistory(executor, {
    orgId: input.orgId,
    partyId: input.partyId,
    entityId: entity,
    schemeCode: scheme.code,
    currency: scheme.currency,
    paymentDate: input.paymentDate,
    paymentDocumentId: input.paymentDocumentId,
  });
  const fx = await lookupSpotRateWithEvidence(executor, input.orgId, input.currency, scheme.currency, input.paymentDate);
  if (fx.rate === null) throw new ContractorWithholdingError(
    `No stored ${input.currency} → ${scheme.currency} spot rate is available on or before ${input.paymentDate}.`,
    `Enter or refresh the ${input.currency} → ${scheme.currency} quote in Setup → Exchange Rates, then save the payment again.`,
  );
  withholdingCurrencyRate(fx.rate);
  const reportingFx = { ...fx, rate: fx.rate };
  const precision = (await executor.execute<{ minor_units: number | null }>(sql`select minor_units from currencies where code=${input.currency} for share`)).rows[0]?.minor_units;
  if (precision == null || !Number.isInteger(precision) || precision < 0 || precision > 4) throw new ContractorWithholdingError(
    `Currency ${input.currency} has no usable precision in the ISO currency registry.`,
    "Ask your system administrator to restore the supported ISO currency row through the platform currency seed before saving this payment.",
  );
  const discounts = discountShares(input.allocations, input.discountAmount);
  const out: PaymentWithholding[] = [];
  for (const [index, allocation] of input.allocations.entries()) {
    const bill = await loadBill(executor, input.orgId, allocation.openLineId, { partyId: input.partyId, entityId: entity, nativeBackupFlag: scheme.standingSource === "vendor_backup_withholding" });
    if (!bill) continue;
    if (bill.currency !== input.currency) {
      throw new ContractorWithholdingError(
        `bill ${bill.documentNumber} is in ${bill.currency} but the payment is in ${input.currency}`,
        `Pay ${scheme.name} subcontractors in the bill's own currency.`,
      );
    }
    const paid = fromUnits(toUnits(allocation.targetTransactionAmount) - toUnits(discounts[index]!));
    const composition = composeBill(scheme, bill.lines);
    const transactionShare = paymentShare(composition, paid);
    const figures = computeDeduction({
      scheme,
      standing: standingOf(standing),
      paymentDate: input.paymentDate,
      currency: input.currency,
      composition,
      paid,
      thresholdBasis: enrollment.threshold_basis,
      history,
      reportingFxRate: reportingFx.rate,
    });
    // Later allocations in the same payment see this one in their history.
    if (!isZero(figures.ratePercent)) history.consideration = add(history.consideration, figures.share.consideration);
    history.pendingBase = figures.belowThreshold && !isZero(figures.ratePercent)
      ? add(history.pendingBase, figures.share.base)
      : fromUnits(toUnits(history.pendingBase) - toUnits(figures.catchUpBase));
    const transactionDeducted = withholdingTransactionAmount(figures.deducted, reportingFx.rate, precision);
    out.push({
      billDocumentId: bill.documentId,
      billDocumentNumber: bill.documentNumber,
      openLineId: allocation.openLineId,
      schemeCode: scheme.code,
      enrollmentId: enrollment.id,
      standingId: standing.id,
      payeeName: standing.payee_name,
      payeeReference: standing.payee_reference,
      verificationReference: standing.verification_reference,
      liabilityAccountId: enrollment.liability_account_id,
      bandCode: figures.bandCode,
      ratePercent: figures.ratePercent,
      downgradedFrom: figures.downgradedFrom,
      ...transactionShare,
      base: isZero(figures.share.base) ? "0.0000" : transactionShare.base,
      catchUpBase: withholdingTransactionAmount(figures.catchUpBase, reportingFx.rate),
      deducted: fromUnits(toUnits(transactionDeducted) > toUnits(paid) ? toUnits(paid) : toUnits(transactionDeducted)),
      uncollected: withholdingTransactionAmount(figures.uncollected, reportingFx.rate),
      belowThreshold: figures.belowThreshold,
      periodStart: period.start,
      periodEnd: period.end,
      reasons: figures.reasons,
      reporting: { currency: scheme.currency, ...figures.share, catchUpBase: figures.catchUpBase, deducted: figures.deducted, uncollected: figures.uncollected, fx: reportingFx, transactionMinorUnits: precision },
    });
  }
  return out;
}

/** Total tax a set of payment withholdings deducts. */
export function withholdingTotal(withholdings: readonly Pick<PaymentWithholding, "deducted">[]): string {
  return sum(withholdings.map((w) => w.deducted));
}

/** Parse the withholdings a payment document stored, refusing malformed evidence. */
export function storedPaymentWithholdings(custom: unknown): PaymentWithholding[] {
  const raw = (custom as { withholdings?: unknown } | null)?.withholdings;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ContractorWithholdingError("stored payment withholdings are malformed");
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ContractorWithholdingError("stored payment withholdings are malformed");
    const row = entry as Record<string, unknown>;
    for (const key of ["billDocumentId", "openLineId", "enrollmentId", "liabilityAccountId"]) if (!isUuid(row[key])) throw new ContractorWithholdingError(`stored withholding ${key} is invalid`);
    for (const key of ["paid", "net", "materials", "vat", "consideration", "base", "catchUpBase", "deducted", "uncollected", "ratePercent"]) {
      if (canonicalDecimal(row[key], 4) === null) throw new ContractorWithholdingError(`stored withholding ${key} is invalid`);
    }
    if (row.standingId !== null && !isUuid(row.standingId)) throw new ContractorWithholdingError("stored withholding standing is invalid");
    if (typeof row.payeeName !== "string" || !row.payeeName.trim()) throw new ContractorWithholdingError("stored withholding payee is invalid");
    if (!isIsoCalendarDate(row.periodStart) || !isIsoCalendarDate(row.periodEnd) || typeof row.belowThreshold !== "boolean" || !Array.isArray(row.reasons)
        || typeof row.schemeCode !== "string" || typeof row.bandCode !== "string" || typeof row.billDocumentNumber !== "string") throw new ContractorWithholdingError("stored payment withholding evidence is incomplete");
    if (cmp(row.deducted as string, "0") < 0 || cmp(row.ratePercent as string, "0") < 0 || cmp(row.ratePercent as string, "100") > 0) throw new ContractorWithholdingError("stored withholding amounts are outside their domain");
    // Older drafts must be saved again before posting, but their evidence remains readable for reversal.
    if (row.reporting !== undefined) {
      const reporting = row.reporting as Record<string, unknown> | null;
      if (!reporting || typeof reporting !== "object" || Array.isArray(reporting) || typeof reporting.currency !== "string" || reporting.currency !== schemeOf(row.schemeCode as string).currency
          || !Number.isInteger(reporting.transactionMinorUnits) || (reporting.transactionMinorUnits as number) < 0 || (reporting.transactionMinorUnits as number) > 4) throw new ContractorWithholdingError("stored withholding reporting currency is invalid");
      for (const key of ["paid", "net", "materials", "vat", "consideration", "base", "catchUpBase", "deducted", "uncollected"]) {
        if (canonicalDecimal(reporting[key], 4) === null || cmp(reporting[key] as string, "0") < 0) throw new ContractorWithholdingError(`stored statutory withholding ${key} is invalid`);
      }
      const fx = reporting.fx as Record<string, unknown> | null;
      if (!fx || typeof fx !== "object" || Array.isArray(fx) || fx.kind !== "as-of" || fx.to !== reporting.currency || typeof fx.from !== "string" || !/^[A-Z]{3}$/.test(fx.from)
          || !isIsoCalendarDate(fx.asOf) || fx.policy !== "direct-or-inverse-spot" || fx.table !== "fx_rates" || typeof fx.digest !== "string" || !/^[a-f0-9]{64}$/.test(fx.digest)
          || typeof fx.sameCurrencyPar !== "boolean" || fx.sameCurrencyPar !== (fx.from === fx.to) || !Array.isArray(fx.observations)
          || fx.observations.length !== (fx.sameCurrencyPar ? 0 : 1) || canonicalDecimal(fx.rate, 10) === null) throw new ContractorWithholdingError("stored withholding exchange-rate evidence is invalid");
      if (fx.sameCurrencyPar && withholdingCurrencyRate(fx.rate) !== "1.0000000000") throw new ContractorWithholdingError("stored withholding exchange rate is invalid");
      withholdingCurrencyRate(fx.rate);
    }
  }
  return raw as PaymentWithholding[];
}

function sameDeduction(a: PaymentWithholding, b: PaymentWithholding): boolean {
  const monetary = new Set(["paid", "net", "materials", "vat", "consideration", "base", "catchUpBase", "deducted", "uncollected", "ratePercent"]);
  return Object.entries(a).every(([key, value]) => monetary.has(key)
    ? cmp(value as string, b[key as keyof PaymentWithholding] as string) === 0
    : canonicalEvidence(value) === canonicalEvidence(b[key as keyof PaymentWithholding]));
}

/** JSONB preserves values rather than object-key insertion order. */
function canonicalEvidence(value: unknown): string | undefined {
  if (Array.isArray(value)) return JSON.stringify(value.map(item => JSON.parse(canonicalEvidence(item) ?? "null")));
  if (value && typeof value === "object") return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, JSON.parse(canonicalEvidence(item) ?? "null")])));
  return JSON.stringify(value);
}

/**
 * Freeze a posting payment's deductions. Recomputes them under a lock on
 * the payee's standing and refuses when they no longer match what the draft
 * carried, so the posted credit leg and the recorded evidence are the same
 * numbers the operator reviewed.
 */
export async function recordPaymentWithholdings(
  executor: SqlExecutor,
  input: {
    orgId: string;
    paymentDocumentId: string;
    journalEntryId: string;
    actorId: string | null;
  },
): Promise<PaymentWithholding[]> {
  const doc = (await executor.execute<{
    subsidiary_id: string | null; party_id: string | null; document_date: string; currency: string; custom: Record<string, unknown> | null;
  }>(sql`
    select subsidiary_id, party_id, document_date::text as document_date, currency, custom
      from documents where org_id = ${input.orgId} and id = ${input.paymentDocumentId} and kind = 'vendor_payment'`)).rows[0];
  if (!doc) return [];
  const custom = doc.custom ?? {};
  const stored = storedPaymentWithholdings(custom);
  const allocations = (custom.allocations as Array<{ openLineId: string; targetTransactionAmount: string }> | undefined) ?? [];
  const current = await computePaymentWithholdings({
    orgId: input.orgId,
    subsidiaryId: doc.subsidiary_id,
    partyId: doc.party_id,
    paymentDate: doc.document_date,
    currency: doc.currency,
    allocations,
    discountAmount: typeof custom.discountAmount === "string" ? custom.discountAmount : "0",
    paymentDocumentId: input.paymentDocumentId,
    lockStandings: true,
  }, executor);
  const matches = current.length === stored.length && current.every((row, i) => sameDeduction(row, stored[i]!));
  if (!matches) {
    throw new ContractorWithholdingError(
      `the withholding on this payment is now ${withholdingTotal(current)} where the saved payment carries ${withholdingTotal(stored)}`,
      "Save the payment again to recompute the deduction from the current standing, year-to-date payments and stored exchange-rate evidence, then post it.",
    );
  }
  const authorisedAmount = canonicalDecimal(custom.withholdingAuthorisedAmount, 4);
  const authorisation = typeof custom.withholdingAuthorisation === "string" ? custom.withholdingAuthorisation.trim() : "";
  for (const row of current) {
    const scheme = schemeOf(row.schemeCode);
    if (scheme.paymentAuthorisation === "required" && (!authorisation || authorisation.length > 100 || authorisedAmount === null || cmp(authorisedAmount, sum(current.filter(item => item.schemeCode === scheme.code).map(item => item.reporting.deducted))) !== 0)) {
      throw new ContractorWithholdingError(
        `${scheme.name} needs the authority's reference and a ${scheme.currency} deduction amount matching this payment before it is made`,
        `Notify ${scheme.authority} of the payment, then enter its deduction authorisation reference and exact authorised deduction amount in ${scheme.currency} on the payment and post it.`,
      );
    }
  }
  if (current.length === 0) return current;
  const entity = await entityId(executor, input.orgId, doc.subsidiary_id);
  for (const row of current) {
    const inserted = await executor.execute(sql`
      insert into withholding_deductions (
        org_id, subsidiary_id, enrollment_id, standing_id, payee_name, payee_reference, verification_reference, scheme_code, party_id, payment_document_id,
        bill_document_id, bill_open_line_id, journal_entry_id, payment_date, period_start, period_end, currency,
        band_code, rate_percent, downgraded_from, paid_amount, net_amount, materials_amount, vat_amount,
        consideration_amount, base_amount, catch_up_base, deducted_amount, uncollected_amount, below_threshold,
        authorisation_reference, reasons, created_by, transaction_currency, transaction_paid_amount, transaction_deducted_amount, reporting_fx_rate, reporting_fx_evidence)
      values (
        ${input.orgId}, ${entity}, ${row.enrollmentId}, ${row.standingId}, ${row.payeeName}, ${row.payeeReference}, ${row.verificationReference}, ${row.schemeCode}, ${doc.party_id},
        ${input.paymentDocumentId}, ${row.billDocumentId}, ${row.openLineId}, ${input.journalEntryId},
        ${doc.document_date}::date, ${row.periodStart}::date, ${row.periodEnd}::date, ${row.reporting.currency},
        ${row.bandCode}, ${row.ratePercent}, ${row.downgradedFrom}, ${row.reporting.paid}, ${row.reporting.net}, ${row.reporting.materials},
        ${row.reporting.vat}, ${row.reporting.consideration}, ${row.reporting.base}, ${row.reporting.catchUpBase}, ${row.reporting.deducted}, ${row.reporting.uncollected},
        ${row.belowThreshold}, ${authorisation || null}, ${JSON.stringify(row.reasons)}::jsonb, ${input.actorId},
        ${doc.currency}, ${row.paid}, ${row.deducted}, ${row.reporting.fx.rate}, ${JSON.stringify(row.reporting.fx)}::jsonb)`);
    if ((inserted.rowCount ?? 0) !== 1) {
      throw new ContractorWithholdingError(`withholding deduction for bill ${row.billDocumentNumber} was not recorded`);
    }
  }
  return current;
}

/** Void the deductions of a payment being voided, keeping them as evidence. */
export async function voidPaymentWithholdings(
  executor: SqlExecutor,
  input: { orgId: string; paymentDocumentId: string; actorId: string | null },
): Promise<number> {
  const periods = (await executor.execute<{ enrollment_id: string; period_start: string }>(sql`select distinct enrollment_id, period_start::text as period_start from withholding_deductions where org_id = ${input.orgId} and payment_document_id = ${input.paymentDocumentId} and status = 'posted' order by enrollment_id, period_start`)).rows;
  for (const enrollmentId of [...new Set(periods.map(period => period.enrollment_id))].sort()) await lockDeposits(executor, input.orgId, enrollmentId);
  for (const period of periods) await lockPeriod(executor, input.orgId, period.enrollment_id, period.period_start);
  const payment = (await executor.execute<{ custom: unknown }>(sql`select custom from documents where org_id=${input.orgId} and id=${input.paymentDocumentId}`)).rows[0];
  const expected = payment ? storedPaymentWithholdings(payment.custom).length : 0;
  const result = await executor.execute(sql`
    update withholding_deductions
       set status = 'voided', voided_at = now(), voided_by = ${input.actorId}
     where org_id = ${input.orgId} and payment_document_id = ${input.paymentDocumentId} and status = 'posted'`);
  if (result.rowCount !== expected) throw new ContractorWithholdingError("The payment deduction evidence is incomplete; its governed reversal cannot proceed.");
  return result.rowCount ?? 0;
}

// ── Standings ────────────────────────────────────────────────────────────────

export interface WithholdingStandingInput {
  id?: string | null;
  subsidiaryId?: string | null;
  partyId: string;
  schemeCode: string;
  bandCode: string;
  verificationReference?: string | null;
  verifiedOn?: string | null;
  validFrom: string;
  validTo?: string | null;
  payeeReference?: string | null;
  payeeTaxOffice?: string | null;
  applyFromFirstPayment?: boolean;
  notes?: string | null;
}

function clean(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  return text ? text : null;
}

/** Create or update a payee standing, refusing a reduced band with no verification behind it. */
export async function saveWithholdingStanding(
  executor: SqlExecutor,
  orgId: string,
  input: WithholdingStandingInput,
  actorId: string,
): Promise<{ id: string }> {
  const scheme = schemeOf(input.schemeCode);
  if (scheme.standingSource === "vendor_backup_withholding") throw new ContractorWithholdingError("Backup withholding is governed by the vendor's native backup-withholding flag.", "Edit the vendor's tax profile instead of recording a separate standing.");
  const band = scheme.bands.find((entry) => entry.code === input.bandCode);
  if (!band) {
    throw new ContractorWithholdingError(
      `${scheme.name} has no band ${input.bandCode}`,
      `Choose one of ${scheme.bands.map((entry) => entry.name).join(", ")}.`,
    );
  }
  const verification = clean(input.verificationReference);
  if (band.requiresVerification && !verification) {
    throw new ContractorWithholdingError(
      `the ${band.name} band needs the ${scheme.verificationLabel.toLowerCase()} that supports it`,
      `Enter the ${scheme.verificationLabel.toLowerCase()} from ${scheme.authority}, or place the subcontractor in a band that needs none.`,
    );
  }
  if (input.validTo && input.validTo < input.validFrom) {
    throw new ContractorWithholdingError("the standing ends before it starts", "Set the valid-to date on or after the valid-from date.");
  }
  const party = (await executor.execute<{ id: string }>(sql`
    select p.id from parties p join vendor_roles v on v.party_id = p.id and v.org_id = p.org_id
     where p.org_id = ${orgId} and p.id = ${input.partyId}`)).rows[0];
  if (!party) {
    throw new ContractorWithholdingError("withholding standings belong to vendors", "Give the party a vendor role first.");
  }
  let subsidiaryId = input.subsidiaryId;
  if (!subsidiaryId) {
    const eligible = (await executor.execute<{ subsidiary_id: string }>(sql`
      select distinct e.subsidiary_id from withholding_enrollments e
        join subsidiaries s on s.org_id=e.org_id and s.id=e.subsidiary_id
       where e.org_id=${orgId} and e.scheme_code=${input.schemeCode} and e.is_active and s.is_active
         and e.effective_from<=${input.validFrom}::date and (e.effective_to is null or e.effective_to>=${input.validFrom}::date)`)).rows;
    if (eligible.length !== 1) throw new ContractorWithholdingError("Select the paying legal entity for this withholding standing.", "Choose the legal entity whose verification or exemption supports this standing in Setup → Withholding standings.");
    subsidiaryId = eligible[0]!.subsidiary_id;
  }
  if (!isUuid(subsidiaryId)) throw new ContractorWithholdingError("withholding legal entity not found");
  await authorizeMutation(executor, orgId, actorId, "admin.setup.manage", subsidiaryId);
  const subsidiary = (await executor.execute<{ id: string }>(sql`
    select id from subsidiaries where org_id=${orgId} and id=${subsidiaryId} and is_active for share`)).rows[0];
  if (!subsidiary) throw new ContractorWithholdingError("The withholding legal entity must be active and belong to this organization.", "Select the active paying legal entity registered under this scheme.");
  const values = {
    subsidiaryId,
    bandCode: input.bandCode,
    verificationReference: verification,
    verifiedOn: input.verifiedOn ?? null,
    validFrom: input.validFrom,
    validTo: input.validTo ?? null,
    payeeReference: clean(input.payeeReference),
    payeeTaxOffice: clean(input.payeeTaxOffice),
    applyFromFirstPayment: input.applyFromFirstPayment ?? false,
    notes: clean(input.notes),
  };
  if (input.id) {
    const before = (await executor.execute<Record<string, unknown>>(sql`
      select * from withholding_standings where org_id = ${orgId} and id = ${input.id} and party_id = ${input.partyId} for update`)).rows[0];
    if (!before) throw new ContractorWithholdingError("withholding standing not found");
    if (before.scheme_code !== input.schemeCode) {
      throw new ContractorWithholdingError("a standing's scheme cannot change", "Revoke this standing and record one under the other scheme.");
    }
    const used = (await executor.execute(sql`select 1 from withholding_deductions where org_id = ${orgId} and standing_id = ${input.id} limit 1`)).rows[0];
    if (used) {
      if (before.subsidiary_id !== subsidiaryId) {
        const otherEntity = before.subsidiary_id != null || (await executor.execute(sql`
          select 1 from withholding_deductions where org_id=${orgId} and standing_id=${input.id} and subsidiary_id<>${subsidiaryId} limit 1`)).rows.length > 0;
        if (otherEntity) throw new ContractorWithholdingError("This standing supports recorded payments and cannot move to another legal entity.", "Keep the recorded standing and create a separate effective standing for the paying legal entity.");
      }
      const protectedFields: Array<[string, unknown]> = [["band_code", values.bandCode], ["verification_reference", values.verificationReference], ["verified_on", values.verifiedOn], ["valid_from", values.validFrom], ["payee_reference", values.payeeReference], ["payee_tax_office", values.payeeTaxOffice], ["apply_from_first_payment", values.applyFromFirstPayment]];
      if (protectedFields.some(([key, value]) => String(before[key] ?? '') !== String(value ?? ''))) throw new ContractorWithholdingError("this standing supports recorded payments and cannot be reinterpreted", "End its validity window and record a new effective standing.");
      const past = (await executor.execute<{ last: string }>(sql`select max(payment_date)::text as last from withholding_deductions where org_id = ${orgId} and standing_id = ${input.id}`)).rows[0]?.last;
      if (values.validTo && past && values.validTo < past) throw new ContractorWithholdingError("the standing must remain valid for its recorded payments");
    }
    const updated = await executor.execute(sql`
      update withholding_standings set
        subsidiary_id = ${values.subsidiaryId}, band_code = ${values.bandCode}, verification_reference = ${values.verificationReference},
        verified_on = ${values.verifiedOn}::date, valid_from = ${values.validFrom}::date, valid_to = ${values.validTo}::date,
        payee_reference = ${values.payeeReference}, payee_tax_office = ${values.payeeTaxOffice},
        apply_from_first_payment = ${values.applyFromFirstPayment}, notes = ${values.notes},
        updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${input.id}`);
    if ((updated.rowCount ?? 0) !== 1) throw new ContractorWithholdingError("withholding standing was not updated");
    await executor.execute(sql`
      insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'withholding_standings', ${input.id}, 'update',
              ${JSON.stringify({ before, after: { schemeCode: input.schemeCode, ...values } })}::jsonb, ${actorId})`);
    return { id: input.id };
  }
  const created = (await executor.execute<{ id: string }>(sql`
    insert into withholding_standings (
      org_id, subsidiary_id, party_id, scheme_code, band_code, verification_reference, verified_on, valid_from, valid_to,
      payee_reference, payee_tax_office, apply_from_first_payment, notes, created_by, updated_by)
    values (${orgId}, ${values.subsidiaryId}, ${input.partyId}, ${input.schemeCode}, ${values.bandCode}, ${values.verificationReference},
      ${values.verifiedOn}::date, ${values.validFrom}::date, ${values.validTo}::date, ${values.payeeReference},
      ${values.payeeTaxOffice}, ${values.applyFromFirstPayment}, ${values.notes}, ${actorId}, ${actorId})
    returning id`)).rows[0];
  if (!created) throw new ContractorWithholdingError("withholding standing was not recorded");
  await executor.execute(sql`
    insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'withholding_standings', ${created.id}, 'insert',
            ${JSON.stringify({ after: { partyId: input.partyId, schemeCode: input.schemeCode, ...values } })}::jsonb, ${actorId})`);
  return created;
}

/** Revoke a standing with a reason; later payments fall to the scheme's default band. */
export async function revokeWithholdingStanding(
  executor: SqlExecutor,
  orgId: string,
  input: { id: string; reason: string },
  actorId: string,
): Promise<void> {
  await authorizeMutation(executor, orgId, actorId, "admin.setup.manage");
  const reason = clean(input.reason);
  if (!reason) throw new ContractorWithholdingError("a revocation needs a reason", "Say why the standing no longer applies.");
  const result = await executor.execute(sql`
    update withholding_standings set status = 'revoked', revoked_reason = ${reason}, updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and id = ${input.id} and status = 'active'`);
  if ((result.rowCount ?? 0) !== 1) throw new ContractorWithholdingError("no active withholding standing to revoke");
  await executor.execute(sql`
    insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'withholding_standings', ${input.id}, 'update',
            ${JSON.stringify({ before: { status: "active" }, after: { status: "revoked", revokedReason: reason }, reason })}::jsonb, ${actorId})`);
}

export interface WithholdingStandingView {
  id: string;
  subsidiaryId: string | null;
  entityName: string | null;
  schemeCode: string;
  schemeName: string;
  bandCode: string;
  bandName: string;
  verificationReference: string | null;
  verifiedOn: string | null;
  validFrom: string;
  validTo: string | null;
  payeeReference: string | null;
  payeeTaxOffice: string | null;
  applyFromFirstPayment: boolean;
  status: "active" | "revoked";
  revokedReason: string | null;
  notes: string | null;
}

export async function listWithholdingStandings(
  executor: SqlExecutor,
  orgId: string,
  partyId: string,
): Promise<WithholdingStandingView[]> {
  const rows = (await executor.execute<{
    id: string; subsidiary_id: string | null; entity_name: string | null; scheme_code: string; band_code: string; verification_reference: string | null; verified_on: string | null;
    valid_from: string; valid_to: string | null; payee_reference: string | null; payee_tax_office: string | null;
    apply_from_first_payment: boolean; status: "active" | "revoked"; revoked_reason: string | null; notes: string | null;
  }>(sql`
    select w.id, w.subsidiary_id, s.name as entity_name, scheme_code, band_code, verification_reference, verified_on::text as verified_on,
           valid_from::text as valid_from, valid_to::text as valid_to, payee_reference, payee_tax_office,
           apply_from_first_payment, status, revoked_reason, notes
      from withholding_standings w left join subsidiaries s on s.org_id=w.org_id and s.id=w.subsidiary_id
     where w.org_id = ${orgId} and party_id = ${partyId}
     order by scheme_code, valid_from desc`)).rows;
  return rows.map((row) => {
    const scheme = contractorWithholdingScheme(row.scheme_code);
    return {
      id: row.id,
      subsidiaryId: row.subsidiary_id,
      entityName: row.entity_name,
      schemeCode: row.scheme_code,
      schemeName: scheme?.name ?? row.scheme_code,
      bandCode: row.band_code,
      bandName: scheme?.bands.find((band) => band.code === row.band_code)?.name ?? row.band_code,
      verificationReference: row.verification_reference,
      verifiedOn: row.verified_on,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      payeeReference: row.payee_reference,
      payeeTaxOffice: row.payee_tax_office,
      applyFromFirstPayment: row.apply_from_first_payment,
      status: row.status,
      revokedReason: row.revoked_reason,
      notes: row.notes,
    };
  });
}

// ── Returns ──────────────────────────────────────────────────────────────────

export interface WithholdingPeriodSummary {
  periodStart: string;
  periodEnd: string;
  returnDue: string | null;
  paymentDue: string | null;
  deductionCount: number;
  deducted: string;
  latestReturn: { id: string; revision: number; status: string; filedAt: string | null; filingReference: string | null; remittanceDocumentId: string | null } | null;
  /** The posted deductions no longer match the latest filed return. */
  changedSinceFiled: boolean;
}

interface EnrollmentDetail extends Record<string, unknown> {
  id: string;
  subsidiary_id: string;
  scheme_code: string;
  contractor_reference: string;
  liability_account_id: string;
  authority_party_id: string | null;
  effective_from: string;
  return_frequency: "monthly" | "quarterly" | "annual" | null;
}

async function loadEnrollment(executor: SqlExecutor, orgId: string, enrollmentId: string, lock = false): Promise<EnrollmentDetail> {
  const row = (await executor.execute<EnrollmentDetail>(sql`
    select id, subsidiary_id, scheme_code, contractor_reference, liability_account_id, authority_party_id,
           effective_from::text as effective_from, return_frequency
      from withholding_enrollments where org_id = ${orgId} and id = ${enrollmentId}
      ${lock ? sql`for update` : sql``}`)).rows[0];
  if (!row) throw new ContractorWithholdingError("withholding enrollment not found");
  return row;
}

async function periodDeductions(executor: SqlExecutor, orgId: string, enrollmentId: string, periodStart: string): Promise<ReturnDeduction[]> {
  const rows = (await executor.execute<{
    party_id: string; payee_name: string; payee_reference: string | null; verification_reference: string | null;
    band_code: string; paid: string; net: string; materials: string; vat: string; consideration: string;
    base: string; deducted: string; uncollected: string; waived: string;
  }>(sql`
    select d.party_id, d.payee_name, d.payee_reference, d.verification_reference, d.band_code,
           d.paid_amount::text as paid, d.net_amount::text as net, d.materials_amount::text as materials,
           d.vat_amount::text as vat, d.consideration_amount::text as consideration,
           (d.base_amount + d.catch_up_base)::text as base, d.deducted_amount::text as deducted,
           d.uncollected_amount::text as uncollected,
           (select coalesce(sum((reason->>'amount')::numeric),0)::text from jsonb_array_elements(d.reasons) reason where reason->>'code'='deduction_capped' and reason ? 'amount') as waived
      from withholding_deductions d
     where d.org_id = ${orgId} and d.enrollment_id = ${enrollmentId} and d.period_start = ${periodStart}::date
       and d.status = 'posted'
     order by d.payment_date, d.id`)).rows;
  return rows.map((row) => ({
    partyId: row.party_id,
    payeeName: row.payee_name,
    payeeReference: row.payee_reference,
    verificationReference: row.verification_reference,
    bandCode: row.band_code,
    paid: row.paid,
    net: row.net,
    materials: row.materials,
    vat: row.vat,
    consideration: row.consideration,
    base: row.base,
    deducted: row.deducted,
    uncollected: row.uncollected,
    waived: row.waived,
  }));
}

function snapshotDigest(lines: readonly ReturnPayeeLine[], totals: ReturnTotals): string {
  return createHash("sha256").update(JSON.stringify({ lines, totals })).digest("hex");
}

/** Every period of an enrollment that carries deductions or a return, newest first. */
export async function listWithholdingPeriods(
  executor: SqlExecutor,
  orgId: string,
  enrollmentId: string,
): Promise<WithholdingPeriodSummary[]> {
  const enrollment = await loadEnrollment(executor, orgId, enrollmentId);
  const scheme = schemeOf(enrollment.scheme_code);
  const rows = (await executor.execute<{ period_start: string; deduction_count: number; deducted: string }>(sql`
    select period_start::text as period_start, count(*)::int as deduction_count, sum(deducted_amount)::text as deducted
      from withholding_deductions
     where org_id = ${orgId} and enrollment_id = ${enrollmentId} and status = 'posted'
     group by period_start`)).rows;
  const returns = (await executor.execute<{
    id: string; period_start: string; revision: number; status: string; filed_at: string | null;
    filing_reference: string | null; remittance_document_id: string | null; snapshot_sha256: string;
  }>(sql`
    select distinct on (period_start) id, period_start::text as period_start, revision, status,
           filed_at::text as filed_at, filing_reference, remittance_document_id, snapshot_sha256
      from withholding_returns where org_id = ${orgId} and enrollment_id = ${enrollmentId}
     order by period_start, revision desc`)).rows;
  const starts = new Set([...rows.map((row) => row.period_start), ...returns.map((row) => row.period_start)]);
  const summaries: WithholdingPeriodSummary[] = [];
  for (const start of starts) {
    const period = withholdingPeriod(scheme, start, enrollment.return_frequency ?? scheme.returnFrequency ?? "monthly");
    const totals = rows.find((row) => row.period_start === start);
    const latest = returns.find((row) => row.period_start === start) ?? null;
    let changedSinceFiled = false;
    if (latest?.status === "filed") {
      const aggregate = aggregateReturn(await periodDeductions(executor, orgId, enrollmentId, start));
      changedSinceFiled = snapshotDigest(aggregate.lines, aggregate.totals) !== latest.snapshot_sha256;
    }
    summaries.push({
      periodStart: period.start,
      periodEnd: period.end,
      returnDue: period.returnDue,
      paymentDue: period.paymentDue,
      deductionCount: totals?.deduction_count ?? 0,
      deducted: totals?.deducted ?? "0.0000",
      latestReturn: latest
        ? {
            id: latest.id, revision: latest.revision, status: latest.status, filedAt: latest.filed_at,
            filingReference: latest.filing_reference, remittanceDocumentId: latest.remittance_document_id,
          }
        : null,
      changedSinceFiled,
    });
  }
  return summaries.sort((a, b) => b.periodStart.localeCompare(a.periodStart));
}

export interface WithholdingReturnView {
  id: string;
  enrollmentId: string;
  schemeCode: string;
  schemeName: string;
  returnKind: "statutory_periodic" | "annual_945" | "financial_workpaper";
  filingNotice: string | null;
  authority: string;
  contractorReferenceLabel: string;
  contractorReference: string;
  payeeReferenceLabel: string;
  verificationLabel: string;
  entityName: string;
  periodStart: string;
  periodEnd: string;
  returnDue: string | null;
  paymentDue: string | null;
  revision: number;
  status: string;
  currency: string;
  lines: ReturnPayeeLine[];
  totals: ReturnTotals;
  preparedAt: string;
  filedAt: string | null;
  filingReference: string | null;
  remittanceDocumentId: string | null;
}

export async function loadWithholdingReturn(executor: SqlExecutor, orgId: string, returnId: string): Promise<WithholdingReturnView> {
  const row = (await executor.execute<{
    id: string; enrollment_id: string; scheme_code: string; period_start: string; period_end: string; revision: number;
    status: string; currency: string; lines: ReturnPayeeLine[]; totals: ReturnTotals; prepared_at: string;
    filed_at: string | null; filing_reference: string | null; remittance_document_id: string | null;
    contractor_reference: string; entity_name: string; return_frequency: "monthly" | "quarterly" | "annual" | null;
  }>(sql`
    select r.id, r.enrollment_id, r.scheme_code, r.period_start::text as period_start, r.period_end::text as period_end,
           r.revision, r.status, r.currency, r.lines, r.totals, r.prepared_at::text as prepared_at,
           r.filed_at::text as filed_at, r.filing_reference, r.remittance_document_id,
           e.contractor_reference, e.return_frequency, coalesce(s.legal_name, s.name) as entity_name
      from withholding_returns r
      join withholding_enrollments e on e.id = r.enrollment_id and e.org_id = r.org_id
      join subsidiaries s on s.id = r.subsidiary_id and s.org_id = r.org_id
     where r.org_id = ${orgId} and r.id = ${returnId}`)).rows[0];
  if (!row) throw new ContractorWithholdingError("withholding return not found");
  const scheme = schemeOf(row.scheme_code);
  const period = withholdingPeriod(scheme, row.period_start, row.return_frequency ?? scheme.returnFrequency ?? "monthly");
  return {
    id: row.id,
    enrollmentId: row.enrollment_id,
    schemeCode: row.scheme_code,
    schemeName: scheme.name,
    returnKind: scheme.returnKind ?? "statutory_periodic",
    filingNotice: scheme.filingNotice ?? null,
    authority: scheme.authority,
    contractorReferenceLabel: scheme.contractorReferenceLabel,
    contractorReference: row.contractor_reference,
    payeeReferenceLabel: scheme.payeeReferenceLabel,
    verificationLabel: scheme.verificationLabel,
    entityName: row.entity_name,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    returnDue: period.returnDue,
    paymentDue: period.paymentDue,
    revision: row.revision,
    status: row.status,
    currency: row.currency,
    lines: row.lines,
    totals: row.totals,
    preparedAt: row.prepared_at,
    filedAt: row.filed_at,
    filingReference: row.filing_reference,
    remittanceDocumentId: row.remittance_document_id,
  };
}

/**
 * Prepare the return for one period from its posted deductions. A complete
 * period only: deductions dated later in an open period would be missing.
 * Re-preparing replaces an unfiled revision; after filing, a change in the
 * deductions becomes the next revision.
 */
export async function prepareWithholdingReturn(
  executor: SqlExecutor,
  orgId: string,
  input: { enrollmentId: string; periodStart: string; today: string },
  actorId: string,
): Promise<{ id: string; revision: number; unchanged: boolean }> {
  const enrollment = await loadEnrollment(executor, orgId, input.enrollmentId);
  await authorizeMutation(executor, orgId, actorId, "ap.pay", enrollment.subsidiary_id);
  await lockDeposits(executor, orgId, enrollment.id);
  await lockPeriod(executor, orgId, enrollment.id, input.periodStart);
  const scheme = schemeOf(enrollment.scheme_code);
  const period = withholdingPeriod(scheme, input.periodStart, enrollment.return_frequency ?? scheme.returnFrequency ?? "monthly");
  if (period.start !== input.periodStart) {
    throw new ContractorWithholdingError(`${input.periodStart} does not start a ${scheme.name} period`, `Use the period starting ${period.start}.`);
  }
  if (input.today <= period.end) {
    throw new ContractorWithholdingError(
      `the ${period.start} – ${period.end} period has not ended`,
      `Prepare the return after ${period.end}, once every payment of the period is posted.`,
    );
  }
  const aggregate = aggregateReturn(await periodDeductions(executor, orgId, enrollment.id, period.start));
  const digest = snapshotDigest(aggregate.lines, aggregate.totals);
  const latest = (await executor.execute<{ id: string; revision: number; status: string; snapshot_sha256: string }>(sql`
    select id, revision, status, snapshot_sha256 from withholding_returns
     where org_id = ${orgId} and enrollment_id = ${enrollment.id} and period_start = ${period.start}::date
     order by revision desc limit 1 for update`)).rows[0];
  if (latest?.status === "filed" && latest.snapshot_sha256 === digest) {
    return { id: latest.id, revision: latest.revision, unchanged: true };
  }
  let revision = 1;
  if (latest?.status === "prepared") {
    const removed = await executor.execute(sql`delete from withholding_returns where org_id = ${orgId} and id = ${latest.id}`);
    if ((removed.rowCount ?? 0) !== 1) throw new ContractorWithholdingError("the unfiled return could not be replaced");
    revision = latest.revision;
  } else if (latest) {
    revision = latest.revision + 1;
  }
  const created = (await executor.execute<{ id: string }>(sql`
    insert into withholding_returns (
      org_id, subsidiary_id, enrollment_id, scheme_code, period_start, period_end, revision, status, currency,
      totals, lines, snapshot_sha256, prepared_by)
    values (${orgId}, ${enrollment.subsidiary_id}, ${enrollment.id}, ${scheme.code}, ${period.start}::date,
      ${period.end}::date, ${revision}, 'prepared', ${scheme.currency}, ${JSON.stringify(aggregate.totals)}::jsonb,
      ${JSON.stringify(aggregate.lines)}::jsonb, ${digest}, ${actorId})
    returning id`)).rows[0];
  if (!created) throw new ContractorWithholdingError("the withholding return was not prepared");
  await executor.execute(sql`
    insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'withholding_returns', ${created.id}, 'insert',
            ${JSON.stringify({ event: "return_prepared", scheme: scheme.code, periodStart: period.start, revision, totals: aggregate.totals })}::jsonb, ${actorId})`);
  return { id: created.id, revision, unchanged: false };
}

/** Mark a prepared return filed with the authority's reference, superseding the prior filing. */
export async function fileWithholdingReturn(
  executor: SqlExecutor,
  orgId: string,
  input: { returnId: string; filingReference: string; confirmed?: boolean },
  actorId: string,
): Promise<void> {
  const identity = (await executor.execute<{ enrollment_id: string; period_start: string; subsidiary_id: string }>(sql`select enrollment_id, period_start::text as period_start, subsidiary_id from withholding_returns where org_id = ${orgId} and id = ${input.returnId}`)).rows[0];
  if (!identity) throw new ContractorWithholdingError("withholding return not found");
  await authorizeMutation(executor, orgId, actorId, "ap.pay", identity.subsidiary_id);
  await lockDeposits(executor, orgId, identity.enrollment_id);
  await lockPeriod(executor, orgId, identity.enrollment_id, identity.period_start);
  const enrollment = await loadEnrollment(executor, orgId, identity.enrollment_id);
  const workpaper = schemeOf(enrollment.scheme_code).returnKind === "financial_workpaper";
  if (workpaper && input.confirmed !== true) throw new ContractorWithholdingError("Confirm that the workpaper was reviewed before freezing it.");
  const reference = clean(input.filingReference);
  if (!reference) {
    throw new ContractorWithholdingError("a filed return needs the authority's submission reference", "Enter the reference the authority issued on submission.");
  }
  const row = (await executor.execute<{ enrollment_id: string; period_start: string; status: string; snapshot_sha256: string; revision: number }>(sql`
    select enrollment_id, period_start::text as period_start, status, snapshot_sha256, revision
      from withholding_returns where org_id = ${orgId} and id = ${input.returnId} for update`)).rows[0];
  if (!row) throw new ContractorWithholdingError("withholding return not found");
  if (row.status !== "prepared") throw new ContractorWithholdingError(`the return is ${row.status}, not prepared`);
  const aggregate = aggregateReturn(await periodDeductions(executor, orgId, row.enrollment_id, row.period_start));
  if (snapshotDigest(aggregate.lines, aggregate.totals) !== row.snapshot_sha256) {
    throw new ContractorWithholdingError(
      "deductions in this period changed after the return was prepared",
      "Prepare the return again so it reports the current deductions, then file it.",
    );
  }
  await executor.execute(sql`
    update withholding_returns set status = 'superseded'
     where org_id = ${orgId} and enrollment_id = ${row.enrollment_id} and period_start = ${row.period_start}::date
       and status = 'filed' and revision < ${row.revision}`);
  const filed = await executor.execute(sql`
    update withholding_returns set status = 'filed', filed_at = now(), filed_by = ${actorId}, filing_reference = ${reference}
     where org_id = ${orgId} and id = ${input.returnId} and status = 'prepared'`);
  if ((filed.rowCount ?? 0) !== 1) throw new ContractorWithholdingError("the withholding return was not marked filed");
  await executor.execute(sql`
    insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'withholding_returns', ${input.returnId}, 'update',
            ${JSON.stringify({ event: workpaper ? "workpaper_reviewed" : "return_filed", filingReference: reference })}::jsonb, ${actorId})`);
}

/**
 * Draft the vendor bill that pays a filed return's deductions to the
 * authority. The bill debits the enrollment's liability account and rides
 * the ordinary AP review, posting and payment flow. A later revision
 * remits only what earlier remitted revisions did not.
 */
export async function createWithholdingRemittance(
  executor: SqlExecutor,
  orgId: string,
  input: { returnId: string },
  actorId: string,
): Promise<{ documentId: string; documentNumber: string }> {
  const identity = await loadWithholdingReturn(executor, orgId, input.returnId);
  const authority = await loadEnrollment(executor, orgId, identity.enrollmentId);
  await authorizeMutation(executor, orgId, actorId, "ap.pay", authority.subsidiary_id);
  await lockDeposits(executor, orgId, authority.id);
  await lockPeriod(executor, orgId, authority.id, identity.periodStart);
  await executor.execute(sql`select id from withholding_returns where org_id = ${orgId} and id = ${input.returnId} for update`);
  const ret = await loadWithholdingReturn(executor, orgId, input.returnId);
  if (schemeOf(ret.schemeCode).remittanceSchedules?.length) throw new ContractorWithholdingError("This scheme remits through its configured deposit schedule.", "Draft the deposit bill from the enrollment to apply its statutory due date.");
  const live = aggregateReturn(await periodDeductions(executor, orgId, authority.id, ret.periodStart));
  if (snapshotDigest(live.lines, live.totals) !== snapshotDigest(ret.lines, ret.totals)) throw new ContractorWithholdingError("this return no longer matches the posted deductions", "Prepare and file a revised return before remitting it.");
  if (ret.status !== "filed") {
    throw new ContractorWithholdingError("only a filed return is remitted", "File the return with the authority first.");
  }
  if (ret.remittanceDocumentId) {
    throw new ContractorWithholdingError("this return already has a remittance bill", "Open the existing bill from the return.");
  }
  const enrollment = await loadEnrollment(executor, orgId, ret.enrollmentId, true);
  if (!enrollment.authority_party_id) {
    throw new ContractorWithholdingError(
      "the enrollment names no authority to pay",
      "Set the authority vendor on the withholding enrollment under Setup → Withholding enrollments.",
    );
  }
  const stale = (await executor.execute<{ document_number: string }>(sql`select d.document_number from withholding_returns r join documents d on d.org_id=r.org_id and d.id=r.remittance_document_id where r.org_id=${orgId} and r.enrollment_id=${ret.enrollmentId} and r.period_start=${ret.periodStart}::date and r.revision<${ret.revision} and d.status not in ('posted','voided') limit 1`)).rows[0];
  if (stale) throw new ContractorWithholdingError(`The earlier authority document ${stale.document_number} is still unposted.`, "Discard or cancel that obsolete draft before drafting the revised remittance.");
  const earlier = (await executor.execute<{ remitted: string }>(sql`
    select coalesce(sum(case when d.kind='vendor_credit' then -d.total else d.total end), 0)::text as remitted
      from withholding_returns r join documents d on d.org_id = r.org_id and d.id = r.remittance_document_id
     where r.org_id = ${orgId} and r.enrollment_id = ${ret.enrollmentId} and r.period_start = ${ret.periodStart}::date
       and r.revision < ${ret.revision} and d.status <> 'voided'`)).rows[0];
  const signedAmount = fromUnits(toUnits(ret.totals.deducted) - toUnits(earlier?.remitted ?? "0"));
  if (isZero(signedAmount)) throw new ContractorWithholdingError("No further remittance or credit is due for this period.");
  const documentKind = cmp(signedAmount, "0") < 0 ? "vendor_credit" : "vendor_bill";
  const amount = fromUnits(toUnits(signedAmount) < 0n ? -toUnits(signedAmount) : toUnits(signedAmount));
  const destination = (await executor.execute(sql`select 1 from vendor_roles where org_id = ${orgId} and party_id = ${enrollment.authority_party_id} and is_active`)).rows[0];
  if (!destination) throw new ContractorWithholdingError("the authority needs an active vendor role before a remittance bill can be drafted");
  const account = (await executor.execute(sql`select 1 from accounts where org_id = ${orgId} and id = ${enrollment.liability_account_id} and is_active and not is_summary and type in ('liability_current_other','liability_long_term')`)).rows[0];
  if (!account) throw new ContractorWithholdingError("the enrolled withholding liability account is not active and postable");
  const covered = (await executor.execute<{ id: string }>(sql`
    select w.id from withholding_deductions w where w.org_id=${orgId} and w.enrollment_id=${enrollment.id} and w.period_start=${ret.periodStart}::date and w.status='posted'
      and not exists(select 1 from documents d where d.org_id=w.org_id and d.status <> 'voided'
        and ((d.custom->'withholdingDeposit'->'deductionIds') ? w.id::text or (d.custom->'withholdingRemittance'->'deductionIds') ? w.id::text)) order by w.payment_date,w.id`)).rows.map(row => row.id);
  const number = await allocateDocumentNumber(executor, orgId, documentKind, documentKind === "vendor_credit" ? "VC-" : "BILL-");
  const documentDate = await businessToday(orgId);
  const sourceFX = await withholdingRemittanceFx(executor, orgId, enrollment.subsidiary_id, ret.currency, documentDate);
  const memo = `${ret.schemeName} ${ret.periodStart} – ${ret.periodEnd}${ret.revision > 1 ? ` (revision ${ret.revision})` : ""}`;
  const doc = (await executor.execute<{ id: string }>(sql`
    insert into documents (org_id, kind, document_number, party_id, subsidiary_id, document_date, due_date, currency, fx_rate,
                           status, memo, reference_number, subtotal, tax_total, total, custom, created_by, updated_by)
    values (${orgId}, ${documentKind}, ${number}, ${enrollment.authority_party_id}, ${enrollment.subsidiary_id},
            ${documentDate}::date, ${ret.paymentDue}::date, ${ret.currency}, ${sourceFX.rate}, 'draft', ${memo}, ${ret.filingReference},
            ${amount}, '0', ${amount},
            ${JSON.stringify({ withholdingRemittance: { returnId: ret.id, enrollmentId: enrollment.id, deductionIds: covered, signedAmount, schemeCode: ret.schemeCode, periodStart: ret.periodStart, revision: ret.revision, sourceFX } })}::jsonb,
            ${actorId}, ${actorId})
    returning id`)).rows[0];
  if (!doc) throw new ContractorWithholdingError("the remittance bill was not created");
  const lineInserted = await executor.execute(sql`
    insert into document_lines (org_id, document_id, line_number, account_id, description, quantity, unit_price, amount,
                                withholding_treatment, created_by, updated_by)
    values (${orgId}, ${doc.id}, 1, ${enrollment.liability_account_id}, ${memo}, 1, ${amount}, ${amount}, 'excluded',
            ${actorId}, ${actorId})`);
  if (lineInserted.rowCount !== 1) throw new ContractorWithholdingError("the remittance bill line was not created");
  const linked = await executor.execute(sql`
    update withholding_returns set remittance_document_id = ${doc.id}
     where org_id = ${orgId} and id = ${ret.id} and remittance_document_id is null`);
  if ((linked.rowCount ?? 0) !== 1) throw new ContractorWithholdingError("the remittance bill could not be linked to the return");
  await executor.execute(sql`
    insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'withholding_returns', ${ret.id}, 'update',
            ${JSON.stringify({ event: documentKind === "vendor_credit" ? "remittance_credit_drafted" : "remittance_drafted", documentId: doc.id, amount: signedAmount })}::jsonb, ${actorId})`);
  return { documentId: doc.id, documentNumber: number };
}

/** The return as CSV, one row per payee, in the scheme's own vocabulary. */
export function withholdingReturnCsv(ret: WithholdingReturnView): string {
  const escape = (value: string | null) => {
    const text = value ?? "";
    return /[",\n\r]/.test(text) || /^[=+\-@\t]/.test(text) ? `"${(/^[=+\-@\t]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"` : text;
  };
  const header = [
    "Payee", ret.payeeReferenceLabel, ret.verificationLabel, "Bands", "Paid", "Net of VAT", "Materials", "VAT",
    "Consideration", "Base", "Deducted", "Not collected", "Excess not due",
  ];
  const rows = ret.lines.map((line) => [
    line.payeeName, line.payeeReference, line.verificationReference, line.bandCodes.join(" "), line.paid, line.net,
    line.materials, line.vat, line.consideration, line.base, line.deducted, line.uncollected, line.waived ?? "0",
  ]);
  rows.push(["Total", null, null, null, ret.totals.paid, ret.totals.net, ret.totals.materials, ret.totals.vat,
    ret.totals.consideration, ret.totals.base, ret.totals.deducted, ret.totals.uncollected, ret.totals.waived ?? "0"]);
  return [header, ...rows].map((row) => row.map((cell) => escape(cell)).join(",")).join("\r\n") + "\r\n";
}

/** The payment-and-deduction statement owed to one payee for a return's period. */
export interface WithholdingStatement {
  contractorName: string;
  contractorReferenceLabel: string;
  contractorReference: string;
  schemeName: string;
  periodStart: string;
  periodEnd: string;
  payeeName: string;
  payeeReferenceLabel: string;
  payeeReference: string | null;
  verificationLabel: string;
  verificationReference: string | null;
  currency: string;
  paid: string;
  net: string;
  materials: string;
  base: string;
  deducted: string;
  waived?: string;
}

export function withholdingStatements(ret: WithholdingReturnView): WithholdingStatement[] {
  return ret.lines.map((line) => ({
    contractorName: ret.entityName,
    contractorReferenceLabel: ret.contractorReferenceLabel,
    contractorReference: ret.contractorReference,
    schemeName: ret.schemeName,
    periodStart: ret.periodStart,
    periodEnd: ret.periodEnd,
    payeeName: line.payeeName,
    payeeReferenceLabel: ret.payeeReferenceLabel,
    payeeReference: line.payeeReference,
    verificationLabel: ret.verificationLabel,
    verificationReference: line.verificationReference,
    currency: ret.currency,
    paid: line.paid,
    net: line.net,
    materials: line.materials,
    base: line.base,
    deducted: line.deducted,
    waived: line.waived ?? "0",
  }));
}

/** Schemes declared by a jurisdiction; nonresident registered payers can also enroll. */
export function schemesForCountry(country: string): ContractorWithholdingSchemeDefinition[] {
  return CONTRACTOR_WITHHOLDING_SCHEMES.filter((scheme) => scheme.country === country);
}

/** Validate an enrollment before the setup write stores it. */
export async function validateWithholdingEnrollment(
  executor: SqlExecutor,
  orgId: string,
  input: { subsidiaryId: string; schemeCode: string; liabilityAccountId: string; authorityPartyId: string | null; thresholdBasis: string | null; payerScope?: string | null; remittanceScheduleCode?: string | null },
): Promise<void> {
  const scheme = schemeOf(input.schemeCode);
  if (scheme.payerScope && input.payerScope !== scheme.payerScope) throw new ContractorWithholdingError("Confirm the payer scope required by this statutory scheme.");
  if (!scheme.payerScope && input.payerScope) throw new ContractorWithholdingError("This scheme has no condominium payer election.");
  if (scheme.remittanceSchedules?.length && !scheme.remittanceSchedules.some(schedule => schedule.code === input.remittanceScheduleCode)) throw new ContractorWithholdingError("Select a deposit schedule declared by this scheme.");
  const entity = (await executor.execute<{ id: string }>(sql`
    select id from subsidiaries where org_id = ${orgId} and id = ${input.subsidiaryId} and is_active for share`)).rows[0];
  if (!entity) throw new ContractorWithholdingError("legal entity not found");
  if (input.thresholdBasis && !(scheme.thresholdBases ?? []).some((basis) => basis.code === input.thresholdBasis)) {
    throw new ContractorWithholdingError(
      `${scheme.name} declares no threshold basis ${input.thresholdBasis}`,
      (scheme.thresholdBases ?? []).length
        ? `Choose one of ${(scheme.thresholdBases ?? []).map((basis) => basis.name).join(", ")}, or leave it empty.`
        : "Leave the threshold basis empty for this scheme.",
    );
  }
  const account = (await executor.execute<{ type: string; is_active: boolean; is_summary: boolean }>(sql`
    select type, is_active, is_summary from accounts where org_id = ${orgId} and id = ${input.liabilityAccountId}`)).rows[0];
  if (!account || !account.is_active || account.is_summary || !['liability_current_other','liability_long_term'].includes(account.type)) {
    throw new ContractorWithholdingError(
      "the withholding liability account must be an active, postable liability account",
      "Choose the liability account deductions accumulate in until they are paid to the authority.",
    );
  }
  if (input.authorityPartyId) {
    const vendor = (await executor.execute<{ id: string }>(sql`
      select party_id as id from vendor_roles where org_id = ${orgId} and party_id = ${input.authorityPartyId} and is_active`)).rows[0];
    if (!vendor) {
      throw new ContractorWithholdingError("the authority must be a vendor", `Create ${scheme.authority} as a vendor and select it.`);
    }
  }
}

/** A deduction period's start for any date, for callers that browse by month. */
export function periodStartFor(schemeCode: string, date: string): string {
  return withholdingPeriod(schemeOf(schemeCode), date).start;
}

/** The month grid of a scheme between two dates, for period pickers. */
export function schemePeriods(schemeCode: string, from: string, to: string): Array<{ start: string; end: string }> {
  const scheme = schemeOf(schemeCode);
  const out: Array<{ start: string; end: string }> = [];
  let cursor = withholdingPeriod(scheme, from).start;
  const last = withholdingPeriod(scheme, to).start;
  while (cursor <= last && out.length < 240) {
    const period = withholdingPeriod(scheme, cursor);
    out.push({ start: period.start, end: period.end });
    cursor = addCalendarDays(period.end, 1);
  }
  return out;
}

export { ContractorWithholdingError, WITHHOLDING_LINE_TREATMENTS };

/** Generated authority bills retain their source amount and owning identity. */
export async function assertWithholdingRemittanceEdit(executor: SqlExecutor, orgId: string, documentId: string, lines: unknown[] | null, patch: { currency?: string; subsidiaryId?: string | null; partyId?: string | null; fxRate?: string; documentDate?: string }): Promise<boolean> {
  const row = (await executor.execute<{ currency: string; subsidiary_id: string; party_id: string; fx_rate: string; document_date: string }>(sql`select currency, subsidiary_id, party_id, fx_rate::text as fx_rate, document_date::text as document_date from documents where org_id = ${orgId} and id = ${documentId} and custom ? 'withholdingRemittance'`)).rows[0];
  if (!row) return false;
  if (lines !== null || (patch.currency !== undefined && patch.currency !== row.currency) || (patch.subsidiaryId !== undefined && patch.subsidiaryId !== row.subsidiary_id) || (patch.partyId !== undefined && patch.partyId !== row.party_id)) throw new ContractorWithholdingError('A withholding remittance bill keeps the filed return amount, authority and legal entity.', 'Delete or void this bill and draft a replacement from the withholding return.');
  if ((patch.documentDate !== undefined && patch.documentDate !== row.document_date) || (patch.fxRate !== undefined && canonicalDecimal(patch.fxRate, 10) !== canonicalDecimal(row.fx_rate, 10))) throw new ContractorWithholdingError('A withholding remittance retains its document date and captured exchange rate.', 'Delete or void this bill and draft a replacement from the withholding return.');
  return true;
}

/** A stale return must be amended before its generated liability can be moved into AP. */
export async function assertWithholdingRemittanceCurrent(executor: SqlExecutor, orgId: string, documentId: string): Promise<void> {
  const row = (await executor.execute<{ return_id: string; enrollment_id: string; period_start: string; status: string; snapshot_sha256: string; expected_amount: string; actual_amount: string; fx_rate: string; source_fx: { rate?: unknown; asOf?: unknown } | null; document_date: string }>(sql`
    select r.id as return_id, r.enrollment_id, r.period_start::text as period_start, r.status, r.snapshot_sha256, d.custom->'withholdingRemittance'->>'signedAmount' as expected_amount, (case when d.kind='vendor_credit' then -d.total else d.total end)::text as actual_amount, d.fx_rate::text as fx_rate, d.document_date::text as document_date, d.custom->'withholdingRemittance'->'sourceFX' as source_fx
    from documents d join withholding_returns r on r.org_id = d.org_id and r.id::text = d.custom->'withholdingRemittance'->>'returnId'
    where d.org_id = ${orgId} and d.id = ${documentId} and d.custom ? 'withholdingRemittance' and r.remittance_document_id=d.id`)).rows[0];
  const source = (await executor.execute(sql`select 1 from documents where org_id = ${orgId} and id = ${documentId} and custom ? 'withholdingRemittance'`)).rows[0];
  if (!source) return;
  if (!row || row.status !== 'filed' || canonicalDecimal(row.expected_amount,4) === null || cmp(row.expected_amount,row.actual_amount) !== 0) throw new ContractorWithholdingError('The remittance bill no longer represents a current filed return.', 'Delete or void it and generate the bill from the current filed return.');
  if (!row.source_fx || canonicalDecimal(row.source_fx.rate, 10) === null || canonicalDecimal(row.source_fx.rate, 10) !== canonicalDecimal(row.fx_rate, 10) || row.source_fx.asOf !== row.document_date) throw new ContractorWithholdingError("The remittance exchange rate no longer matches its captured source evidence.", "Delete or void the bill and prepare a replacement.");
  await lockDeposits(executor, orgId, row.enrollment_id);
  await lockPeriod(executor, orgId, row.enrollment_id, row.period_start);
  const live = aggregateReturn(await periodDeductions(executor, orgId, row.enrollment_id, row.period_start));
  if (snapshotDigest(live.lines, live.totals) !== row.snapshot_sha256) throw new ContractorWithholdingError('Deductions changed after this remittance was prepared.', 'Prepare and file the amended return, then regenerate the remittance bill.');
}

/** Native draft discard or governed void releases the generated bill link, retaining a return audit. */
export async function releaseWithholdingRemittance(executor: SqlExecutor, orgId: string, documentId: string, actorId: string | null): Promise<void> {
  const sources = (await executor.execute<{ enrollment_id: string; period_start: string }>(sql`select enrollment_id, period_start::text as period_start from withholding_returns where org_id = ${orgId} and remittance_document_id = ${documentId} order by enrollment_id, period_start`)).rows;
  for (const enrollmentId of [...new Set(sources.map(source => source.enrollment_id))].sort()) await lockDeposits(executor, orgId, enrollmentId);
  for (const source of sources) await lockPeriod(executor, orgId, source.enrollment_id, source.period_start);
  const released = (await executor.execute<{ id: string }>(sql`update withholding_returns set remittance_document_id = null where org_id = ${orgId} and remittance_document_id = ${documentId} returning id`)).rows;
  for (const row of released) {
    const audit = await executor.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values(${orgId},'withholding_returns',${row.id},'update',${JSON.stringify({ before: { remittanceDocumentId: documentId }, after: { remittanceDocumentId: null }, reason: 'generated_bill_released' })}::jsonb,${actorId})`);
    if (audit.rowCount !== 1) throw new ContractorWithholdingError('The remittance release audit was not recorded.');
  }
}
