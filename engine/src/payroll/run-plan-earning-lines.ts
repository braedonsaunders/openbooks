import { vacationBaseIncluded } from "./component-statutory-treatment.ts";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { cmp, mulDecimal, mulPercent, roundMoney } from "../money/money.ts";
import { negMoney, type Money } from "../money/brands.ts";
import { payrollPack } from "./packs.ts";
import {
  entitlementMoneyValue,
  planMovementsForStub,
  type EntitlementPlan,
  type EntitlementWarning,
} from "./entitlements.ts";
import { allocateProportionally } from "./run-allocation.ts";
import { type Line, earningsBase, totalHours, earningJobBuckets } from "./run-stub-records.ts";
import type { DeclaredVacationAccrualInput } from "./run-vacation-accrual-input.ts";
import { resolveEntitlementWage } from "./run-entitlement-valuation.ts";

/** Earning lines driven by union fringe agreements and entitlement plan movements, appended to each stub during calculation. */

/**
 * Union fringes and dues under a collective agreement. Each TOTAL is
 * computed once and then allocated across jobs (`allocateProportionally`),
 * so an employer fringe and the identically-rated employee line agree to
 * the cent regardless of how hours or earnings fell across jobs.
 */
export async function appendUnionFringeLines(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    emp: Record<string, string | null>;
    country: string;
    lines: Line[];
  },
): Promise<void> {
  const { orgId, emp, country, lines } = args;
  // Union fringes and dues (collective agreement)
  if (emp.union_agreement_id) {
    const { fringesForEmployee } = await import("./union.ts");
    const fringes = await fringesForEmployee(
      tx,
      orgId,
      emp.union_agreement_id,
      emp.union_classification_id ?? null,
    );
    for (const fringe of fringes) {
      if (!fringe.component_id) {
        throw new PayrollError(`union fringe ${fringe.code} has no linked pay component`);
      }
      const kind: Line["kind"] =
        fringe.paid_by === "employer" ? "employer_contribution" : "deduction";
      // The tax treatment of employee-paid dues is the PACK's declaration, not
      // a constant: 'union_dues' is a T4127 factor-U1 key, and stamping it on
      // every employee-paid fringe in every country made a CRA deduction the
      // world's default. A pack that declares null (the US — dues are post-tax
      // under the TCJA) gets dues lines with no treatment at all.
      const taxTreatment =
        fringe.paid_by === "employee"
          ? (payrollPack(country).employeeUnionDuesTaxTreatment ?? undefined)
          : undefined;
      // `job_costed` is a property of the FRINGE, not of how it is calculated:
      // in construction that flag exists so the fund lands on the job. Both
      // calculation shapes therefore honour it — the percent-of-gross branch
      // used to ignore it entirely and post one untagged line.
      const jobCosted = fringe.job_costed && kind === "employer_contribution";
      if (fringe.calc === "per_hour_worked") {
        // The TOTAL is computed once and then allocated, never summed from
        // independently rounded per-job amounts: $2.375/h × 10.5h is 24.94
        // whole and 24.93 as three job lines, which made an employer fringe
        // and the identically-rated employee line disagree by a cent purely
        // because of how the hours fell across jobs.
        const hours = totalHours(lines);
        const amount = roundMoney(mulDecimal(fringe.value, hours), 2) as Money;
        if (cmp(amount, "0") === 0) continue;
        const hourLines = lines.filter((l) => l.kind === "earning" && l.hours);
        const splits = jobCosted
          ? allocateProportionally(
              amount,
              hourLines.map((l) => ({ weight: l.hours!, target: l })),
            )
          : [];
        if (splits.length > 0) {
          for (const split of splits) {
            if (cmp(split.amount, "0") === 0) continue;
            lines.push({
              componentId: fringe.component_id,
              kind,
              description: fringe.name,
              hours: split.target.hours,
              rate: fringe.value,
              amount: split.amount,
              projectId: split.target.projectId ?? null,
              departmentId: split.target.departmentId ?? null,
              sequence: 300 + fringe.sequence,
              taxTreatment,
            });
          }
        } else {
          lines.push({
            componentId: fringe.component_id,
            kind,
            description: fringe.name,
            hours,
            rate: fringe.value,
            amount,
            sequence: 300 + fringe.sequence,
            taxTreatment,
          });
        }
      } else {
        const amount = mulPercent(earningsBase(lines), fringe.value, 2) as Money;
        if (cmp(amount, "0") === 0) continue;
        // Percent-of-gross splits proportional to the earnings it is a percent
        // OF — including the untagged share, which stays untagged rather than
        // being pushed onto the jobs.
        const buckets = jobCosted ? earningJobBuckets(lines) : [];
        const splits = buckets.some((b) => b.projectId)
          ? allocateProportionally(
              amount,
              buckets.map((b) => ({ weight: b.weight, target: b })),
            )
          : [];
        if (splits.length > 0) {
          for (const split of splits) {
            if (cmp(split.amount, "0") === 0) continue;
            lines.push({
              componentId: fringe.component_id,
              kind,
              description: fringe.name,
              amount: split.amount,
              sequence: 300 + fringe.sequence,
              taxTreatment,
              projectId: split.target.projectId,
              departmentId: split.target.departmentId,
            });
          }
        } else {
          lines.push({
            componentId: fringe.component_id,
            kind,
            description: fringe.name,
            amount,
            sequence: 300 + fringe.sequence,
            taxTreatment,
          });
        }
      }
    }
  }
}

