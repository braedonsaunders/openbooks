import { reresolveRunToSubsidiary } from "./run-lifecycle.ts";
import { statutoryHolidayPayEnabled, ensureStatutoryHolidayComponents, ensureComponents, statutoryComponents } from "./run-setup.ts";
/**
 * Pay-run calculation driver: capture, dry-run/simulation, and the calculating transaction.
 *
 * Extracted verbatim from engine/src/payroll/run.ts; bodies preserve exact
 * math, transaction/lock sequencing, and refusal identity.
 */
import { lockAndCheckPayrollRunPopulation, payrollSubsidiaryInScope, payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import { employeeTaxYearFenceKey, takeEmployeeTaxYearFences } from "./fences.ts";
import { sql } from "drizzle-orm";
import { db, withTransactionSavepoint } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { add } from "../money/money.ts";
import { ensurePackSlotRoleAccounts, packRates, resolveEmployeePayrollContext, resolvePayrollRunContext } from "./packs.ts";
import { resolveStatutoryRates, type StatutoryRateResolution } from "./statutory-rates.ts";
import { type StatutoryHolidayEligibilityFacts } from "./holidays.ts";
import { effectiveFilingAccountSql } from "./filing.ts";
import { payrollPaymentMethodSettings } from "./payment-method.ts";
import { payRunCalculationSourceDigest, payRunCalculationSource, type PayRunCalculationError, type PayRunRefusalAcknowledgement, payRunCalculationRefusals, payRunRefusalDigest, parsePayRunCalculationErrors, parsePayRunRefusalAcknowledgement } from "./run-calculation-evidence.ts";
import { calculateStub } from "./run-stub-compute.ts";
import { employerEmployeeCount } from "./run-calculation-support.ts";
/** One line of a stub, as `captureCalculatedStubs` hands it back. */
export interface CapturedStubLine {
  componentId: string | null;
  systemKey: string | null;
  kind: "earning" | "deduction" | "employer_contribution" | "credit";
  description: string;
  hours: string | null;
  rate: string | null;
  amount: string;
  projectId: string | null;
  departmentId: string | null;
  timeTypeId: string | null;
  itemId: string | null;
  /** Expense stamp resolved at calculate (migration 0180); nulls when the
   * line carries no stamp and posts through the component-then-default
   * fallback. This is what the operator saw on screen at calculate. */
  expenseAccountId: string | null;
  expenseAccountSource: string;
  expenseAccountEvidence: { reason: string; reference: string } | null;
  sequence: number;
}

/** One employee's whole calculated result, read back inside the transaction. */
export interface CapturedStub {
  employeePartyId: string;
  province: string;
  gross: string;
  netPay: string;
  employerCost: string;
  lines: CapturedStubLine[];
}

export interface PayRunCalculation {
  employees: number;
  errors: PayRunCalculationError[];
  gross: string;
  net: string;
  employerCost: string;
  /**
   * The stubs the calculation produced, present ONLY for a `simulate` run.
   * Read back inside the transaction that is about to be rolled back, which is
   * the whole point: the caller gets the calculation's real output without any
   * of it surviving.
   */
  stubs?: CapturedStub[];
  /**
   * The run's acknowledgement AFTER this calculate, read in the same
   * transaction: a successful calculate clears any stale acknowledgement
   * (nothing refused, nothing to acknowledge), otherwise the stored record
   * survives untouched. Valid exactly when `refusalsAcknowledged`, so the
   * caller never has to re-derive the gate client-side.
   */
  refusalAcknowledgement: PayRunRefusalAcknowledgement | null;
  refusalsAcknowledged: boolean;
}

/**
 * Read a run's just-calculated stubs back, inside the calculating transaction.
 *
 * Exported because retro pay's quantification needs the LINES, not the totals:
 * "what would this period pay today" only answers the retro question when it
 * can be differenced component by component and job by job against what the
 * period actually paid (engine/src/payroll/retro.ts).
 */
export async function captureCalculatedStubs(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<CapturedStub[]> {
  const rows = (await tx.execute<Record<string, string | number | null>>(sql`
    select s.employee_party_id, s.province, s.gross, s.net_pay, s.employer_cost,
           l.component_id, c.system_key, l.kind, l.description, l.hours, l.rate, l.amount,
           l.project_id, l.department_id, l.time_type_id, l.item_id,
           l.expense_account_id, l.expense_account_source, l.expense_account_evidence, l.sequence
      from pay_stubs s
      left join pay_stub_lines l on l.stub_id = s.id and l.org_id = s.org_id
      left join pay_components c on c.id = l.component_id and c.org_id = s.org_id
      left join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
     where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
       ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
     order by s.employee_party_id, l.sequence, l.description
  `));
  const byEmployee = new Map<string, CapturedStub>();
  for (const row of rows.rows) {
    const employeePartyId = String(row.employee_party_id);
    let stub = byEmployee.get(employeePartyId);
    if (!stub) {
      stub = {
        employeePartyId,
        province: String(row.province ?? ""),
        gross: String(row.gross ?? "0"),
        netPay: String(row.net_pay ?? "0"),
        employerCost: String(row.employer_cost ?? "0"),
        lines: [],
      };
      byEmployee.set(employeePartyId, stub);
    }
    // A stub with no lines at all still exists as a stub; the outer join keeps
    // it, and an absent line must not be invented as a zero one.
    if (row.kind == null) continue;
    stub.lines.push({
      componentId: row.component_id == null ? null : String(row.component_id),
      systemKey: row.system_key == null ? null : String(row.system_key),
      kind: String(row.kind) as CapturedStubLine["kind"],
      description: String(row.description ?? ""),
      hours: row.hours == null ? null : String(row.hours),
      rate: row.rate == null ? null : String(row.rate),
      amount: String(row.amount ?? "0"),
      projectId: row.project_id == null ? null : String(row.project_id),
      departmentId: row.department_id == null ? null : String(row.department_id),
      timeTypeId: row.time_type_id == null ? null : String(row.time_type_id),
      itemId: row.item_id == null ? null : String(row.item_id),
      expenseAccountId: row.expense_account_id == null ? null : String(row.expense_account_id),
      expenseAccountSource: String(row.expense_account_source ?? "unknown"),
      expenseAccountEvidence: (row.expense_account_evidence == null ? null : row.expense_account_evidence as unknown as
        { reason: string; reference: string }),
      sequence: Number(row.sequence ?? 0),
    });
  }
  return [...byEmployee.values()];
}

/** Rolls the calculation transaction back while carrying its result out. */
class DryRunRollback extends Error {
  constructor(readonly result: PayRunCalculation) {
    super("dry run");
  }
}

export interface CalculatePayRunInput {
  orgId: string; documentId: string; actorId: string;
  /**
   * Authoritative employee facts used by statutory holiday rules. A missing
   * fact fails closed when the employee's jurisdiction reads it; callers must
   * not let the resolver infer commission status or consent from payroll
   * amounts/timesheet gaps.
   */
  holidayEligibility?: Readonly<Record<string, StatutoryHolidayEligibilityFacts>>;
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
  return await db.transaction(async (tx) => withTransactionSavepoint(tx, async () => {
    if (!(await lockAndCheckOrgFeature(tx, orgId, "payroll"))) throw new PayrollError("Payroll feature is disabled");
    const runRows = (await tx.execute<Record<string, string>>(sql`
      select r.*, d.status as doc_status, d.currency as doc_currency,
             d.subsidiary_id as doc_subsidiary_id,
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
    `));
    const run = runRows.rows[0];
    if (!run) throw new PayrollError("pay run not found");
    if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, run.doc_subsidiary_id)) {
      throw new PayrollError("pay run not found");
    }
    // A simulation is a rolled-back re-derivation of a run that has already
    // been paid, so these two guards are exactly what it is asking to pass;
    // everything it writes is discarded by the DryRunRollback below.
    if (!input.simulate) {
      if (run.run_status === "committed") throw new PayrollError("pay run is already committed");
      if (run.doc_status !== "draft") throw new PayrollError("pay run document is not editable");
    } else if (run.run_status !== "committed") {
      throw new PayrollError(
        "only a committed pay run can be simulated — an uncommitted one is recalculated directly",
      );
    }

    // A subsidiary-scoped schedule pays only that entity's employees; an
    // org-wide schedule keeps everyone (the historical behaviour).
    const scheduleScope = (await tx.execute<{ subsidiary_id: string | null }>(sql`
      select subsidiary_id from pay_schedules where org_id = ${orgId} and id = ${run.pay_schedule_id} for share
    `));
    const scopedSubsidiaryId = scheduleScope.rows[0]?.subsidiary_id ?? null;
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
        orgId, actorId, documentId, subsidiaryId: scopedSubsidiaryId,
      });
      const refreshed = (await tx.execute<Record<string, string>>(sql`
        select d.subsidiary_id as doc_subsidiary_id, d.currency as doc_currency,
               sub.name as subsidiary_name, sub.country as subsidiary_country,
               sub.base_currency as subsidiary_currency, r.tax_year::text as tax_year,
               r.run_status
          from pay_runs r
          join documents d on d.id = r.document_id and d.org_id = r.org_id
          left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
         where r.org_id = ${orgId} and r.document_id = ${documentId}
      `));
      Object.assign(run, refreshed.rows[0]);
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
        `this pay run is stamped tax year ${run.tax_year} but a ${runContext.country} pay date of `
        + `${runContext.payDate} falls in ${runContext.taxYear}`,
      );
    }
    const runType = (run.run_type as string) ?? "regular";
    // `distinct on (p.id)` is load-bearing, not tidiness: employee_roles is
    // joined per party and a second role row would run calculateStub twice for
    // one person — a duplicate stub, doubled pay, and (because the EHT and WCB
    // accumulators below read this run's own stubs) a doubly-consumed
    // exemption. One employee, one pass, stated in the query.
    const employees = (await tx.execute<Record<string, string | null>>(sql`
      select * from (
        select distinct on (p.id)
               p.id as party_id, p.display_name, er.terminated_on,
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
           and (er.terminated_on is null or er.terminated_on >= ${run.period_start})
           and (${scopedSubsidiaryId}::uuid is null or p.subsidiary_id = ${scopedSubsidiaryId}::uuid)
         order by p.id, er.terminated_on nulls last
      ) roster
      -- display_name then party_id: the EHT own-document arm sequences the
      -- exemption across this run's employees in calculation order, so the
      -- order is deterministic down to the uuid — two employees sharing a
      -- display name must still consume room in a stable order.
      order by roster.display_name, roster.party_id
    `));

    // Authorize the complete selected roster and the snapshot we replace.
    // A scoped filter here would silently drop employees and rewrite totals.
    await lockAndCheckPayrollRunPopulation(tx, orgId, documentId, input.allowedSubsidiaryIds,
      employees.rows.map((employee) => ({ id: employee.party_id!, subsidiaryId: employee.employee_subsidiary_id ?? null })));

    // Statutory holiday pay: read the gate once for the run, and provision the
    // STAT/STATPREM pair for orgs that predate them BEFORE the component map
    // is loaded — ctx.need is an assertion, never a discovery mechanism.
    const statHolidayPay = await statutoryHolidayPayEnabled(
      orgId, tx, input.allowedSubsidiaryIds,
    );
    if (statHolidayPay) {
      await ensureStatutoryHolidayComponents(
        tx, orgId, actorId, input.allowedSubsidiaryIds,
      );
    }

    // The pack's statutory components, ensured for a tenant provisioned before
    // the pack declared them — the same reason and the same idempotent path as
    // the holiday pair above. `ctx.need` is an ASSERTION, never a discovery
    // mechanism, and a levy a pack has just started emitting (state income tax)
    // must not fail every existing tenant's next payroll with "seed payroll
    // components first". Generic: it provisions whatever the run's own pack
    // declares and branches on nothing.
    await ensureComponents(tx, orgId, actorId, statutoryComponents(runContext.country));
    // Same role wiring as install: a pack adopted before its slots declared
    // roles (or a role mapped after install) still lands on the chart account
    // wherever the operator has not mapped the slot yet.
    await ensurePackSlotRoleAccounts(tx, orgId, actorId, runContext.country);

    const components = (await tx.execute<Record<string, unknown>>(sql`
      select * from pay_components where org_id = ${orgId} and is_active order by sequence
    `));
    // Country-scoped resolution (0189): two packs may each own one
    // `system_key` (CA and JP both declare income_tax), so the run resolves
    // only its own pack's rows plus the shared NULL-country baseline. Without
    // this the map below is last-wins across packs and a run can price
    // against another country's component. A key this run's pack does not
    // declare fails closed in `need` ("seed payroll components first").
    const byKey = new Map<string, Record<string, unknown>>();
    for (const c of components.rows) {
      if (c.country != null && c.country !== runContext.country) continue;
      if (c.system_key) byKey.set(`${c.system_key}:${c.kind}`, c);
    }
    const need = (systemKey: string, kind: string) => {
      const c = byKey.get(`${systemKey}:${kind}`);
      if (!c) throw new PayrollError(`missing system pay component ${systemKey}/${kind} — seed payroll components first`);
      return c;
    };

    // Resolve the statutory employer headcount once for the run. It is
    // deliberately independent of this run's roster: Nebraska's special
    // procedure follows the legal employer's full population, not merely the
    // employees paid on one schedule today.
    const employerCount = await employerEmployeeCount(
      tx, orgId, runContext.subsidiaryId,
    );

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
      employees.rows.map((e) => employeeTaxYearFenceKey(orgId, e.party_id, runContext.taxYear)),
    );

    await tx.execute(sql`delete from pay_stubs where org_id = ${orgId} and pay_run_document_id = ${documentId}`);
    // Movements are deleted with the stubs that produced them, on the same
    // key, so an employee who has dropped OFF the run (excluded, terminated,
    // moved schedule) leaves no orphaned bank movement behind. Per-employee
    // replacement inside calculateStub cannot see someone who is no longer
    // being calculated.
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

    // Run-level input adjustments: exclusions drop the employee entirely;
    // 'line' rows are merged into the stub's inputs inside calculateStub.
    const excludedRows = (await tx.execute<{ employee_party_id: string }>(sql`
      select employee_party_id from pay_run_adjustments
       where org_id = ${orgId} and pay_run_document_id = ${documentId}
         and adjustment_type = 'exclude'
    `));
    const excluded = new Set(excludedRows.rows.map((r) => r.employee_party_id));

    const { eftFallbackToCheque } = await payrollPaymentMethodSettings(orgId);
    // The org wage expense default, read ONCE for the run in this
    // transaction: it is the last rung of time-driven earning line expense
    // resolution, and reading it per stub would let a concurrent settings
    // edit cost two employees on the same run to different defaults.
    const runWageExpenseAccountId = ((await tx.execute<{ v: string | null }>(sql`
      select settings->'payroll'->>'wageExpenseAccountId' as v from orgs where id = ${orgId}
    `)).rows[0]?.v ?? null);
    const errors: PayRunCalculationError[] = [];
    // One statutory-rate resolution per (country, year) for the whole run,
    // passed down — never a query per employee. Only called for packs that
    // declare a `refuse` slot (the per-stub gate below checks first), so the
    // packRates lookup inside cannot throw here.
    const rateResolutions = new Map<string, Promise<StatutoryRateResolution>>();
    const statutoryRatesFor = (country: string, taxYear: number): Promise<StatutoryRateResolution> => {
      // As-of the run's pay date: a rate re-saved after this period paid must
      // not rewrite what the period answered. The pay date is constant for
      // the run, so one resolution per (country, year) still holds.
      const key = `${country}:${taxYear}:${runContext.payDate}`;
      const cached = rateResolutions.get(key);
      if (cached) return cached;
      const pending = resolveStatutoryRates(orgId, packRates(country), taxYear, runContext.payDate);
      rateResolutions.set(key, pending);
      return pending;
    };
    let grossTotal = "0"; let netTotal = "0"; let employerTotal = "0"; let count = 0;
    const P = Number(run.periods_per_year ?? 0) || undefined;

    for (const emp of employees.rows) {
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
          message: "a final pay run pays only employees whose employment has ended — "
            + "this employee has no termination date, so they are not in its scope",
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
        const result = await calculateStub(tx, {
          orgId, actorId, documentId, run, emp, runContext, jurisdiction,
          periodsPerYear: P, employerEmployeeCount: employerCount, need, components: components.rows,
          wageExpenseAccountId: runWageExpenseAccountId,
          statutoryRatesFor,
          eftFallbackToCheque,
          statHolidayPay,
          holidayEligibility: input.holidayEligibility,
          simulate: input.simulate === true,
          allowedSubsidiaryIds: input.allowedSubsidiaryIds,
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
            message: warning.kind === "over_limit"
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
        errors.push({
          employeePartyId: emp.party_id!,
          employee: name,
          message: error instanceof Error ? error.message : String(error),
          kind: "refusal",
        });
      }
    }

    const result: PayRunCalculation = {
      employees: count, errors,
      gross: grossTotal, net: netTotal, employerCost: employerTotal,
      refusalAcknowledgement: null, refusalsAcknowledged: true,
    };
    // A dry run has done all the real work; throwing here discards the stubs
    // it wrote so the operator's preview costs the run nothing. A simulation is
    // a dry run whose OUTPUT is the point, so the stubs are read back first —
    // inside this transaction, immediately before it is thrown away. Neither
    // persists anything, so the acknowledgement state they report is the
    // stored one, bound to the stored refusal set.
    if (input.simulate) {
      result.stubs = await captureCalculatedStubs(
        tx,
        orgId,
        documentId,
        input.allowedSubsidiaryIds,
      );
    }
    if (input.simulate || input.dryRun) {
      const stored = (await tx.execute<{ errors: unknown; acknowledgement: unknown }>(sql`
        select calculation_errors as errors, refusal_acknowledgement as acknowledgement
          from pay_runs where org_id = ${orgId} and document_id = ${documentId}
      `)).rows[0];
      const storedRefusals = payRunCalculationRefusals(
        parsePayRunCalculationErrors(stored?.errors) ?? [],
      );
      result.refusalAcknowledgement = parsePayRunRefusalAcknowledgement(stored?.acknowledgement);
      result.refusalsAcknowledged = storedRefusals.length === 0
        || (result.refusalAcknowledgement != null
          && result.refusalAcknowledgement.errorsDigest === payRunRefusalDigest(storedRefusals));
      throw new DryRunRollback(result);
    }

    const calculationSource = await payRunCalculationSource(
      orgId,
      documentId,
      tx,
      true,
      input.allowedSubsidiaryIds,
    );
    if (!calculationSource) throw new PayrollError("pay run not found");
    const calculationSourceDigest = payRunCalculationSourceDigest(calculationSource);

    // The refusal record is REPLACED wholesale on every calculate — never
    // appended, never merged — so a recalculation that fixes two of three
    // refusals leaves exactly one stored, and a fully successful calculate
    // stores the empty set. Commit and the run page read this same column, so
    // what they see is what this calculate saw: the first calculate's
    // exceptions survive the response that carried them instead of living in
    // the caller's memory alone.
    await tx.execute(sql`
      update pay_runs set run_status = 'calculated', calculated_at = now(),
             gross_total = ${grossTotal}, net_total = ${netTotal},
             employer_cost_total = ${employerTotal}, employee_count = ${count},
             calculation_source_snapshot = ${JSON.stringify(calculationSource)}::jsonb,
             calculation_source_digest = ${calculationSourceDigest},
             calculation_errors = ${JSON.stringify(errors)}::jsonb,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and document_id = ${documentId}
    `);
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
        (await tx.execute<{ acknowledgement: unknown }>(sql`
          select refusal_acknowledgement as acknowledgement from pay_runs
           where org_id = ${orgId} and document_id = ${documentId}
        `)).rows[0]?.acknowledgement,
      );
      result.refusalsAcknowledged = result.refusalAcknowledgement != null
        && result.refusalAcknowledgement.errorsDigest === payRunRefusalDigest(refusalsNow);
    }
    return result;
  }), { isolationLevel: "repeatable read" });
}

/**
 * One line of a stub under construction — earnings, deductions, and employer
 * contributions alike, in the order phases append them. Hoisted to module
 * level so the jurisdiction and persistence helpers below can name it; it
 * carries no behavior, only shape.
 */
/** Which rung of the expense-account resolution answered for a stub line. */
