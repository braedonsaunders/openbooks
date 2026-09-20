import { apportion } from "./recognition.ts";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import {
  existingFinancialChange,
  proposeFinancialChange,
  loadFinancialChange,
  assertFinancialChangeApproved,
  completeFinancialChange,
} from "../platform/financial-changes.ts";
import { assertFinancialChangeAccess } from "../organization/financial-change-access.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { orgReportingFramework } from "../platform/reporting-framework.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import {
  add,
  neg,
  sum,
  isZero,
  cmp,
  fromUnits,
  toUnits,
  roundDiv,
} from "../money/money.ts";
import {
  presentValueOfLevelStream,
  periodRateFromAnnualPercent,
} from "../money/present-value.ts";
import {
  LeaseError,
  leaseRow,
  postLeaseEntry,
  measureLesseeLease,
  classifyLease,
  assertLeaseTermWithinHorizon,
  shortTermExemptionEligible,
  addDays,
  addMonths,
  createLeaseAgreement,
  commenceLease,
  type LeaseRow,
  type LeaseClassificationInputs,
  type CreateLeaseInput,
  withLeaseTransaction,
} from "./leases.ts";

export interface LeaseChangeInput {
  operation:
    "modification" | "remeasurement" | "termination" | "separate_lease";
  effectiveOn: string;
  reason: string;
  idempotencyKey: string;
  /** Contractual proportion of the right of use removed, not a guessed PV ratio. */
  scopeReductionPercent: string;
  settlementPayment: string;
  gainLossAccountId: string;
  remainingTerms?: {
    periods: number;
    payment: string;
    paymentFrequency: "monthly" | "quarterly" | "annual";
    paymentTiming: "advance" | "arrears";
    annualRatePercent: string;
    classificationInputs: LeaseClassificationInputs;
  };
  /** Required for a separate lease: both IFRS 16.44 / ASC 842-10-25-8 criteria. */
  separateLease?: {
    additionalRightOfUse: true;
    commensurateStandalonePrice: true;
    agreement: CreateLeaseInput;
  };
  /** Source/evidence explaining scope, discount-rate and classification judgments. */
  assessment: string;
}
function money(value: unknown, label: string): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null)
    throw new LeaseError(`${label} must be an exact ledger decimal`);
  return fromUnits(toUnits(exact));
}
const periodsPerYear = { monthly: 12, quarterly: 4, annual: 1 };

/** IFRS 16.39–46 / ASC 842-10-25: reduce the extinguished right, then
 * remeasure remaining unpaid cash flows. A negative ROU adjustment is capped
 * at its carrying amount; the excess goes to gain/loss, never a negative asset. */
export function measureLeaseChange(args: {
  liability: string;
  rouAsset: string;
  scopeReductionPercent: string;
  newLiability: string;
  settlementPayment: string;
}) {
  const liability = money(args.liability, "Liability"),
    rouAsset = money(args.rouAsset, "ROU asset");
  const newLiability = money(args.newLiability, "Revised liability"),
    settlement = money(args.settlementPayment, "Settlement payment");
  const percent = toUnits(money(args.scopeReductionPercent, "Scope reduction"));
  if (
    [liability, rouAsset, newLiability].some((v) => cmp(v, "0") < 0) ||
    percent < 0n ||
    percent > 1_000_000n
  )
    throw new LeaseError(
      "carrying amounts must be non-negative and scope reduction must be between 0 and 100 percent",
    );
  const removedLiability = fromUnits(
    roundDiv(toUnits(liability) * percent, 1_000_000n),
  );
  const removedRou = fromUnits(
    roundDiv(toUnits(rouAsset) * percent, 1_000_000n),
  );
  const remeasurement = add(
    newLiability,
    neg(add(liability, neg(removedLiability))),
  );
  const revisedRou = sum([rouAsset, neg(removedRou), remeasurement]);
  const newRou = cmp(revisedRou, "0") < 0 ? "0.0000" : revisedRou;
  const liabilityDelta = add(newLiability, neg(liability));
  const rouDelta = add(newRou, neg(rouAsset));
  // Credit-positive gain. The journal debits ROU delta, credits liability
  // delta and cash settlement, and credits this balancing gain.
  const gain = sum([rouDelta, neg(liabilityDelta), neg(settlement)]);
  return {
    newLiability,
    newRou,
    liabilityDelta,
    rouDelta,
    removedLiability,
    removedRou,
    gain,
    settlement,
  };
}

