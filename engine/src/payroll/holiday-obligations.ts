import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { ADJUDICATED_HOLIDAY_HOURS_OPERATION, assertFinancialChangeApproved, completeFinancialChange, existingFinancialChange, loadFinancialChange, proposeFinancialChange } from "../platform/financial-changes.ts";
import { isUuid } from "../platform/uuid.ts";
import { loadHolidayPaymentEvidence } from "./holiday-payment-evidence.ts";
import type { SourceBoundHolidayPayment } from "./holiday-payment-source.ts";
import { takeEmployeeConfigurationFence } from "./fences.ts";
import { PayrollError } from "./error.ts";

type SourceAuthority = { orgId: string; actorId: string; authorizeFile: (fileId: string) => Promise<boolean> };

/** Capture the native identity, dated employment and prior-payment evidence
 * reviewed by the approver. Applying a proposal remeasures this same state. */
async function entitlementState(tx: SqlExecutor, orgId: string, employmentId: string, evidence: SourceBoundHolidayPayment, subsidiaryId: string): Promise<Record<string, unknown>> {
  if (!isUuid(employmentId)) throw new PayrollError("Select the native employment owning the unpaid holiday entitlement.");
  const employeeId = evidence.instruction.employeePartyId;
  await takeEmployeeConfigurationFence(tx, orgId, employeeId);
  const employment = (await tx.execute(sql`select id, worker_party_id, employer_subsidiary_id from worker_employments
    where org_id=${orgId} and id=${employmentId} and worker_party_id=${employeeId} and employer_subsidiary_id=${subsidiaryId} for share`)).rows[0];
  if (!employment) throw new PayrollError("The selected employment must belong to the employee and legal employer named in the entitlement.");
  const profile = (await tx.execute(sql`select id, employment_id, country, province, labour_jurisdiction, pay_schedule_id
    from employee_payroll_profiles where org_id=${orgId} and employee_party_id=${employeeId} and employment_id=${employmentId} for share`)).rows;
  if (profile.length !== 1 || typeof profile[0]!.country !== "string" || !/^[A-Z]{2}$/.test(profile[0]!.country as string) ||
      typeof profile[0]!.province !== "string" || !(profile[0]!.province as string).trim()) {
    throw new PayrollError("Review the employee's linked payroll profile and employment jurisdiction before proposing holiday pay.");
  }
  const datedEmployment: Record<string, unknown>[] = [];
  for (const date of evidence.instruction.holidayDates) {
    const rows = (await tx.execute(sql`select id, version_no, effective_from::text, effective_to::text, status
      from worker_employment_versions where org_id=${orgId} and employment_id=${employmentId} and recorded_until is null
        and effective_from<=${date}::date and (effective_to is null or effective_to>${date}::date) for share`)).rows;
    if (rows.length !== 1 || !["active", "on_leave", "suspended"].includes(String(rows[0]!.status))) {
      throw new PayrollError(`Review the native employment history for ${date}; an unpaid entitlement must name an employment in force on each holiday.`);
    }
    datedEmployment.push({ holidayDate: date, ...rows[0] });
  }
  const dates = JSON.stringify(evidence.instruction.holidayDates);
  const occurrences = (await tx.execute(sql`select obligation_id,holiday_date::text from payroll_holiday_occurrences
    where org_id=${orgId} and employee_party_id=${employeeId} and subsidiary_id=${subsidiaryId}
      and holiday_date in(select jsonb_array_elements_text(${dates}::jsonb)::date) order by holiday_date for share`)).rows;
  if (occurrences.length) throw new PayrollError("One or more holidays already belong to an approved entitlement; use its existing payment record instead of proposing another payment.");
  // Existing ordinary holiday pay can cover several dates. Without a dated
  // allocation it cannot safely be treated as unrelated to this entitlement.
  const paid = (await tx.execute(sql`select distinct r.document_id,s.id as stub_id
    from pay_runs r join pay_stubs s on s.org_id=r.org_id and s.pay_run_document_id=r.document_id
    join pay_stub_lines l on l.org_id=s.org_id and l.stub_id=s.id
    join pay_components c on c.org_id=l.org_id and c.id=l.component_id
    where r.org_id=${orgId} and r.run_status='committed' and s.employee_party_id=${employeeId}
      and c.system_key='stat_holiday' and (l.amount>0 or l.hours>0)
      and exists(select 1 from jsonb_array_elements_text(${dates}::jsonb) h(date)
        where h.date::date between r.period_start and r.period_end) order by r.document_id,s.id`)).rows;
  if (paid.length) throw new PayrollError("Posted payroll already contains holiday pay in a covered source period; review its dated allocation before recording another entitlement.");
  return { employment, profile: profile[0]!, datedEmployment, occurrenceClaims: occurrences, postedHolidayPayments: paid };
}

