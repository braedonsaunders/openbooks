import type { CaBonusIncomeReferenceSource } from "./canada/bonus-income-reference.ts";

import { recurringBenefitsRunSource } from "./benefit-plan-inputs.ts";

import { EMPTY_PERIOD_PRIORS } from "./period-priors.ts";

/**
 * Pay-run calculation driver: capture, dry-run/simulation, and the calculating transaction.
 *
 * Extracted verbatim from engine/src/payroll/run.ts; bodies preserve exact
 * math, transaction/lock sequencing, and refusal identity.
 */
import { type PayrollSubsidiaryScope } from "./scope.ts";

import { DrizzleQueryError, sql } from "drizzle-orm";

import { db, withTransactionSavepoint } from "../platform/db.ts";

import { PayrollError } from "./error.ts";

import { add } from "../money/money.ts";

import { resolveEmployeePayrollContext } from "./packs.ts";

import { installablePackOrThrow } from "./run-stub-records.ts";

import {
  payRunCalculationSourceDigest,
  payRunCalculationSource,
  type PayRunCalculationError,
  payRunCalculationRefusals,
  payRunRefusalDigest,
  parsePayRunCalculationErrors,
  parsePayRunRefusalAcknowledgement,
} from "./run-calculation-evidence.ts";

import { calculateStub } from "./run-stub-compute.ts";

import {
  capturePayRunCalculationEvidence,
  recordPayRunCalculationEvent,
} from "./run-calculation-audit.ts";

import { PERIODIC_RUN_TYPES } from "./run-contracts.ts";

import { consumeLeavePayrollInputs, releaseLeavePayrollInputs } from "./leave-payroll-inputs.ts";

import {
  consumeAllowancePayrollInputs,
  releaseAllowancePayrollInputs,
} from "./allowance-payroll-inputs.ts";

import { type PayPeriodPriors } from "./period-priors.ts";

import { type PayRunCalculation, captureCalculatedStubs } from "./run-captured-stubs.ts";

import type { StubComputationInput } from "./run-calculation-support.ts";

/** Rolls the calculation transaction back while carrying its result out. */
export class DryRunRollback extends Error {
  constructor(readonly result: PayRunCalculation) {
    super("dry run");
  }
}

export interface CalculatePayRunInput {
  orgId: string;
  documentId: string;
  actorId: string;
  /**
   * Compute and total the run without persisting anything — the operator sees
   * exactly what a real calculation would produce (including per-employee
   * errors) and the run stays in whatever state it was in.
   */
  dryRun?: boolean;
  /**
   * Recalculate a run that is already COMMITTED, as it would calculate today,
   * hand the caller the stubs it produced, and roll every bit of it back.
   *
   * This is what makes retroactive pay one calculation rather than two. "What
   * would this already-paid period pay under the rate that has since been
   * backdated over it" is exactly the question `calculateStub` answers, and
   * answering it a second time somewhere else would be a second definition of
   * what a period pays — which drifts, silently, in money.
   *
   * Simulation IMPLIES `dryRun` unconditionally here, not at the call site: the
   * two guards below (already committed, document not editable) are the only
   * things standing between this and rewriting a posted payroll, so the
   * rollback is not left to a caller remembering to ask for it. What the
   * transaction does — delete this run's stubs, recalculate them, read them
   * back — is discarded in full by the `DryRunRollback` throw.
   *
   * A simulation is NOT the period as it was paid. It sees today's
   * configuration by design (that is the point), and also today's year-to-date
   * position, since later runs have committed since. Statutory withholdings
   * therefore differ from the original stub and are meaningless here; retro
   * quantification differences EARNINGS only, and taxes the resulting amount
   * fresh under the pack's declared retroactive treatment.
   */
  simulate?: boolean;
  /** Caller role scope; null/undefined is unrestricted. */
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}

/**
 * Employee loop, persisted calculation result, and dry-run rollback.
 *
 * Split from the calculation driver so each operation stays within the line bound.
 */