type PlanRow = {
  id: string;
  sequence: number;
  revision: number;
  period_start: string;
  period_end: string;
  due_on: string;
  payment: string;
  interest: string;
  amortization: string | null;
  single_cost: string | null;
  rou_adjustment: string | null;
  payment_posted_at: string | null;
  accrual_posted_at: string | null;
};
async function snapshot(
  tx: SqlExecutor,
  orgId: string,
  lease: LeaseRow,
  effectiveOn: string,
) {
  if (!isIsoCalendarDate(effectiveOn))
    throw new LeaseError("effective date must be a calendar date (YYYY-MM-DD)");
  if (lease.status !== "active")
    throw new LeaseError("only an active lease can be changed");
  const rows = (
    await tx.execute<PlanRow>(sql`
    select id,sequence,revision,period_start::text,period_end::text,due_on::text,
      payment::text,interest::text,amortization::text,single_cost::text,rou_adjustment::text,
      payment_posted_at::text,accrual_posted_at::text
     from lease_agreement_schedule_lines where org_id=${orgId} and lease_id=${lease.id}
       and revision=${lease.revision} and superseded_by_change_id is null order by sequence for update
  `)
  ).rows;
  const previous = lease.last_change_id
    ? await loadFinancialChange(tx, orgId, lease.last_change_id)
    : null;
  const startsOn =
    previous?.effective_on ??
    (lease.opening_balances_as_of
      ? addDays(lease.opening_balances_as_of, 1)
      : lease.commencement_on);
  if (effectiveOn < startsOn)
    throw new LeaseError(
      "the effective date precedes the current lease revision; record a correcting change after its effective date",
    );
  if (
    rows.some(
      (r) =>
        (r.payment_posted_at &&
          r.due_on >= effectiveOn &&
          !isZero(r.payment)) ||
        (r.accrual_posted_at && r.period_end >= effectiveOn),
    )
  ) {
    throw new LeaseError(
      "lease events are already posted on or after this effective date; choose the first unposted effective date and record the correction as an adjustment",
    );
  }
  if (
    rows.some(
      (r) =>
        (r.due_on < effectiveOn && !r.payment_posted_at) ||
        (r.period_end < effectiveOn && !r.accrual_posted_at),
    )
  ) {
    throw new LeaseError(
      `post the lease schedule through ${addDays(effectiveOn, -1)} before proposing this change`,
    );
  }
  const baseLiability = String(
    previous?.result?.newLiability ?? lease.initial_liability ?? "0",
  );
  const baseRou = String(
    previous?.result?.newRou ?? lease.initial_rou_asset ?? "0",
  );
  const liability = sum([
    baseLiability,
    ...rows.filter((r) => r.payment_posted_at).map((r) => neg(r.payment)),
    ...rows.filter((r) => r.accrual_posted_at).map((r) => r.interest),
  ]);
  const rou = sum([
    baseRou,
    ...rows
      .filter((r) => r.accrual_posted_at)
      .map((r) => neg(r.amortization ?? r.rou_adjustment ?? "0")),
  ]);
  const partial = rows.find(
    (r) =>
      r.period_start < effectiveOn &&
      r.period_end >= effectiveOn &&
      !r.accrual_posted_at,
  );
  // Actual days within the current contractual period, exact ratio. The stub
  // is separately posted at the change date, never written into the old row.
  const prorate = (value: string | null) => {
    if (!partial || value === null) return "0.0000";
    const elapsed = BigInt(
      (Date.parse(effectiveOn) - Date.parse(partial.period_start)) / 86400000,
    );
    const days = BigInt(
      (Date.parse(addDays(partial.period_end, 1)) -
        Date.parse(partial.period_start)) /
        86400000,
    );
    return fromUnits(roundDiv(toUnits(value) * elapsed, days));
  };
  const stubInterest = prorate(partial?.interest ?? null);
  const stubAmortization = prorate(partial?.amortization ?? null);
  const stubCost = prorate(partial?.single_cost ?? null);
  const stubRou =
    lease.classification === "finance"
      ? stubAmortization
      : add(stubCost, neg(stubInterest));
  const prepaid = lease.exemption
    ? sum([
        String(previous?.result?.prepaidCarrying ?? "0"),
        ...rows.map((r) =>
          sum([
            r.payment_posted_at ? r.payment : "0",
            r.accrual_posted_at ? neg(r.single_cost ?? "0") : "0",
          ]),
        ),
      ])
    : "0.0000";
  return {
    beforeState: { lease, rows, framework: await orgReportingFramework(orgId) },
    liability: add(liability, stubInterest),
    rou: add(rou, neg(stubRou)),
    stubInterest,
    stubAmortization,
    stubCost,
    stubRou,
    prepaid: add(prepaid, neg(stubCost)),
  };
}
function validateInput(input: LeaseChangeInput, lease: LeaseRow) {
  if (
    ![
      "modification",
      "remeasurement",
      "termination",
      "separate_lease",
    ].includes(input.operation)
  )
    throw new LeaseError("select a lease change type");
  if (
    typeof input.assessment !== "string" ||
    input.assessment.trim().length < 8
  )
    throw new LeaseError(
      "record the contractual scope, discount-rate and classification assessment",
    );
  const reduction = money(input.scopeReductionPercent, "Scope reduction");
  const settlement = money(input.settlementPayment, "Settlement payment");
  if (cmp(reduction, "0") < 0 || cmp(reduction, "100") > 0)
    throw new LeaseError("scope reduction must be 0–100 percent");
  if (input.operation === "termination" && cmp(reduction, "100") !== 0)
    throw new LeaseError(
      "full termination must remove 100 percent of the right of use",
    );
  if (input.operation === "remeasurement" && !isZero(reduction))
    throw new LeaseError(
      "a scope reduction is a modification, not a remeasurement",
    );
  if (input.operation === "separate_lease") {
    if (
      !input.separateLease?.additionalRightOfUse ||
      !input.separateLease?.commensurateStandalonePrice
    )
      throw new LeaseError(
        "a separate lease requires an additional right of use priced commensurately with its standalone price",
      );
    if (input.separateLease.agreement.subsidiaryId !== lease.subsidiary_id)
      throw new LeaseError(
        "a separate lease from this modification must belong to the same legal entity",
      );
    if (input.separateLease.agreement.commencementOn !== input.effectiveOn)
      throw new LeaseError(
        "the added lease must commence on the approved effective date",
      );
    if (!isZero(reduction) || !isZero(settlement))
      throw new LeaseError(
        "a separate lease must not extinguish or settle the original lease",
      );
  } else if (input.operation !== "termination") {
    const terms = input.remainingTerms;
    if (!terms)
      throw new LeaseError("enter the remaining contractual payment terms");
    assertLeaseTermWithinHorizon(terms.periods, terms.paymentFrequency);
    if (cmp(money(terms.payment, "Payment"), "0") <= 0)
      throw new LeaseError("remaining payment must be positive");
    if (canonicalDecimal(terms.annualRatePercent, 10) === null)
      throw new LeaseError("enter an exact annual discount rate");
    if (terms.paymentTiming !== "advance" && terms.paymentTiming !== "arrears")
      throw new LeaseError("payment timing must match the agreement");
  }
}