/**
 * Everything that banks: ONE engine call over the stub's bankable earning
 * lines, honouring scoped caps and service tiers, projected onto the stub
 * as accrual / payout / repayment lines and queued as ledger movements.
 * Returns the vacation accrued this period, for the stub header.
 */
export async function applyEntitlementPlanMovements(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    documentId: string;
    employeePartyId: string;
    employmentId?: string;
    policyDate?: string;
    payDate: string;
    payCurrency: string;
    /** Employee display name, for the unvalued-hours refusal. */
    employeeName: string;
    vacationPercent: string | null;
    payVacationInCash: boolean;
    excludeVacationAccrual?: boolean;
    vacationPlan: EntitlementPlan | null;
    plans: EntitlementPlan[];
    lines: Line[];
    entitlementMovements: Awaited<ReturnType<typeof planMovementsForStub>>["movements"];
    entitlementWarnings: EntitlementWarning[];
    declaredVacationAccruals?: ReadonlyMap<string, DeclaredVacationAccrualInput>;
  },
): Promise<string> {
  const {
    orgId,
    documentId,
    employeePartyId,
    payDate,
    payCurrency,
    employeeName,
    vacationPercent,
    payVacationInCash,
    vacationPlan,
    plans,
    lines,
    entitlementMovements,
    entitlementWarnings,
  } = args;
  let vacationAccrued = "0";
  if ((args.declaredVacationAccruals?.size ?? 0) > 0 && plans.length === 0) {
    throw new PayrollError(
      "A declared vacation accrual requires an active vacation entitlement plan; configure the plan before calculating.",
    );
  }
  // Everything that banks: one call, honouring scoped caps and service tiers.
  if (plans.length > 0) {
    const declaredAccrualValues = new Map<string, { amount: string; note: string }>();
    for (const input of args.declaredVacationAccruals?.values() ?? []) {
      const plan = plans.find((candidate) => candidate.accrualComponentId === input.componentId);
      if (
        !plan ||
        plan.systemKey !== "vacation" ||
        plan.unit !== "money" ||
        plan.direction !== "accrue"
      ) {
        throw new PayrollError(
          "The declared vacation accrual no longer matches one active money vacation plan; correct the audited input and recalculate.",
        );
      }
      declaredAccrualValues.set(plan.id, {
        amount: input.amount,
        note: JSON.stringify({
          kind: "declared_vacation_accrual",
          reason: input.reason,
          sourceReference: input.sourceReference,
          requestId: input.requestId,
        }),
      });
    }
    const bankablePlans =
      (payVacationInCash || args.excludeVacationAccrual) && vacationPlan
        ? plans.filter((p) => p.id !== vacationPlan.id)
        : plans;
    if (
      [...declaredAccrualValues.keys()].some(
        (planId) => !bankablePlans.some((plan) => plan.id === planId),
      )
    ) {
      throw new PayrollError(
        "A declared vacation accrual requires the vacation bank to accrue on this cheque; review the employee's effective vacation method and recalculate.",
      );
    }
    // Each plan excludes its own settlement inside planMovementsForStub.
    // Other bank payouts remain earnings under their declared eligibility;
    // deferred wages can earn vacation when the wage component allows it.
    // Deposit funding stays in the basis so its cash reversal nets the wages
    // being banked away.
    const { movements, warnings } = await planMovementsForStub(tx, {
      orgId,
      employeePartyId,
      employmentId: args.employmentId,
      policyDate: args.policyDate,
      movementDate: payDate,
      payRunDocumentId: documentId,
      earnings: lines
        .filter((l) => l.kind === "earning" && !l.accrualOnly)
        .map((l) => ({
          componentId: l.componentId,
          amount: l.amount,
          hours: l.hours ?? null,
          bankable: vacationBaseIncluded(l),
        })),
      plans: bankablePlans,
      // The caller supplies the effective employee election and service
      // policy rate already used for cash payment. Both representations
      // therefore preserve the same higher personal vacation floor.
      employeeAccrualValues: vacationPlan
        ? new Map([[vacationPlan.id, String(vacationPercent ?? "0")]])
        : undefined,
      declaredAccrualValues,
    });
    entitlementWarnings.push(...warnings);
    // The hours bank uses the same transaction-bound wage and currency as the
    // cheque, so its accrual and payout lines cannot price foreign wages raw.
    const resolvedWage = await resolveEntitlementWage(
      tx,
      orgId,
      employeePartyId,
      payDate,
      payCurrency,
      true,
    );
    const wage = resolvedWage && cmp(resolvedWage.wage, "0") > 0 ? resolvedWage.wage : null;
    for (const movement of movements) {
      if (!movement.componentId) continue;
      const plan = plans.find((p) => p.id === movement.planId)!;
      // Stub lines pay MONEY, never the plan's unit — an hours-plan movement
      // of 8 hours values at the wage ($240 at $30/h), and refuses by name
      // when no wage resolves. The ledger movement queued below stays in the
      // plan's unit.
      const money = entitlementMoneyValue({ plan, amount: movement.amount, wage, employeeName });
      if (movement.kind === "accrual") {
        // Employer-side accrual: DR burden / CR the plan's liability account,
        // exactly as the old vacation_accrual line did.
        lines.push({
          componentId: movement.componentId,
          kind: "employer_contribution",
          description: plan.name,
          amount: money,
          sequence: 240,
          accrualOnly: true,
        });
        if (plan.systemKey === "vacation") vacationAccrued = money;
      } else if (movement.kind === "payout") {
        lines.push({
          componentId: movement.componentId,
          kind: "earning",
          description: `${plan.name} payout`,
          amount: negMoney(money),
          hours: movement.hours ?? undefined,
          sequence: 46,
          entitlementSettlementPlanId: plan.id,
          entitlementMovementKey: `${plan.id}:payout`,
        });
      } else if (movement.kind === "repayment") {
        // 'owe' plans recoup through a deduction — the employee repays what
        // the employer carried during their leave.
        lines.push({
          componentId: movement.componentId,
          kind: "deduction",
          description: plan.name,
          amount: money,
          sequence: 180,
        });
      }
      entitlementMovements.push(movement);
    }
  }
  return vacationAccrued;
}
