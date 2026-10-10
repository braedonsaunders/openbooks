import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { parseMoney } from "../money/brands.ts";
import { PayrollError } from "./error.ts";
import { holidayObligationRunSource } from "./holiday-obligation-source.ts";
import { priceAdjudicatedHolidayPayment } from "./holiday-payment-contract.ts";
import { programApplicabilityFromExclusions, type Line } from "./run-stub-records.ts";
import type { PayrollSubsidiaryScope } from "./scope.ts";

/** Approved entitlement hours are paid units, not newly claimed worked time.
 * Pricing uses the approved wage-basis date and the native dated wage/FX
 * machinery. All ordinary benefit and statutory phases consume the line. */
export async function appendApprovedHolidaySettlements(tx: SqlExecutor, input: {
  orgId: string; actorId: string; documentId: string; employeePartyId: string; employmentId: string;
  subsidiaryId: string | null | undefined; country: string; province: string | null; labourJurisdiction: string | null;
  payDate: string; runType: string; statHolidayPay: boolean; simulate: boolean;
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
  need: (key: string, kind: string) => Record<string, unknown>; lines: Line[];
  /**
   * The calculation's once-resolved holiday-schema availability; probed
   * when absent.
   */
  obligationsAvailable?: boolean | null;
}): Promise<void> {
  if (input.runType !== "regular") return;
  const sources = await holidayObligationRunSource(tx, input.orgId, input.documentId, input.allowedSubsidiaryIds,
    { employeePartyId: input.employeePartyId, employmentId: input.employmentId },
    input.obligationsAvailable);
  for (const source of sources.filter(source => source.paymentDate === input.payDate)) {
    if (!input.statHolidayPay) throw new PayrollError("Enable statutory holiday pay in Payroll settings before settling the employee's approved unpaid holiday entitlement.");
    if (!source.profile || typeof source.profile !== "object" || Array.isArray(source.profile) ||
        source.subsidiaryId !== input.subsidiaryId || source.profile.country !== input.country || source.profile.province !== input.province ||
        source.profile.labour_jurisdiction !== input.labourJurisdiction) {
      throw new PayrollError("The approved holiday entitlement and payroll disagree on the legal employer or jurisdiction; review the employee's historical payroll configuration before settling it.");
    }
    if (source.foreignClaim) throw new PayrollError("The approved holiday entitlement is already claimed by another pay run; discard its editable claim or void its posted payroll before paying it again.");
    if (!source.wage) throw new PayrollError("The approved holiday entitlement has no retained dated wage calculation; retry calculation.");
    const priced = priceAdjudicatedHolidayPayment(source.evidence.instruction, source.wage.resolved);
    const component = input.need("stat_holiday", "earning");
    if (component.payment_kind !== "cash") throw new PayrollError("Approved unpaid holiday hours require a cash statutory holiday component; review Payroll components before settling the entitlement.");
    if (typeof component.sequence !== "number" || !Number.isSafeInteger(component.sequence)) throw new PayrollError("The native holiday component has no valid display sequence; review Payroll components before calculating.");
    let allocationId: string | undefined;
    if (!input.simulate) {
      allocationId = randomUUID();
      const inserted = await tx.execute(sql`insert into pay_run_holiday_allocations
        (id,org_id,obligation_id,pay_run_document_id,component_id,amount,hours,rate,currency,source_snapshot,created_by,updated_by)
        values(${allocationId},${input.orgId},${source.id},${input.documentId},${String(component.id)},${priced.amount},${priced.hours},${priced.rate},
          ${source.wage.resolved.currency},${JSON.stringify({ obligation: source.evidence, wage: source.wage })}::jsonb,${input.actorId},${input.actorId}) returning id`);
      if (inserted.rows.length !== 1) throw new PayrollError("The unpaid holiday entitlement could not claim its native payroll settlement.");
    }
    input.lines.push({
      componentId: String(component.id), kind: "earning", description: "Approved unpaid holiday entitlement",
      hours: priced.hours, rate: priced.rate, amount: parseMoney(priced.amount), sequence: Number(component.sequence),
      taxable: component.taxable === true, pensionable: component.pensionable === true, insurable: component.insurable === true,
      vacationable: component.vacationable === true, programApplicability: programApplicabilityFromExclusions(component.program_exclusions),
      nonPeriodic: component.non_periodic === true, taxTreatment: component.tax_treatment as string,
      supplementalWageCategory: component.supplemental_wage_category as Line["supplementalWageCategory"],
      statutoryExemptionCategory: component.statutory_exemption_category as Line["statutoryExemptionCategory"],
      statutoryReportingCategory: component.statutory_reporting_category as string | null,
      includeInDisposableEarnings: component.include_in_disposable_earnings === true,
      paymentKind: "cash", fundedByEntitlementBank: false,
      holidayAllocationId: allocationId,
    });
  }
}
