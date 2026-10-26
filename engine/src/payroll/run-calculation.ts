import type { CaBonusIncomeReferenceSource } from "./canada/bonus-income-reference.ts";
import {
  payrollEmploymentOverlapsPeriod,
  payrollEpisodeDate,
  lockPayrollEmploymentRoster,
} from "./employment-roster.ts";
import { clearCalculatedHolidayAllocations } from "./holiday-obligation-source.ts";
import {
  requireCompensationPackageConfiguration,
  clearCompensationPackageCalculations,
} from "./compensation-package-payroll.ts";
import {
  applyEmployeeEmployerAssignmentHistory,
  lockEmployerAssignmentProfiles,
} from "./employer-assignment-history.ts";
import { recurringBenefitsRunSource } from "./benefit-plan-inputs.ts";
import { payrollPeriodOpeningPriors } from "./period-opening-source.ts";
import { mergePeriodOpeningPriors } from "./period-opening-contract.ts";
import { EMPTY_PERIOD_PRIORS } from "./period-priors.ts";
import { reresolveRunToSubsidiary } from "./run-lifecycle.ts";
import {
  payrollCalculationPolicyForPayRun,
  payrollConfigurationInScope,
  assertPayRunCalculationComponents,
  ensureStatutoryHolidayComponents,
  ensureComponents,
  statutoryComponents,
  payRunComponentDeclarations,
} from "./run-setup.ts";
/**
 * Pay-run calculation driver: capture, dry-run/simulation, and the calculating transaction.
 *
 * Extracted verbatim from engine/src/payroll/run.ts; bodies preserve exact
 * math, transaction/lock sequencing, and refusal identity.
 */