function revisionMeasurement(
  lease: LeaseRow,
  state: Awaited<ReturnType<typeof snapshot>>,
  input: LeaseChangeInput,
) {
  const terms =
    input.operation === "termination" || input.operation === "separate_lease"
      ? null
      : input.remainingTerms!;
  const frequencyMonths = terms
    ? assertLeaseTermWithinHorizon(terms.periods, terms.paymentFrequency)
    : 0;
  const classificationInputs = terms
    ? {
        ...terms.classificationInputs,
        leaseTermMonths: terms.periods * frequencyMonths,
      }
    : null;
  const model = terms
    ? classifyLease(classificationInputs!, state.beforeState.framework).model
    : lease.classification;
  const exemptionContinues =
    !!terms &&
    !!lease.exemption &&
    (lease.exemption === "low_value"
      ? state.beforeState.framework === "ifrs"
      : shortTermExemptionEligible({
          leaseTermMonths: terms.periods * frequencyMonths,
          purchaseOptionReasonablyCertain:
            terms.classificationInputs.purchaseOptionReasonablyCertain,
        }));
  if (
    exemptionContinues &&
    terms?.paymentTiming === "advance" &&
    !lease.cost_clearing_account_id
  ) {
    throw new LeaseError(
      "an exempt advance schedule requires the prepaid expense clearing account on the lease",
    );
  }
  const newLiability =
    terms && !exemptionContinues
      ? presentValueOfLevelStream({
          payment: terms.payment,
          periods: terms.periods,
          rate: periodRateFromAnnualPercent(
            terms.annualRatePercent,
            periodsPerYear[terms.paymentFrequency],
          ),
          timing: terms.paymentTiming,
        })
      : "0.0000";
  let measured = measureLeaseChange({
    liability: lease.exemption ? "0" : state.liability,
    rouAsset: lease.exemption ? "0" : state.rou,
    newLiability,
    scopeReductionPercent: input.scopeReductionPercent,
    settlementPayment: input.settlementPayment,
  });
  const removedPrepaid = lease.exemption
    ? terms
      ? fromUnits(
          roundDiv(
            toUnits(state.prepaid) * toUnits(input.scopeReductionPercent),
            1_000_000n,
          ),
        )
      : state.prepaid
    : "0.0000";
  const remainingPrepaid = lease.exemption
    ? add(state.prepaid, neg(removedPrepaid))
    : "0.0000";
  const prepaidCarrying = exemptionContinues ? remainingPrepaid : "0.0000";
  if (lease.exemption) {
    measured = {
      ...measured,
      gain: neg(add(removedPrepaid, measured.settlement)),
    };
    if (terms && !exemptionContinues) {
      const newRou = add(newLiability, remainingPrepaid);
      if (cmp(newRou, "0") < 0)
        throw new LeaseError(
          "revised payments do not cover the accrued lease balance; include its settlement in the approved terms",
        );
      measured = { ...measured, newRou, rouDelta: newRou };
    }
  }
  return {
    terms,
    model,
    classificationInputs,
    exemptionContinues,
    newLiability,
    measured,
    removedPrepaid,
    remainingPrepaid,
    prepaidCarrying,
  };
}
function proposalState(
  lease: LeaseRow,
  state: Awaited<ReturnType<typeof snapshot>>,
  input: LeaseChangeInput,
) {
  if (input.operation === "separate_lease") {
    const agreement = input.separateLease!.agreement;
    if (agreement.openingBalances)
      throw new LeaseError(
        "an added right of use is a new lease, not a carried-in opening balance",
      );
    if (agreement.exemption) {
      const months = assertLeaseTermWithinHorizon(
        agreement.termPeriods,
        agreement.paymentFrequency,
      );
      if (
        agreement.exemption === "low_value" &&
        state.beforeState.framework !== "ifrs"
      )
        throw new LeaseError("low-value recognition exemption requires IFRS");
      if (
        agreement.exemption === "short_term" &&
        !shortTermExemptionEligible({
          leaseTermMonths: agreement.termPeriods * months,
          purchaseOptionReasonablyCertain:
            agreement.classificationInputs?.purchaseOptionReasonablyCertain,
        })
      )
        throw new LeaseError(
          "the added lease does not qualify for the short-term exemption",
        );
      return {
        ...state.beforeState,
        preview: {
          newLiability: "0.0000",
          newRou: "0.0000",
          settlement: "0.0000",
        },
      };
    }
    const measurement = measureLesseeLease({
      payment: agreement.paymentAmount,
      periods: agreement.termPeriods,
      annualRatePercent: agreement.annualDiscountRatePercent,
      periodsPerYear: periodsPerYear[agreement.paymentFrequency],
      timing: agreement.paymentTiming ?? "arrears",
      model: classifyLease(
        agreement.classificationInputs ?? {},
        state.beforeState.framework,
      ).model,
      initialDirectCosts: agreement.initialDirectCosts,
      prepayments: agreement.prepayments,
      incentives: agreement.incentives,
    });
    return {
      ...state.beforeState,
      preview: {
        newLiability: measurement.liability,
        newRou: measurement.rouAsset,
        settlement: measurement.initialPayment,
      },
    };
  }
  const revision = revisionMeasurement(lease, state, input);
  return {
    ...state.beforeState,
    preview: {
      ...revision.measured,
      prepaidCarrying: revision.prepaidCarrying,
      carryingLiability: state.liability,
      carryingRou: state.rou,
      stubInterest: state.stubInterest,
      stubRou: state.stubRou,
      dayCountPolicy: "actual_days_within_contractual_period",
    },
  };
}