export async function completePayRunCalculation(args: {
  tx: Pick<typeof db, "execute">;
  input: CalculatePayRunInput;
  orgId: string;
  documentId: string;
  actorId: string;
  beforeCalculation: Awaited<ReturnType<typeof capturePayRunCalculationEvidence>> | null;
  calcPack: ReturnType<typeof installablePackOrThrow>;
  canMaintainConfiguration: boolean;
  components: { rows: Record<string, unknown>[] };
  eftFallbackToCheque: boolean;
  employees: Record<string, string | null>[];
  employerCount: number;
  errors: PayRunCalculationError[];
  excluded: Set<string>;
  holidayEligibility: StubComputationInput["holidayEligibility"];
  need: StubComputationInput["need"];
  periodPriorsByEmployee: Map<string, PayPeriodPriors>;
  run: StubComputationInput["run"];
  runContext: StubComputationInput["runContext"];
  runType: string;
  runWageExpenseAccountId: string | null;
  statHolidayPay: boolean;
  statutoryRatesFor: StubComputationInput["statutoryRatesFor"];
  supplementalTaxMethod: StubComputationInput["supplementalTaxMethod"];
}): Promise<PayRunCalculation> {
  const {
    tx,
    input,
    orgId,
    documentId,
    actorId,
    beforeCalculation,
    calcPack,
    canMaintainConfiguration,
    components,
    eftFallbackToCheque,
    employees,
    employerCount,
    errors,
    excluded,
    holidayEligibility,
    need,
    periodPriorsByEmployee,
    run,
    runContext,
    runType,
    runWageExpenseAccountId,
    statHolidayPay,
    statutoryRatesFor,
    supplementalTaxMethod,
  } = args;
  const bonusIncomeReferences: CaBonusIncomeReferenceSource[] = [];
  let grossTotal = "0";
  let netTotal = "0";
  let employerTotal = "0";
  let count = 0;
  const P = Number(run.periods_per_year ?? 0) || undefined;

  if (PERIODIC_RUN_TYPES.has(runType) && !input.simulate) {
    await releaseLeavePayrollInputs(tx, { orgId, runDocumentId: documentId });
    await releaseAllowancePayrollInputs(tx, { orgId, runDocumentId: documentId });
  }

  for (const emp of employees) {
    if (excluded.has(emp.party_id!)) continue;
    const name = emp.display_name ?? emp.party_id!;
    // Second half of the final-pay scope guard. createPayRun writes the
    // exclusions, but the roster can GROW between creation and calculation
    // (a new hire joins the schedule), and an unexcluded stranger on a
    // termination run would be paid a full period and have every bank
    // drained. Employment that has not ended cannot be paid a final cheque:
    // refuse, by name, rather than pay.
    //
    // Out-of-scope, not a refusal: the run was never meant to pay this
    // person, so the commit gate (which binds to `refusal` entries only)
    // must not nag about them, though the exception list still shows them.
    if (runType === "termination" && !emp.terminated_on) {
      errors.push({
        employeePartyId: emp.party_id!,
        employee: name,
        message:
          "a final pay run pays only employees whose employment has ended — " +
          "this employee has no termination date, so they are not in its scope",
        kind: "out-of-scope",
      });
      continue;
    }
    try {
      // The employee half of the chain, asserted against the run's before a
      // single statutory number is computed. A disagreement rides the
      // existing per-employee error channel, so ONE misfiled employee is
      // refused by name and the rest of the run still calculates — which is
      // what makes "correct or refused, never silently wrong" usable rather
      // than an all-or-nothing wall.
      const jurisdiction = resolveEmployeePayrollContext({
        run: runContext,
        employee: {
          partyId: emp.party_id!,
          name,
          country: emp.country!,
          region: emp.province!,
          subsidiaryId: emp.employee_subsidiary_id ?? null,
          subsidiaryCountry: emp.employee_subsidiary_country ?? null,
          filingAccountId: emp.effective_filing_account_id ?? null,
          filingAccountCountry: emp.filing_account_country ?? null,
          filingAccountNumber: emp.filing_account_number ?? null,
        },
      });
      // A named employee refusal must leave no partial stub or allocation.
      // Database failures abort the entire calculation and retain their
      // original cause; they cannot become acknowledgeable exclusions.
      const result = await withTransactionSavepoint(tx, async () => {
        const leavePayrollInputs = PERIODIC_RUN_TYPES.has(runType)
          ? await consumeLeavePayrollInputs(tx, {
              orgId,
              runDocumentId: documentId,
              periodStart: run.period_start!,
              periodEnd: run.period_end!,
              employeePartyIds: [emp.party_id!],
              releaseExisting: false,
              simulate: input.simulate === true,
            })
          : [];
        const allowancePayrollInputs = PERIODIC_RUN_TYPES.has(runType)
          ? await consumeAllowancePayrollInputs(tx, {
              orgId,
              runDocumentId: documentId,
              periodStart: run.period_start!,
              periodEnd: run.period_end!,
              employeePartyId: emp.party_id!,
              payCurrency: runContext.currency,
              simulate: input.simulate === true,
            })
          : [];
        return calculateStub(tx, {
          orgId,
          actorId,
          documentId,
          run,
          emp,
          runContext,
          jurisdiction,
          periodsPerYear: P,
          employerEmployeeCount: employerCount,
          need,
          components: components.rows,
          wageExpenseAccountId: runWageExpenseAccountId,
          statutoryRatesFor,
          eftFallbackToCheque,
          statHolidayPay,
          holidayEligibility,
          simulate: input.simulate === true,
          allowedSubsidiaryIds: input.allowedSubsidiaryIds,
          periodPriors: periodPriorsByEmployee.get(emp.party_id!) ?? EMPTY_PERIOD_PRIORS,
          supplementalTaxMethod,
          leavePayrollInputs,
          allowancePayrollInputs,
          onBonusIncomeReference: (source) => {
            bonusIncomeReferences.push(source);
          },
        });
      });
      grossTotal = add(grossTotal, result.gross);
      netTotal = add(netTotal, result.net);
      employerTotal = add(employerTotal, result.employerCost);
      count += 1;
      // A bank at or over its limit is not a calculation failure — the stub
      // is correct and the operator decides. It rides the same per-employee
      // channel the wizard already renders, marked so the commit gate (which
      // binds to refusals) never blocks a run whose stubs are all correct.
      for (const warning of result.warnings) {
        errors.push({
          employeePartyId: emp.party_id!,
          employee: name,
          message:
            warning.kind === "over_limit"
              ? `${warning.planCode} balance ${warning.balance} exceeds its ${warning.threshold} limit`
              : `${warning.planCode} balance ${warning.balance} has reached its ${warning.threshold} notify threshold`,
          kind: "warning",
        });
      }
      // Named, non-blocking statutory advisories (a reciprocity form to
      // collect): the stub is correct, the operator decides, and the commit
      // gate binds to refusals only — the same channel as the bank-limit
      // warnings above, not a new system.
      for (const advisory of result.advisories) {
        errors.push({
          employeePartyId: emp.party_id!,
          employee: name,
          message: advisory,
          kind: "warning",
        });
      }
    } catch (error) {
      if (error instanceof DrizzleQueryError) throw error;
      errors.push({
        employeePartyId: emp.party_id!,
        employee: name,
        message: error instanceof Error ? error.message : String(error),
        kind: "refusal",
      });
    }
  }

  if (!canMaintainConfiguration) {
    const liabilities = await tx.execute<{
      system_key: string;
      country: string | null;
      liability_account_id: string | null;
    }>(
      sql`
        select distinct c.system_key, c.country, c.liability_account_id
          from pay_stub_lines l
          join pay_stubs s on s.org_id = l.org_id and s.id = l.stub_id
          join pay_components c on c.org_id = l.org_id and c.id = l.component_id
         where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
           and l.kind in ('deduction', 'employer_contribution') and l.amount <> 0
           and c.system_key is not null
      `,
      "objects",
    );
    for (const liability of liabilities) {
      const slot = calcPack.statutorySlots.find((candidate) =>
        candidate.components.some((component) => component.systemKey === liability.system_key),
      );
      if (slot && !liability.liability_account_id) {
        throw new PayrollError(
          `payroll setup incomplete: ${runContext.country} ${slot.key} liability account is not configured — ` +
            "ask an organization payroll administrator to map it in Payroll setup → Accounts & posting",
        );
      }
    }
  }

  const result: PayRunCalculation = {
    employees: count,
    errors,
    gross: grossTotal,
    net: netTotal,
    employerCost: employerTotal,
    refusalAcknowledgement: null,
    refusalsAcknowledged: true,
  };
  // A dry run has done all the real work; throwing here discards the stubs
  // it wrote so the operator's preview costs the run nothing. Preview stubs
  // are read back first so individual pay and deductions can be reviewed —
  // inside this transaction, immediately before it is thrown away. Neither
  // persists anything, so the acknowledgement state they report is the
  // stored one, bound to the stored refusal set.
  if (input.simulate || input.dryRun) {
    result.stubs = await captureCalculatedStubs(tx, orgId, documentId, input.allowedSubsidiaryIds);
  }
  if (input.simulate || input.dryRun) {
    const stored = (
      await tx.execute<{ errors: unknown; acknowledgement: unknown }>(
        sql`
        select calculation_errors as errors, refusal_acknowledgement as acknowledgement
          from pay_runs where org_id = ${orgId} and document_id = ${documentId}
      `,
        "objects",
      )
    )[0];
    const storedRefusals = payRunCalculationRefusals(
      parsePayRunCalculationErrors(stored?.errors) ?? [],
    );
    result.refusalAcknowledgement = parsePayRunRefusalAcknowledgement(stored?.acknowledgement);
    result.refusalsAcknowledged =
      storedRefusals.length === 0 ||
      (result.refusalAcknowledgement != null &&
        result.refusalAcknowledgement.errorsDigest === payRunRefusalDigest(storedRefusals));
    throw new DryRunRollback(result);
  }

  const calculationSource = await payRunCalculationSource(
    orgId,
    documentId,
    tx,
    true,
    input.allowedSubsidiaryIds,
    bonusIncomeReferences,
  );
  if (!calculationSource) throw new PayrollError("pay run not found");
  const calculationSourceDigest = payRunCalculationSourceDigest(calculationSource);
  const benefitSource = await recurringBenefitsRunSource(tx, orgId, documentId);

  // The refusal record is REPLACED wholesale on every calculate — never
  // appended, never merged — so a recalculation that fixes two of three
  // refusals leaves exactly one stored, and a fully successful calculate
  // stores the empty set. Commit and the run page read this same column, so
  // what they see is what this calculate saw: the first calculate's
  // exceptions survive the response that carried them instead of living in
  // the caller's memory alone.
  const storedCalculation = await tx.execute<{ document_id: string }>(
    sql`
      update pay_runs set run_status = 'calculated', calculated_at = now(),
             gross_total = ${grossTotal}, net_total = ${netTotal},
             employer_cost_total = ${employerTotal}, employee_count = ${count},
             calculation_source_snapshot = ${JSON.stringify(calculationSource)}::jsonb,
             calculation_source_digest = ${calculationSourceDigest},
             benefit_source_snapshot = ${JSON.stringify(benefitSource)}::jsonb,
             calculation_errors = ${JSON.stringify(errors)}::jsonb,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and document_id = ${documentId}
       returning document_id
    `,
    "objects",
  );
  if (storedCalculation.length !== 1) {
    throw new PayrollError(
      "the calculated pay run could not be stored — the calculation has been rolled back; retry the calculation",
    );
  }
  // Nothing refused, nothing to acknowledge: a stale acknowledgement from an
  // older refusal set must not linger on a run that is now clean, or the
  // gate would read as a permanent tax on every future commit.
  const refusalsNow = payRunCalculationRefusals(errors);
  if (refusalsNow.length === 0) {
    await tx.execute(sql`
        update pay_runs set refusal_acknowledgement = null,
               updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and document_id = ${documentId}
           and refusal_acknowledgement is not null
      `);
    result.refusalAcknowledgement = null;
    result.refusalsAcknowledged = true;
  } else {
    // Refusals persist, and so does whatever acknowledgement was there: the
    // commit gate re-binds it by digest, and the caller gets the same
    // answer without a second read of its own.
    result.refusalAcknowledgement = parsePayRunRefusalAcknowledgement(
      (
        await tx.execute<{ acknowledgement: unknown }>(
          sql`
          select refusal_acknowledgement as acknowledgement from pay_runs
           where org_id = ${orgId} and document_id = ${documentId}
        `,
          "objects",
        )
      )[0]?.acknowledgement,
    );
    result.refusalsAcknowledged =
      result.refusalAcknowledgement != null &&
      result.refusalAcknowledgement.errorsDigest === payRunRefusalDigest(refusalsNow);
  }
  // Exactly one retained event for this persisted attempt, written after
  // the stored result and its acknowledgement state have been read back
  // and inside the same transaction: a failed write rolls the result
  // back with it, and a rolled-back preview never reaches this point.
  if (!beforeCalculation) throw new PayrollError("pay run not found");
  const afterCalculation = await capturePayRunCalculationEvidence(tx, orgId, documentId);
  if (!afterCalculation) throw new PayrollError("pay run not found");
  await recordPayRunCalculationEvent(tx, {
    orgId,
    documentId,
    actorId,
    before: beforeCalculation,
    after: afterCalculation,
  });
  return result;
}