import {
  lockAndCheckPayrollRunPopulation,
  payrollSubsidiaryInScope,
  type PayrollSubsidiaryScope,
} from "./scope.ts";
import { employeeTaxYearFenceKey, takeEmployeeTaxYearFences } from "./fences.ts";
import { DrizzleQueryError, sql } from "drizzle-orm";
import { db, withTransactionSavepoint } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { add } from "../money/money.ts";
import {
  ensurePackSlotRoleAccounts,
  packRates,
  resolveEmployeePayrollContext,
  resolvePayrollRunContext,
} from "./packs.ts";
import { installablePackOrThrow } from "./run-stub-records.ts";
import { resolveStatutoryRates, type StatutoryRateResolution } from "./statutory-rates.ts";
import {
  loadStoredHolidayFacts,
  holidayEligibilityFromStoredFacts,
} from "./holiday-facts-store.ts";
import { effectiveFilingAccountSql } from "./filing.ts";
import { payrollPaymentMethodSettings } from "./payment-method.ts";
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
import { employerEmployeeCount } from "./run-calculation-support.ts";
import { PERIODIC_RUN_TYPES } from "./run-contracts.ts";
import { consumeLeavePayrollInputs, releaseLeavePayrollInputs } from "./leave-payroll-inputs.ts";
import {
  consumeAllowancePayrollInputs,
  releaseAllowancePayrollInputs,
} from "./allowance-payroll-inputs.ts";
import {
  assertPeriodSequence,
  assertSupplementalSupported,
  listPeriodSiblings,
  loadPeriodPriors,
  periodRunIdentity,
  supplementalTaxMethodForOrg,
  type PayPeriodPriors,
} from "./period-priors.ts";
import { type PayRunCalculation, captureCalculatedStubs } from "./run-captured-stubs.ts";
export { captureCalculatedStubs } from "./run-captured-stubs.ts";
export type { CapturedStubLine, CapturedStub, PayRunCalculation } from "./run-captured-stubs.ts";
/** Rolls the calculation transaction back while carrying its result out. */
class DryRunRollback extends Error {
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

export async function calculatePayRun(input: CalculatePayRunInput): Promise<PayRunCalculation> {
  return await calculateInTransaction(input).catch((error) => {
    if (error instanceof DryRunRollback) return error.result;
    throw error;
  });
}

async function calculateInTransaction(input: CalculatePayRunInput): Promise<PayRunCalculation> {
  const { orgId, documentId, actorId } = input;
  // db.transaction joins an ambient org transaction. Roll back our own writes
  // before calculatePayRun catches the preview signal and returns its result.
  return await db.transaction(
    async (tx) =>
      withTransactionSavepoint(tx, async () => {
        if (!(await lockAndCheckOrgFeature(tx, orgId, "payroll")))
          throw new PayrollError("Payroll feature is disabled");
        const runRows = await tx.execute<Record<string, string>>(
          sql`
      select r.*, d.status as doc_status, d.currency as doc_currency,
             d.subsidiary_id as doc_subsidiary_id, d.document_number,
             sub.name as subsidiary_name, sub.country as subsidiary_country,
             sub.base_currency as subsidiary_currency
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
        left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
       -- Lock the run and its document only. The subsidiary is read-only
       -- jurisdiction context on the nullable side of an outer join, and
       -- Postgres refuses FOR UPDATE there.
       for update of r, d
    `,
          "objects",
        );
        const run = runRows[0];
        if (!run) throw new PayrollError("pay run not found");
        if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, run.doc_subsidiary_id)) {
          throw new PayrollError("pay run not found");
        }
        // A simulation is a rolled-back re-derivation of a run that has already
        // been paid, so these two guards are exactly what it is asking to pass;
        // everything it writes is discarded by the DryRunRollback below.
        if (!input.simulate) {
          if (run.run_status === "committed")
            throw new PayrollError("pay run is already committed");
          if (run.doc_status !== "draft")
            throw new PayrollError("pay run document is not editable");
        } else if (run.run_status !== "committed") {
          throw new PayrollError(
            "only a committed pay run can be simulated — an uncommitted one is recalculated directly",
          );
        }

        await requireCompensationPackageConfiguration(tx, orgId);

        // A subsidiary-scoped schedule pays only that entity's employees; an
        // org-wide schedule keeps everyone (the historical behaviour).
        const scheduleScope = await tx.execute<{ subsidiary_id: string | null }>(
          sql`
      select subsidiary_id from pay_schedules where org_id = ${orgId} and id = ${run.pay_schedule_id} for share
    `,
          "objects",
        );
        const scopedSubsidiaryId = scheduleScope[0]?.subsidiary_id ?? null;
        // The run froze its paying entity at creation; the schedule may have been
        // scoped (or re-scoped) since. An UNCOMMITTED run follows its schedule —
        // entity and currency move together inside the helper, and the stale
        // calculation is dropped so this pass computes against the new entity
        // from scratch. This MUST precede the jurisdiction resolution below, so
        // the run is calculated as what its schedule now says — not as what it
        // froze. Committed runs stay frozen (a posted run must be reproducible)
        // and simulations re-derive a committed run, so both skip this: the
        // guards above already refused a non-draft or committed run unless this
        // is a simulation.
        if (!input.simulate && scopedSubsidiaryId && scopedSubsidiaryId !== run.doc_subsidiary_id) {
          await reresolveRunToSubsidiary(tx, {
            orgId,
            actorId,
            documentId,
            subsidiaryId: scopedSubsidiaryId,
          });
          const refreshed = await tx.execute<Record<string, string>>(
            sql`
        select d.subsidiary_id as doc_subsidiary_id, d.currency as doc_currency,
               sub.name as subsidiary_name, sub.country as subsidiary_country,
               sub.base_currency as subsidiary_currency, r.tax_year::text as tax_year,
               r.run_status
          from pay_runs r
          join documents d on d.id = r.document_id and d.org_id = r.org_id
          left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
         where r.org_id = ${orgId} and r.document_id = ${documentId}
      `,
            "objects",
          );
          Object.assign(run, refreshed[0]);
        }

        // ---- The run's jurisdiction, resolved ONCE -----------------------------
        //
        // Everything downstream — which statutory engine runs, which currency the
        // stub is denominated in, which tax authority the year-end return goes to
        // — is a consequence of WHICH LEGAL ENTITY employs these people. That was
        // never asked: `calculateStub` re-derived a country from `emp.country`
        // with `=== "US" ? "US" : "CA"`, and `subsidiaries.country` (which has
        // existed all along) was read by no payroll module at all. See
        // `resolvePayrollRunContext` in engine/src/payroll/packs.ts for the chain
        // this asserts and why it refuses instead of repairing.
        const runContext = resolvePayrollRunContext({
          payDate: run.pay_date!,
          subsidiary: {
            id: run.doc_subsidiary_id ?? "",
            name: run.subsidiary_name ?? "",
            country: run.subsidiary_country ?? null,
            baseCurrency: run.subsidiary_currency ?? null,
          },
          runCurrency: run.doc_currency ?? null,
        });
        // The run was stamped with its tax year at creation; if the pack's year
        // definition has since changed under it, every YTD accumulator on this run
        // reads a different year from the one the stubs are filed in. A run the
        // re-scope above just re-stamped carries the new entity's year by
        // construction, so this check only fires on genuine pack drift.
        if (Number(run.tax_year) !== runContext.taxYear) {
          throw new PayrollError(
            `this pay run is stamped tax year ${run.tax_year} but a ${runContext.country} pay date of ` +
              `${runContext.payDate} falls in ${runContext.taxYear}`,
          );
        }
        const runType = (run.run_type as string) ?? "regular";
        // ---- Supplemental-period sequencing and priors -----------------------
        // A period builds in pay-date order: earlier runs of the period must
        // already be committed (their withheld shares are this run's priors),
        // and no later run may be (it was computed without this run's share).
        // Bonus, termination, and retro runs are taxed with the non-periodic
        // method and never share the period basis, so they sequence alone.
        const periodIdentity = periodRunIdentity(run, {
          documentId,
          documentNumber: run.document_number,
          runType,
        });
        // Final pay shares the period with the regular and supplemental cheques
        // already committed for it: CPP and EI apply one period exemption and
        // room across them, so those runs are its priors without sequencing it.
        const periodSiblings = PERIODIC_RUN_TYPES.has(runType)
          ? await assertPeriodSequence(tx, orgId, periodIdentity, "calculate")
          : runType === "termination"
            ? [
                ...(await listPeriodSiblings(tx, orgId, periodIdentity)).filter(
                  (sibling) =>
                    sibling.run_status === "committed" &&
                    sibling.pay_date <= periodIdentity.payDate,
                ),
                { document_id: documentId } as Awaited<
                  ReturnType<typeof listPeriodSiblings>
                >[number],
              ]
            : [];
        const periodPriorsByEmployee =
          periodSiblings.length > 0
            ? await loadPeriodPriors(tx, orgId, periodSiblings, documentId)
            : new Map<string, PayPeriodPriors>();
        const calcPack = installablePackOrThrow(runContext.country);
        assertSupplementalSupported(
          calcPack,
          runContext.country,
          runType,
          periodPriorsByEmployee.size > 0,
        );
        const supplementalTaxMethod = calcPack.supplementalPayTreatment
          ? await supplementalTaxMethodForOrg(tx, orgId, calcPack)
          : ("period_cumulative" as const);
        // `distinct on (p.id)` is load-bearing, not tidiness: employee_roles is
        // joined per party and a second role row would run calculateStub twice for
        // one person — a duplicate stub, doubled pay, and (because the EHT and WCB
        // accumulators below read this run's own stubs) a doubly-consumed
        // exemption. One employee, one pass, stated in the query.
        await lockPayrollEmploymentRoster(tx, orgId, documentId);
        const rosterColumns = {
          org: sql`prof.org_id`,
          employee: sql`p.id`,
          employment: sql`prof.employment_id`,
          employer: sql`p.subsidiary_id`,
          hiredOn: sql`er.hired_on`,
          terminatedOn: sql`er.terminated_on`,
          periodStart: sql`${run.period_start}`,
          periodEnd: sql`${run.period_end}`,
          runType: sql`${run.run_type}`,
          document: sql`${documentId}`,
        };
        const employees = await tx.execute<Record<string, string | null>>(
          sql`
      select * from (
        select distinct on (p.id)
               p.id as party_id, p.display_name,
               ${payrollEpisodeDate(rosterColumns, sql`er.terminated_on`)} as terminated_on,
               -- Employment start, for packs whose ceilings or year-to-date
               -- position run from the hire date rather than the year start.
               ${payrollEpisodeDate(rosterColumns, sql`er.hired_on`)} as hired_on,
               -- Payment rail inputs. prof.* already carries the payroll
               -- override; these are the party preference and the bank-details
               -- fact the resolver needs (engine/src/payroll/payment-method.ts).
               p.payment_method as party_payment_method,
               exists (
                 select 1 from party_bank_accounts b
                  where b.org_id = prof.org_id and b.party_id = p.id
                    and b.is_active and b.approval_status = 'approved') as has_approved_bank,
               -- The employee's OWN legal entity and the tax authority their
               -- slips file to: the other two links of the jurisdiction chain.
               -- Aliased, because prof.* below already carries a "country".
               p.subsidiary_id as employee_subsidiary_id,
               emp_sub.country as employee_subsidiary_country,
               public.payroll_worker_comp_group_at(p.org_id, p.id, ${run.pay_date}::date)::text as resolved_worker_comp_group_id,
               ${effectiveFilingAccountSql("prof")} as effective_filing_account_id,
               filing_acct.country as filing_account_country,
               filing_acct.account_number as filing_account_number,
               prof.*
          from employee_payroll_profiles prof
          join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
          left join subsidiaries emp_sub
            on emp_sub.id = p.subsidiary_id and emp_sub.org_id = p.org_id
          -- Aliased filing_acct, not fa: effectiveFilingAccountSql's own
          -- correlated subquery uses "fa" internally, and shadowing it here
          -- would be legal SQL that reads like a bug.
          left join payroll_filing_accounts filing_acct
            on filing_acct.id = ${effectiveFilingAccountSql("prof")}
           and filing_acct.org_id = prof.org_id
          left join employee_roles er on er.party_id = p.id and er.org_id = p.org_id
         where prof.org_id = ${orgId} and prof.pay_schedule_id = ${run.pay_schedule_id}
           and prof.is_active
           and ${payrollEmploymentOverlapsPeriod(rosterColumns)}
           and (${scopedSubsidiaryId}::uuid is null or p.subsidiary_id = ${scopedSubsidiaryId}::uuid)
         order by p.id, er.terminated_on nulls last
      ) roster
      -- display_name then party_id: the EHT own-document arm sequences the
      -- exemption across this run's employees in calculation order, so the
      -- order is deterministic down to the uuid — two employees sharing a
      -- display name must still consume room in a stable order.
      order by roster.display_name, roster.party_id
    `,
          "objects",
        );

        // Authorize the complete selected roster and the snapshot we replace.
        // A scoped filter here would silently drop employees and rewrite totals.
        await lockAndCheckPayrollRunPopulation(
          tx,
          orgId,
          documentId,
          input.allowedSubsidiaryIds,
          employees.map((employee) => ({
            id: employee.party_id!,
            subsidiaryId: employee.employee_subsidiary_id ?? null,
          })),
        );

        // Run ownership authorizes consumption of the applicable policy. Shared
        // configuration maintenance additionally requires the organization root.
        const calculationPolicy = await payrollCalculationPolicyForPayRun(
          orgId,
          documentId,
          input.allowedSubsidiaryIds,
          tx,
        );
        const statHolidayPay = calculationPolicy.statutoryHolidayPay;
        const canMaintainConfiguration = await payrollConfigurationInScope(
          tx,
          orgId,
          input.allowedSubsidiaryIds,
        );
        if (canMaintainConfiguration && statHolidayPay) {
          await ensureStatutoryHolidayComponents(tx, orgId, actorId, input.allowedSubsidiaryIds);
        }

        // The pack's statutory components, ensured for a tenant provisioned before
        // the pack declared them — the same reason and the same idempotent path as
        // the holiday pair above. `ctx.need` is an ASSERTION, never a discovery
        // mechanism, and a levy a pack has just started emitting (state income tax)
        // must not fail every existing tenant's next payroll with "seed payroll
        // components first". Generic: it provisions whatever the run's own pack
        // declares and branches on nothing.
        if (canMaintainConfiguration) {
          await ensureComponents(tx, orgId, actorId, statutoryComponents(runContext.country));
          // Same role wiring as install: explicit account mappings retain priority.
          await ensurePackSlotRoleAccounts(tx, orgId, actorId, runContext.country);
        }

        const componentRows = await tx.execute<Record<string, unknown>>(
          sql`
      select * from pay_components where org_id = ${orgId} and is_active order by sequence
    `,
          "objects",
        );
        if (!canMaintainConfiguration) {
          assertPayRunCalculationComponents(runContext.country, statHolidayPay, componentRows);
        }
        const components = { rows: componentRows };
        // Every system key resolves against its own declaration. A country-less
        // statutory row cannot substitute for the paying country's component.
        const byKey = new Map<string, Record<string, unknown>>();
        for (const declaration of payRunComponentDeclarations(runContext.country)) {
          const component = components.rows.find(
            (row) =>
              row.country === (declaration.country ?? null) &&
              row.system_key === declaration.systemKey &&
              row.kind === declaration.kind,
          );
          if (component) byKey.set(`${declaration.systemKey}:${declaration.kind}`, component);
        }
        const need = (systemKey: string, kind: string) => {
          const c = byKey.get(`${systemKey}:${kind}`);
          if (!c)
            throw new PayrollError(
              `missing system pay component ${systemKey}/${kind} — ask an organization payroll administrator to complete Payroll setup → Accounts & posting`,
            );
          return c;
        };

        // Resolve the statutory employer headcount once for the run. It is
        // deliberately independent of this run's roster: Nebraska's special
        // procedure follows the legal employer's full population, not merely the
        // employees paid on one schedule today.
        const employerCount = await employerEmployeeCount(tx, orgId, runContext.subsidiaryId);

        // Fence the calculation on the EMPLOYEE-AND-TAX-YEAR identity (see
        // `employeeTaxYearFenceKey`) BEFORE any year-to-date is read and before a
        // single stub row is written. Two runs sharing an employee and year used
        // to compute their statutory amounts against the same unconsumed ceilings
        // whenever their calculations overlapped; the fence orders them, so the
        // second calculation reads a year-to-date that already includes the first
        // run's stubs. Taken AFTER this run's own row lock above, in sorted key
        // order — the same total order `commitPayRun` uses — so overlapping
        // rosters queue instead of deadlocking. The roster is fenced whole (not
        // merely whoever ends up with a stub): who gets a stub is decided below,
        // and every one of these employees' YTD inputs are read on this pass.
        await takeEmployeeTaxYearFences(
          tx,
          employees.map((e) => employeeTaxYearFenceKey(orgId, e.party_id, runContext.taxYear)),
        );
        await lockEmployerAssignmentProfiles(
          tx,
          orgId,
          employees.map((e) => e.party_id!),
        );

        // Preserve the result this calculation is about to replace, after the
        // run, roster, population and employee-year fences above have settled
        // the live scope and before the first destructive write below deletes
        // any part of it. Dry runs and simulations roll their work back, so
        // they capture nothing to retain.
        const beforeCalculation =
          input.simulate || input.dryRun
            ? null
            : await capturePayRunCalculationEvidence(tx, orgId, documentId);
        if (!input.simulate && !input.dryRun && !beforeCalculation) {
          throw new PayrollError("pay run not found");
        }

        if (input.simulate)
          await tx.execute(
            sql`set constraints pay_run_benefit_allocations_line_tenant_fkey deferred`,
          );
        if (!input.simulate)
          await tx.execute(
            sql`delete from pay_run_benefit_allocations where org_id = ${orgId} and pay_run_document_id = ${documentId}`,
          );
        if (!input.simulate) await clearCalculatedHolidayAllocations(tx, orgId, documentId);
        // Movements are deleted with the stubs that produced them, on the same
        // key, so an employee who has dropped OFF the run (excluded, terminated,
        // moved schedule) leaves no orphaned bank movement behind. Per-employee
        // replacement inside calculateStub cannot see someone who is no longer
        // being calculated. The ledger goes BEFORE the stubs: ledger rows carry
        // the stub line that evidenced them, and deleting the stub first would
        // null that link out — an UPDATE the append-only guard refuses.
        //
        // A SIMULATION writes no entitlement movements at all, and therefore
        // deletes none. Not an optimization: `entitlement_ledger` is append-only
        // once its pay run is committed (the entitlement_ledger_append_only
        // trigger), and that control is right — a bank movement backing a payroll
        // that has gone out is not editable, even inside a transaction that will
        // be rolled back. Retro quantification differences EARNINGS, and accruals
        // are `accrualOnly` employer lines that never enter that difference, so
        // suppressing the ledger writes costs the simulation nothing it uses.
        if (!input.simulate) {
          await tx.execute(sql`
        delete from entitlement_ledger
         where org_id = ${orgId} and pay_run_document_id = ${documentId}`);
        }
        await clearCompensationPackageCalculations(tx, {
          orgId,
          documentId,
          simulate: !!input.simulate,
        });
        await tx.execute(
          sql`delete from pay_stubs where org_id = ${orgId} and pay_run_document_id = ${documentId}`,
        );

        // Run-level input adjustments: exclusions drop the employee entirely;
        // 'line' rows are merged into the stub's inputs inside calculateStub.
        const excludedRows = await tx.execute<{ employee_party_id: string }>(
          sql`
      select employee_party_id from pay_run_adjustments
       where org_id = ${orgId} and pay_run_document_id = ${documentId}
         and adjustment_type = 'exclude'
    `,
          "objects",
        );
        const excluded = new Set(excludedRows.map((r) => r.employee_party_id));
        await applyEmployeeEmployerAssignmentHistory(
          tx,
          orgId,
          run.pay_date!,
          employees.filter((e) => !excluded.has(e.party_id!)),
        );
        const holidayEligibility = statHolidayPay
          ? holidayEligibilityFromStoredFacts(
              await loadStoredHolidayFacts(tx, {
                orgId,
                documentId,
                employeePartyIds: employees
                  .filter((employee) => !excluded.has(employee.party_id!))
                  .map((employee) => employee.party_id!),
              }),
            )
          : {};

        const openingPriors = await payrollPeriodOpeningPriors(tx, {
          orgId,
          pack: calcPack,
          employeePartyIds: employees
            .filter((employee) => !excluded.has(employee.party_id!))
            .map((employee) => employee.party_id!),
          periodic: PERIODIC_RUN_TYPES.has(runType),
          run: {
            payScheduleId: periodIdentity.payScheduleId,
            periodStart: periodIdentity.periodStart,
            periodEnd: periodIdentity.periodEnd,
            payDate: runContext.payDate,
            taxYear: runContext.taxYear,
            country: runContext.country,
            currency: runContext.currency,
            subsidiaryId: runContext.subsidiaryId,
            label: periodIdentity.documentNumber,
          },
        });
        for (const [employeeId, opening] of openingPriors) {
          periodPriorsByEmployee.set(
            employeeId,
            mergePeriodOpeningPriors(
              periodPriorsByEmployee.get(employeeId) ?? EMPTY_PERIOD_PRIORS,
              opening,
            ),
          );
        }
        assertSupplementalSupported(
          calcPack,
          runContext.country,
          runType,
          periodPriorsByEmployee.size > 0,
        );

        const { eftFallbackToCheque } = await payrollPaymentMethodSettings(orgId);
        // The org wage expense default, read ONCE for the run in this
        // transaction: it is the last rung of time-driven earning line expense
        // resolution, and reading it per stub would let a concurrent settings
        // edit cost two employees on the same run to different defaults.
        const runWageExpenseAccountId = calculationPolicy.settings.wageExpenseAccountId;
        const errors: PayRunCalculationError[] = [];
        // One statutory-rate resolution per (country, year) for the whole run,
        // passed down — never a query per employee. Only called for packs that
        // declare a `refuse` slot (the per-stub gate below checks first), so the
        // packRates lookup inside cannot throw here.
        const rateResolutions = new Map<string, Promise<StatutoryRateResolution>>();
        const statutoryRatesFor = (
          country: string,
          taxYear: number,
        ): Promise<StatutoryRateResolution> => {
          // As-of the run's pay date: a rate re-saved after this period paid must
          // not rewrite what the period answered. The pay date is constant for
          // the run, so one resolution per (country, year) still holds.
          const key = `${country}:${taxYear}:${runContext.payDate}`;
          const cached = rateResolutions.get(key);
          if (cached) return cached;
          const pending = resolveStatutoryRates(
            orgId,
            packRates(country),
            taxYear,
            runContext.payDate,
          );
          rateResolutions.set(key, pending);
          return pending;
        };
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
              candidate.components.some(
                (component) => component.systemKey === liability.system_key,
              ),
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
          result.stubs = await captureCalculatedStubs(
            tx,
            orgId,
            documentId,
            input.allowedSubsidiaryIds,
          );
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
          result.refusalAcknowledgement = parsePayRunRefusalAcknowledgement(
            stored?.acknowledgement,
          );
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
      }),
    { isolationLevel: "repeatable read" },
  );
}

/**
 * One line of a stub under construction — earnings, deductions, and employer
 * contributions alike, in the order phases append them. Hoisted to module
 * level so the jurisdiction and persistence helpers below can name it; it
 * carries no behavior, only shape.
 */
/** Which rung of the expense-account resolution answered for a stub line. */