export async function proposeHolidayObligation(input: SourceAuthority & {
  instruction: unknown; source: unknown; employmentId: string; reason: string; idempotencyKey: string;
}): Promise<{ changeId: string }> {
  return withOrgTransaction(input.orgId, async () => {
    if (!isUuid(input.employmentId)) throw new PayrollError("Select the native employment owning the unpaid holiday entitlement.");
    const employmentId = input.employmentId.toLowerCase();
    const prepared = await loadHolidayPaymentEvidence(db, input);
    const evidence = { instruction: prepared.instruction, source: prepared.source };
    const proposal = {
      orgId: input.orgId, actorId: input.actorId, subsidiaryId: prepared.subsidiaryId,
      domain: "payroll" as const, subjectId: evidence.instruction.employeePartyId,
      operation: ADJUDICATED_HOLIDAY_HOURS_OPERATION, effectiveOn: evidence.instruction.paymentDate,
      reason: input.reason, idempotencyKey: input.idempotencyKey,
      payload: { evidence, employmentId, requiredSubsidiaryIds: [prepared.subsidiaryId] },
    };
    await takeEmployeeConfigurationFence(db, input.orgId, evidence.instruction.employeePartyId);
    const existing = await existingFinancialChange(db, proposal);
    if (existing) return { changeId: existing };
    const beforeState = await entitlementState(db, input.orgId, employmentId, evidence, prepared.subsidiaryId);
    const changeId = await proposeFinancialChange(db, { ...proposal, beforeState });
    return { changeId };
  });
}

/** Approval creates a dated unpaid obligation, not a payroll adjustment or
 * a payment. The existing Financial Changes/Flows engine owns the decision. */
export async function applyHolidayObligation(input: SourceAuthority & { changeId: string }): Promise<{ obligationId: string }> {
  if (!isUuid(input.changeId)) throw new PayrollError("Select the approved holiday entitlement proposal.");
  return withOrgTransaction(input.orgId, async () => {
    const change = await loadFinancialChange(db, input.orgId, input.changeId);
    if (change.domain !== "payroll" || change.operation !== ADJUDICATED_HOLIDAY_HOURS_OPERATION) {
      throw new PayrollError("Select an unpaid holiday entitlement proposal.");
    }
    const frozen = change.payload.evidence as SourceBoundHolidayPayment | undefined;
    const prepared = await loadHolidayPaymentEvidence(db, { ...input, instruction: frozen?.instruction, source: frozen?.source && { fileId: frozen.source.fileId, versionId: frozen.source.versionId } });
    const evidence = { instruction: prepared.instruction, source: prepared.source };
    const employmentId = change.payload.employmentId;
    if (typeof employmentId !== "string") throw new PayrollError("The proposal has no bound employment; reject it and submit a corrected proposal.");
    await takeEmployeeConfigurationFence(db, input.orgId, prepared.instruction.employeePartyId);
    if (change.status === "applied") {
      const existing = (await db.execute<{ id: string }>(sql`select id from payroll_holiday_obligations
        where org_id=${input.orgId} and change_id=${change.id} and employee_party_id=${prepared.instruction.employeePartyId}
          and subsidiary_id=${prepared.subsidiaryId} and employment_id=${employmentId} and evidence=${JSON.stringify(evidence)}::jsonb`)).rows[0];
      if (!existing) throw new PayrollError("The applied proposal does not resolve to its native holiday entitlement; review the retained record.");
      return { obligationId: existing.id };
    }
    const beforeState = await entitlementState(db, input.orgId, employmentId, evidence, prepared.subsidiaryId);
    assertFinancialChangeApproved(change, { domain: "payroll", subjectId: prepared.instruction.employeePartyId, beforeState });
    const id = randomUUID();
    const inserted = await db.execute(sql`insert into payroll_holiday_obligations
      (id,org_id,change_id,employee_party_id,subsidiary_id,employment_id,payment_date,source_file_id,source_version_id,evidence,created_by)
      values(${id},${input.orgId},${change.id},${prepared.instruction.employeePartyId},${prepared.subsidiaryId},${employmentId},
        ${prepared.instruction.paymentDate},${prepared.source.fileId},${prepared.source.versionId},${JSON.stringify(evidence)}::jsonb,${input.actorId}) returning id`);
    if (inserted.rows.length !== 1) throw new PayrollError("The approved holiday entitlement could not be recorded.");
    for (const date of prepared.instruction.holidayDates) {
      const occurrence = await db.execute(sql`insert into payroll_holiday_occurrences(org_id,obligation_id,employee_party_id,subsidiary_id,holiday_date)
        values(${input.orgId},${id},${prepared.instruction.employeePartyId},${prepared.subsidiaryId},${date}) returning holiday_date`);
      if (occurrence.rows.length !== 1) throw new PayrollError("An approved holiday occurrence could not be recorded.");
    }
    await completeFinancialChange(db, input.orgId, change.id, input.actorId, { obligationId: id });
    return { obligationId: id };
  });
}