export async function proposeLeaseChange(
  orgId: string,
  leaseId: string,
  actorId: string,
  input: LeaseChangeInput,
) {
  return withLeaseTransaction(orgId, async (tx) => {
    const lease = await leaseRow(orgId, leaseId, tx);
    await assertFinancialChangeAccess(tx, {
      orgId,
      actorId,
      subsidiaryIds: [lease.subsidiary_id],
      permission: "assets.manage",
      feature: "fixedAssets",
    });
    const proposal = {
      orgId,
      actorId,
      subsidiaryId: lease.subsidiary_id,
      domain: "lease" as const,
      subjectId: leaseId,
      operation: input.operation,
      effectiveOn: input.effectiveOn,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      payload: input as unknown as Record<string, unknown>,
    };
    const replay = await existingFinancialChange(tx, proposal);
    if (replay) return { changeId: replay };
    validateInput(input, lease);
    const state = await snapshot(tx, orgId, lease, input.effectiveOn);
    const changeId = await proposeFinancialChange(tx, {
      ...proposal,
      beforeState: proposalState(lease, state, input),
    });
    return { changeId };
  });
}

export async function applyLeaseChange(
  orgId: string,
  changeId: string,
  actorId: string,
): Promise<Record<string, unknown>> {
  return withLeaseTransaction(orgId, async (tx) => {
    // Lock the aggregate before its change request, consistently with proposal
    // and posting. The initial identity read holds no change-row lock.
    const identity = (
      await tx.execute<{ subject_id: string }>(
        sql`select subject_id from financial_changes where org_id=${orgId} and id=${changeId} and domain='lease'`,
      )
    ).rows[0];
    if (!identity) throw new LeaseError("lease change not found");
    const lease = await leaseRow(orgId, identity.subject_id, tx);
    await assertFinancialChangeAccess(tx, {
      orgId,
      actorId,
      subsidiaryIds: [lease.subsidiary_id],
      permission: "assets.manage",
      feature: "fixedAssets",
    });
    const change = await loadFinancialChange(tx, orgId, changeId);
    if (change.status === "applied") return change.result!;
    const input = change.payload as unknown as LeaseChangeInput;
    validateInput(input, lease);
    const state = await snapshot(tx, orgId, lease, input.effectiveOn);
    assertFinancialChangeApproved(change, {
      domain: "lease",
      subjectId: lease.id,
      beforeState: proposalState(lease, state, input),
    });
    if (input.operation === "separate_lease") {
      const created = await createLeaseAgreement(
        orgId,
        actorId,
        input.separateLease!.agreement,
      );
      const commenced = await commenceLease(orgId, created.leaseId, actorId);
      const result = {
        separateLeaseId: created.leaseId,
        commencementEntryId: commenced.commencementEntryId,
      };
      await completeFinancialChange(tx, orgId, changeId, actorId, result);
      return result;
    }
    const entryIds: string[] = [];
    const post = async (
      suffix: string,
      lines: { accountId: string; amount: string }[],
    ) => {
      if (lines.every((l) => isZero(l.amount))) return;
      entryIds.push(
        await postLeaseEntry(tx, {
          orgId,
          lease,
          date: input.effectiveOn,
          entryNumber: `LEASE-CH-${changeId}-${suffix}`,
          memo: `${lease.lease_number}: ${input.reason}`,
          lines,
          actorId,
        }),
      );
    };
    const revision = lease.revision + 1;
    const max = (
      await tx.execute<{ sequence: number }>(
        sql`select coalesce(max(sequence),0)::int as sequence from lease_agreement_schedule_lines where org_id=${orgId} and lease_id=${lease.id}`,
      )
    ).rows[0]!.sequence;
    // Recognize the elapsed stub using the OLD agreement before remeasurement.
    await post(
      "STUB",
      lease.exemption
        ? [
            {
              accountId: lease.lease_expense_account_id,
              amount: state.stubCost,
            },
            {
              accountId:
                lease.cost_clearing_account_id ??
                lease.lease_liability_account_id,
              amount: neg(state.stubCost),
            },
          ]
        : lease.classification === "finance"
          ? [
              {
                accountId: lease.interest_expense_account_id,
                amount: state.stubInterest,
              },
              {
                accountId: lease.lease_liability_account_id,
                amount: neg(state.stubInterest),
              },
              {
                accountId: lease.amortization_expense_account_id,
                amount: state.stubAmortization,
              },
              {
                accountId: lease.rou_asset_account_id,
                amount: neg(state.stubRou),
              },
            ]
          : [
              {
                accountId: lease.lease_expense_account_id,
                amount: state.stubCost,
              },
              {
                accountId: lease.lease_liability_account_id,
                amount: neg(state.stubInterest),
              },
              {
                accountId: lease.rou_asset_account_id,
                amount: neg(state.stubRou),
              },
            ],
    );
    const {
      terms,
      model,
      classificationInputs,
      exemptionContinues,
      newLiability,
      measured,
      prepaidCarrying,
      removedPrepaid,
      remainingPrepaid,
    } = revisionMeasurement(lease, state, input);
    if (lease.exemption) {
      const removed = removedPrepaid,
        remaining = remainingPrepaid;
      if (terms && !exemptionContinues) {
        const newRou = measured.newRou;
        await post("RECOGNIZE", [
          { accountId: lease.rou_asset_account_id, amount: newRou },
          {
            accountId: lease.lease_liability_account_id,
            amount: neg(newLiability),
          },
          {
            accountId:
              lease.cost_clearing_account_id ??
              lease.lease_liability_account_id,
            amount: neg(remaining),
          },
        ]);
      }
      await post("ADJUST", [
        {
          accountId:
            lease.cost_clearing_account_id ?? lease.lease_liability_account_id,
          amount: neg(removed),
        },
        {
          accountId: lease.payment_account_id,
          amount: neg(measured.settlement),
        },
        {
          accountId: input.gainLossAccountId,
          amount: add(removed, measured.settlement),
        },
      ]);
    } else
      await post("ADJUST", [
        { accountId: lease.rou_asset_account_id, amount: measured.rouDelta },
        {
          accountId: lease.lease_liability_account_id,
          amount: neg(measured.liabilityDelta),
        },
        {
          accountId: lease.payment_account_id,
          amount: neg(measured.settlement),
        },
        { accountId: input.gainLossAccountId, amount: neg(measured.gain) },
      ]);
    const superseded =
      await tx.execute(sql`update lease_agreement_schedule_lines set superseded_by_change_id=${changeId},updated_at=now(),updated_by=${actorId}
      where org_id=${orgId} and lease_id=${lease.id} and superseded_by_change_id is null and accrual_posted_at is null returning id`);
    if (
      superseded.rows.length !==
      state.beforeState.rows.filter((row) => !row.accrual_posted_at).length
    )
      throw new LeaseError(
        "future lease rows changed while applying the approved revision",
      );
    if (terms) {
      const months = assertLeaseTermWithinHorizon(
        terms.periods,
        terms.paymentFrequency,
      );
      const prepaidAllocation = apportion(
        toUnits(prepaidCarrying),
        new Array<number>(terms.periods).fill(1),
      ).map(fromUnits);
      const schedule = exemptionContinues
        ? Array.from({ length: terms.periods }, (_, i) => ({
            sequence: i + 1,
            opening: "0",
            payment: terms.payment,
            interest: "0",
            closing: "0",
            singleCost: add(terms.payment, prepaidAllocation[i]!),
            amortization: undefined,
            rouAdjustment: undefined,
          }))
        : measureLesseeLease({
            payment: terms.payment,
            periods: terms.periods,
            annualRatePercent: terms.annualRatePercent,
            periodsPerYear: periodsPerYear[terms.paymentFrequency],
            timing: terms.paymentTiming,
            model,
            openingLiability: newLiability,
            openingRouAsset: measured.newRou,
          }).schedule;
      for (let i = 0; i < schedule.length; i++) {
        const line = schedule[i]!,
          start = addMonths(input.effectiveOn, i * months),
          end = addDays(addMonths(input.effectiveOn, (i + 1) * months), -1);
        await tx.execute(sql`insert into lease_agreement_schedule_lines
          (id,org_id,lease_id,sequence,revision,due_on,period_start,period_end,opening_liability,payment,interest,principal,closing_liability,
           amortization,single_cost,rou_adjustment,created_by,updated_by)
          values (${randomUUID()},${orgId},${lease.id},${max + i + 1},${revision},${terms.paymentTiming === "advance" ? start : end},${start},${end},
            ${line.opening},${line.payment},${line.interest},${add(line.payment, neg(line.interest))},${line.closing},
            ${line.amortization ?? null},${line.singleCost ?? null},${line.rouAdjustment ?? null},${actorId},${actorId})`);
      }
    }
    const updated =
      await tx.execute(sql`update lease_agreements set revision=${revision},last_change_id=${changeId},
      status=${terms ? "active" : "terminated"},term_periods=${terms?.periods ?? lease.term_periods},
      payment_amount=${terms?.payment ?? lease.payment_amount},payment_frequency=${terms?.paymentFrequency ?? lease.payment_frequency},
      payment_timing=${terms?.paymentTiming ?? lease.payment_timing},annual_discount_rate_percent=${terms?.annualRatePercent ?? lease.annual_discount_rate_percent},
      classification=${model},classification_inputs=${JSON.stringify(classificationInputs ?? lease.classification_inputs)}::jsonb,exemption=${exemptionContinues ? lease.exemption : null},updated_by=${actorId},updated_at=now()
      where id=${lease.id} and org_id=${orgId} and revision=${lease.revision} returning id`);
    if (updated.rows.length !== 1)
      throw new LeaseError(
        "lease changed while applying the approved revision",
      );
    const result = {
      ...measured,
      prepaidCarrying,
      revision,
      entryIds,
      stub: {
        interest: state.stubInterest,
        rou: state.stubRou,
        cost: state.stubCost,
      },
      dayCountPolicy: "actual_days_within_contractual_period",
      status: terms ? "active" : "terminated",
    };
    await completeFinancialChange(tx, orgId, changeId, actorId, result);
    return result;
  });
}
