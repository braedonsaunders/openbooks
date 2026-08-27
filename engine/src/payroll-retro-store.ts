import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, sum } from "./money.ts";
import { payrollTaxYear } from "./payroll/packs.ts";
import {
  calculatePayRun,
  createPayRun,
  payrollSubsidiaryScopeFilter,
  type CapturedStub,
  type PayrollSubsidiaryScope,
} from "./payroll-run.ts";
import {
  differenceRetroEarnings,
  payableRetroBuckets,
  retroOutcome,
  RetroPayError,
  type RetroBucket,
  type RetroDifference,
  type RetroEarningLine,
  type RetroOutcome,
  type RetroReason,
  type RetroSettledBucket,
  summarizeRetro,
  type RetroEmployeeSummary,
} from "./payroll-retro.ts";

/**
 * Retroactive pay — the database boundary around the pure difference in
 * `engine/src/payroll-retro.ts`.
 *
 * The four steps, and where each one lives:
 *
 *   DETECT   — `detectRetroCandidates`. An effective-dated change whose window
 *              covers a period that has ALREADY been committed. Deliberately
 *              generous: a trigger only claims the period's inputs moved after
 *              it was paid.
 *   QUANTIFY — `quantifyRetroCandidates`. Re-runs THE PAY RUN'S OWN
 *              calculation over each committed source run
 *              (`calculatePayRun({ simulate: true })`, which rolls everything
 *              back) and differences the EARNINGS it produces against the ones
 *              the committed stub actually paid. There is no second
 *              implementation of "what does this period pay" anywhere in this
 *              file, which is the single most important property it has.
 *   REVIEW   — `proposeRetroPay` (before anything is written) and
 *              `retroRunReview` (after the run exists). Old, new, delta, per
 *              employee per period, down to the job.
 *   PAY      — `createRetroPayRun` writes the settlements, and
 *              `retroEarningLinesForStub` is what `calculateStub` turns them
 *              into earning lines. Then the ordinary wizard: calculate,
 *              approve, commit, post.
 *
 * EXACTLY ONCE. Every settlement records what it settled TO
 * (`recomputed_earnings`) and what earlier COMMITTED retro runs had already
 * settled (`previously_settled`), per bucket. The next detection therefore
 * computes `recomputed − original − previously_settled` and gets zero for
 * anything already paid — and gets the incremental amount, correctly, when a
 * backdated change is itself corrected later. Nothing is ever marked "done";
 * the arithmetic simply has nothing left to give.
 *
 * COUNTRY-AGNOSTIC. No country or region literal appears in this file. The one
 * jurisdictional fact retro needs — how the amount is taxed — is
 * `PayrollCountryPack.retroactivePayTreatment`, read by `calculateStub`.
 */

/* ------------------------------------------------------------------ */
/* Detect                                                              */
/* ------------------------------------------------------------------ */

export interface RetroCandidate {
  employeePartyId: string;
  employeeName: string;
  /** The committed run being made good. */
  sourcePayRunDocumentId: string;
  sourceDocumentNumber: string;
  payScheduleId: string;
  payScheduleName: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  taxYear: number;
  reasons: RetroReason[];
}

export interface DetectRetroInput {
  orgId: string;
  /** Only runs in this statutory year are candidates. See the refusal below. */
  taxYear: number;
  payScheduleId?: string;
  employeePartyIds?: readonly string[];
  executor?: Pick<typeof db, "execute">;
  /** Caller role scope; null/undefined is unrestricted. */
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}

/**
 * Committed periods whose inputs have moved since they were paid.
 *
 * The reference point is `pay_stubs.created_at` — when the stub was last
 * CALCULATED, which is the moment the period's inputs were read. A row that
 * was created or updated after that could have changed the answer; a row that
 * predates it was already accounted for.
 *
 * Voided runs are excluded through `run_status`, which `releaseVoidedPayRun`
 * sets to 'voided' precisely so every consumer of the payroll subledger can
 * filter on one column (engine/src/document-void.ts).
 *
 * Retro runs are never themselves sources: their earnings ARE differences, and
 * re-differencing a difference double-counts it.
 */
export async function detectRetroCandidates(input: DetectRetroInput): Promise<RetroCandidate[]> {
  const executor = input.executor ?? db;
  const employeeFilter = input.employeePartyIds && input.employeePartyIds.length > 0
    ? sql`and s.employee_party_id = any(${`{${[...input.employeePartyIds].join(",")}}`}::uuid[])`
    : sql``;
  const scheduleFilter = input.payScheduleId
    ? sql`and r.pay_schedule_id = ${input.payScheduleId}`
    : sql``;

  const rows = (await executor.execute<{
      employee_party_id: string; employee_name: string;
      source_document_id: string; source_document_number: string;
      pay_schedule_id: string; pay_schedule_name: string;
      period_start: string; period_end: string; pay_date: string; tax_year: number;
      wage_detail: string | null; component_detail: string | null;
      unclaimed_hours: string | null;
    }>(sql`
    select s.employee_party_id, p.display_name as employee_name,
           r.document_id as source_document_id, d.document_number as source_document_number,
           r.pay_schedule_id, sch.name as pay_schedule_name,
           r.period_start::text as period_start, r.period_end::text as period_end,
           r.pay_date::text as pay_date, r.tax_year,
           -- A wage row that governs this period and was touched after it was
           -- paid. labor_cost_rates (employee scope) is the ONE home for a
           -- wage; payroll and the costing engine resolve the same row.
           (select string_agg(distinct
                     'wage ' || w.rate::text || ' per ' || w.basis
                     || ' effective ' || w.effective_from::text, '; ')
              from labor_cost_rates w
             where w.org_id = s.org_id and w.employee_party_id = s.employee_party_id
               and w.effective_from <= r.period_end
               and greatest(w.created_at, w.updated_at) > s.created_at) as wage_detail,
           -- A backdated pay-component assignment (an allowance, a shift
           -- premium). Only its EARNINGS effect is ever quantified.
           (select string_agg(distinct
                     c.name || ' effective ' || a.effective_from::text, '; ')
              from employee_pay_components a
              join pay_components c on c.id = a.component_id and c.org_id = a.org_id
             where a.org_id = s.org_id and a.employee_party_id = s.employee_party_id
               and a.effective_from <= r.period_end
               and greatest(a.created_at, a.updated_at) > s.created_at) as component_detail,
           -- Approved hours inside a period that has been paid, which no run
           -- ever claimed: a late timesheet is retro pay by any other name.
           (select sum(t.hours)::text
              from time_entries t
             where t.org_id = s.org_id and t.employee_party_id = s.employee_party_id
               and t.status = 'approved' and t.payroll_batch_ref is null
               and t.worked_on between r.period_start and r.period_end) as unclaimed_hours
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      join pay_schedules sch on sch.id = r.pay_schedule_id and sch.org_id = r.org_id
      join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
     where s.org_id = ${input.orgId}
       and r.run_status = 'committed'
       and r.run_type <> 'retro'
       and r.tax_year = ${input.taxYear}
       ${scheduleFilter}
       ${employeeFilter}
       ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, input.allowedSubsidiaryIds)}
     order by p.display_name, r.period_end
  `));

  const candidates: RetroCandidate[] = [];
  for (const row of rows.rows) {
    const reasons: RetroReason[] = [];
    if (row.wage_detail) {
      reasons.push({ source: "wage_rate", detail: row.wage_detail });
    }
    if (row.component_detail) {
      reasons.push({ source: "pay_component", detail: row.component_detail });
    }
    if (row.unclaimed_hours && cmp(row.unclaimed_hours, "0") > 0) {
      reasons.push({
        source: "unclaimed_time",
        detail: `${row.unclaimed_hours} approved hours in this period were never paid`,
      });
    }
    if (reasons.length === 0) continue;
    candidates.push({
      employeePartyId: row.employee_party_id,
      employeeName: row.employee_name,
      sourcePayRunDocumentId: row.source_document_id,
      sourceDocumentNumber: row.source_document_number,
      payScheduleId: row.pay_schedule_id,
      payScheduleName: row.pay_schedule_name,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      payDate: row.pay_date,
      taxYear: Number(row.tax_year),
      reasons,
    });
  }
  return candidates;
}

/* ------------------------------------------------------------------ */
/* Quantify                                                            */
/* ------------------------------------------------------------------ */

/**
 * `unavailable` is its own outcome and never a delta.
 *
 * An employee who had a committed stub but produces NO stub when the period is
 * recalculated (their profile was deactivated, they moved pay schedule, their
 * calculation now errors) would otherwise difference to `0 − original`, i.e. a
 * large NEGATIVE retro on somebody whose pay nobody changed. That is a gap in
 * the recomputation, not a fact about the money, and it is reported as one.
 */
export type RetroQuantifiedOutcome = RetroOutcome | "unavailable";

export interface RetroQuantifiedPeriod {
  candidate: RetroCandidate;
  outcome: RetroQuantifiedOutcome;
  /** Null only when `outcome` is `unavailable`. */
  difference: RetroDifference | null;
  /** Why the period could not be quantified. Plain English, no i18n key. */
  blockedReason: string | null;
}

export interface RetroProposal {
  taxYear: number;
  periods: RetroQuantifiedPeriod[];
  employees: RetroEmployeeSummary[];
  /** Sum of every payable delta — what a retro run built from this would pay. */
  payableTotal: string;
  /** Sum of every negative delta. Reported; never paid. See RetroOutcome. */
  overpaidTotal: string;
  /** Periods that could not be recalculated at all. */
  unavailable: number;
}

/**
 * Recalculate each candidate's source run and difference its earnings.
 *
 * ONE simulation per source RUN, not per employee: the calculation is a whole
 * run's worth of work either way, and running it once keeps every employee's
 * difference derived from a single consistent recalculation.
 */
export async function quantifyRetroCandidates(input: {
  orgId: string;
  actorId: string;
  candidates: readonly RetroCandidate[];
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}): Promise<RetroQuantifiedPeriod[]> {
  const { orgId, actorId } = input;
  const bySourceRun = new Map<string, RetroCandidate[]>();
  for (const candidate of input.candidates) {
    const existing = bySourceRun.get(candidate.sourcePayRunDocumentId);
    if (existing) existing.push(candidate);
    else bySourceRun.set(candidate.sourcePayRunDocumentId, [candidate]);
  }

  const quantified: RetroQuantifiedPeriod[] = [];
  for (const [sourceDocumentId, candidates] of bySourceRun) {
    let stubs: CapturedStub[] = [];
    let errors: { employee: string; message: string }[] = [];
    let simulationFailure: string | null = null;
    try {
      // The seam. `simulate` implies a rolled-back dry run inside
      // calculatePayRun itself, so nothing this touches survives the call.
      const result = await calculatePayRun({
        orgId,
        documentId: sourceDocumentId,
        actorId,
        simulate: true,
        allowedSubsidiaryIds: input.allowedSubsidiaryIds,
      });
      stubs = result.stubs ?? [];
      errors = result.errors;
    } catch (error) {
      simulationFailure = error instanceof Error ? error.message : String(error);
    }

    const original = await committedEarningLines(orgId, sourceDocumentId);
    const settled = await previouslySettledBuckets(orgId, sourceDocumentId);
    const recomputed = new Map<string, RetroEarningLine[]>();
    for (const stub of stubs) {
      recomputed.set(
        stub.employeePartyId,
        stub.lines
          .filter((line) => line.kind === "earning")
          .map((line) => ({
            componentId: line.componentId,
            description: line.description,
            projectId: line.projectId,
            departmentId: line.departmentId,
            amount: line.amount,
            hours: line.hours,
          })),
      );
    }

    for (const candidate of candidates) {
      if (simulationFailure) {
        quantified.push({
          candidate, outcome: "unavailable", difference: null,
          blockedReason: `${candidate.sourceDocumentNumber} could not be recalculated: `
            + simulationFailure,
        });
        continue;
      }
      const recomputedLines = recomputed.get(candidate.employeePartyId);
      if (!recomputedLines) {
        const named = errors.find((e) => e.employee === candidate.employeeName);
        quantified.push({
          candidate, outcome: "unavailable", difference: null,
          blockedReason: named
            ? `${candidate.sourceDocumentNumber} no longer calculates for this employee: `
              + named.message
            : `${candidate.sourceDocumentNumber} no longer produces a stub for this employee — `
              + "their payroll profile, schedule or employment has changed since it was paid",
        });
        continue;
      }
      const difference = differenceRetroEarnings({
        original: original.get(candidate.employeePartyId) ?? [],
        recomputed: recomputedLines,
        settled: settled.get(candidate.employeePartyId) ?? [],
      });
      quantified.push({
        candidate,
        outcome: retroOutcome(difference.delta),
        difference,
        blockedReason: null,
      });
    }
  }
  return quantified;
}

/** The EARNINGS a committed run actually paid, per employee. */
async function committedEarningLines(
  orgId: string, sourceDocumentId: string,
  executor: Pick<typeof db, "execute"> = db,
): Promise<Map<string, RetroEarningLine[]>> {
  const rows = (await executor.execute<{
      employee_party_id: string; component_id: string | null; description: string;
      project_id: string | null; department_id: string | null;
      amount: string; hours: string | null;
    }>(sql`
    select s.employee_party_id, l.component_id, l.description, l.project_id, l.department_id,
           l.amount, l.hours
      from pay_stub_lines l
      join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
     where l.org_id = ${orgId} and s.pay_run_document_id = ${sourceDocumentId}
       and l.kind = 'earning'
     order by s.employee_party_id, l.sequence
  `));
  const byEmployee = new Map<string, RetroEarningLine[]>();
  for (const row of rows.rows) {
    const lines = byEmployee.get(row.employee_party_id) ?? [];
    lines.push({
      componentId: row.component_id,
      description: row.description,
      projectId: row.project_id,
      departmentId: row.department_id,
      amount: row.amount,
      hours: row.hours,
    });
    byEmployee.set(row.employee_party_id, lines);
  }
  return byEmployee;
}

/**
 * What COMMITTED retro runs have already settled against one source run.
 *
 * `run_status = 'committed'` is the whole predicate: voiding a pay run sets it
 * to 'voided' (engine/src/document-void.ts) precisely so the subledger can be
 * filtered on one column, and a voided retro run's money has been reversed —
 * so it is owed again, and must not count as settled.
 */
async function previouslySettledBuckets(
  orgId: string, sourceDocumentId: string,
  executor: Pick<typeof db, "execute"> = db,
): Promise<Map<string, RetroSettledBucket[]>> {
  const rows = (await executor.execute<{
      employee_party_id: string; component_id: string | null;
      project_id: string | null; department_id: string | null;
      description: string | null; previously_settled: string;
    }>(sql`
    select st.employee_party_id, a.component_id, a.project_id, a.department_id,
           min(a.description) as description, sum(a.amount)::text as previously_settled
      from payroll_retro_allocations a
      join payroll_retro_settlements st on st.id = a.settlement_id and st.org_id = a.org_id
      join pay_runs rr on rr.document_id = st.retro_pay_run_document_id and rr.org_id = st.org_id
     where st.org_id = ${orgId} and st.source_pay_run_document_id = ${sourceDocumentId}
       and rr.run_status = 'committed'
     group by st.employee_party_id, a.component_id, a.project_id, a.department_id
  `));
  const byEmployee = new Map<string, RetroSettledBucket[]>();
  for (const row of rows.rows) {
    const buckets = byEmployee.get(row.employee_party_id) ?? [];
    buckets.push({
      componentId: row.component_id,
      projectId: row.project_id,
      departmentId: row.department_id,
      previouslySettled: row.previously_settled,
      description: row.description,
    });
    byEmployee.set(row.employee_party_id, buckets);
  }
  return byEmployee;
}

/* ------------------------------------------------------------------ */
/* Review                                                              */
/* ------------------------------------------------------------------ */

/** The statutory year a pay date falls in for the SCHEDULE'S legal entity. */
async function scheduleTaxYear(
  orgId: string, payScheduleId: string, payDate: string,
  executor: Pick<typeof db, "execute"> = db,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<number> {
  const rows = (await executor.execute<{ country: string | null; subsidiary_id: string | null }>(sql`
    select coalesce(sub.country, root.country) as country,
           coalesce(sub.id, root.id) as subsidiary_id
      from pay_schedules sch
      left join subsidiaries sub on sub.id = sch.subsidiary_id and sub.org_id = sch.org_id
      left join lateral (
        select s.country from subsidiaries s
         where s.org_id = sch.org_id and s.parent_id is null and s.is_active
         order by s.created_at limit 1) root on true
     where sch.org_id = ${orgId} and sch.id = ${payScheduleId}
  `));
  if (!rows.rows[0]) throw new RetroPayError("pay schedule not found");
  const country = rows.rows[0].country;
  if (!country) {
    throw new RetroPayError(
      "the pay schedule's legal entity has no country, so no statutory year can be resolved "
      + "for it — set the subsidiary's country before running retroactive pay",
    );
  }
  if (
    !rows.rows[0].subsidiary_id
    || (allowedSubsidiaryIds != null && !allowedSubsidiaryIds.has(rows.rows[0].subsidiary_id))
  ) {
    throw new RetroPayError("pay schedule not found");
  }
  // The PACK's year definition, never `payDate.slice(0, 4)`.
  return payrollTaxYear(country, payDate);
}

/**
 * Detect and quantify, writing nothing — the review the operator sees BEFORE a
 * retro run exists. Silent retro is unacceptable, so this is the only way to
 * reach `createRetroPayRun` with anything in it.
 */
export async function proposeRetroPay(input: {
  orgId: string;
  actorId: string;
  payScheduleId: string;
  /** The date the retro run will pay on; decides the statutory year in scope. */
  payDate: string;
  employeePartyIds?: readonly string[];
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}): Promise<RetroProposal> {
  const taxYear = await scheduleTaxYear(
    input.orgId,
    input.payScheduleId,
    input.payDate,
    db,
    input.allowedSubsidiaryIds,
  );
  const candidates = await detectRetroCandidates({
    orgId: input.orgId,
    taxYear,
    payScheduleId: input.payScheduleId,
    employeePartyIds: input.employeePartyIds,
    allowedSubsidiaryIds: input.allowedSubsidiaryIds,
  });
  const periods = await quantifyRetroCandidates({
    orgId: input.orgId,
    actorId: input.actorId,
    candidates,
    allowedSubsidiaryIds: input.allowedSubsidiaryIds,
  });
  const withDifference = periods.filter((period) => period.difference !== null);
  return {
    taxYear,
    periods,
    employees: summarizeRetro(withDifference.map((period) => ({
      employeePartyId: period.candidate.employeePartyId,
      employeeName: period.candidate.employeeName,
      delta: period.difference!.delta,
    }))),
    payableTotal: sum(periods
      .filter((period) => period.outcome === "payable")
      .map((period) => period.difference!.delta)),
    overpaidTotal: sum(periods
      .filter((period) => period.outcome === "overpaid")
      .map((period) => period.difference!.delta)),
    unavailable: periods.filter((period) => period.outcome === "unavailable").length,
  };
}

/* ------------------------------------------------------------------ */
/* Pay                                                                 */
/* ------------------------------------------------------------------ */

export interface CreateRetroPayRunInput {
  orgId: string;
  actorId: string;
  payScheduleId: string;
  /** The date the retro run pays. Its accounting period must be open. */
  payDate: string;
  /** Restrict to these people; omitted = everyone the proposal found. */
  employeePartyIds?: readonly string[];
  /**
   * Source runs the operator chose NOT to settle on this run, by document id.
   * The operator is the control: a period they have not looked at is not
   * silently paid, and one they exclude here stays owed and is found again.
   */
  excludeSourcePayRunDocumentIds?: readonly string[];
  /** Caller role scope; null/undefined is unrestricted. */
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}

export interface CreateRetroPayRunResult {
  documentId: string;
  documentNumber: string;
  /** The proposal this run was built from — the review evidence. */
  proposal: RetroProposal;
  employees: number;
  settlements: number;
  total: string;
}

/**
 * Build the retro run: the differences, recorded, plus the pay run that pays
 * them.
 *
 * The run's PERIOD is the span of the source periods it settles, not the
 * current one. That is the truthful statement of what it covers, and it also
 * keeps `max(period_end)` — which is how the next REGULAR run derives its
 * period — from being dragged forward by an off-cycle run. Its PAY DATE is the
 * current one, which is what period control is checked against
 * (`payRunReadiness` flags `period.closed` on the pay date), so retro money
 * lands in an open period even though the work is in closed ones.
 */
export async function createRetroPayRun(
  input: CreateRetroPayRunInput,
): Promise<CreateRetroPayRunResult> {
  const { orgId, actorId } = input;
  const proposal = await proposeRetroPay({
    orgId, actorId,
    payScheduleId: input.payScheduleId,
    payDate: input.payDate,
    employeePartyIds: input.employeePartyIds,
    allowedSubsidiaryIds: input.allowedSubsidiaryIds,
  });
  const excluded = new Set(input.excludeSourcePayRunDocumentIds ?? []);
  const paying = proposal.periods.filter((period) =>
    period.outcome === "payable" && !excluded.has(period.candidate.sourcePayRunDocumentId));
  if (paying.length === 0) {
    throw new RetroPayError(
      "there is nothing to pay retroactively: no committed period in this statutory year "
      + "produces a positive difference against what it already paid",
    );
  }
  // Retro that crosses a statutory year is a different exercise — it changes
  // year-end slips that have been filed, and the amendment is the correct
  // instrument. Refused by name rather than paid into the wrong year.
  const crossYear = paying.filter((period) => period.candidate.taxYear !== proposal.taxYear);
  if (crossYear.length > 0) {
    throw new RetroPayError(
      `${crossYear.length} period(s) fall in a different statutory year from the ${proposal.taxYear} `
      + "retro run — prior-year retroactive pay changes filed year-end slips and must go through "
      + "an amended return, not a current-year cheque",
    );
  }

  const employeePartyIds = [...new Set(paying.map((p) => p.candidate.employeePartyId))];
  const periodStart = paying
    .map((p) => p.candidate.periodStart)
    .reduce((a, b) => (a < b ? a : b));
  const periodEnd = paying
    .map((p) => p.candidate.periodEnd)
    .reduce((a, b) => (a > b ? a : b));

  const run = await createPayRun({
    orgId, actorId,
    payScheduleId: input.payScheduleId,
    periodStart, periodEnd,
    payDate: input.payDate,
    runType: "retro",
    employeePartyIds,
    allowedSubsidiaryIds: input.allowedSubsidiaryIds,
  });

  await db.transaction(async (tx) => {
    for (const period of paying) {
      const difference = period.difference!;
      const buckets = payableRetroBuckets(difference);
      const settlement = (await tx.execute<{ id: string }>(sql`
        insert into payroll_retro_settlements
          (org_id, retro_pay_run_document_id, employee_party_id, source_pay_run_document_id,
           source_period_start, source_period_end, source_pay_date, source_tax_year,
           original_earnings, recomputed_earnings, previously_settled, delta, reasons,
           created_by, updated_by)
        values
          (${orgId}, ${run.documentId}, ${period.candidate.employeePartyId},
           ${period.candidate.sourcePayRunDocumentId},
           ${period.candidate.periodStart}, ${period.candidate.periodEnd},
           ${period.candidate.payDate}, ${period.candidate.taxYear},
           ${difference.originalEarnings}, ${difference.recomputedEarnings},
           ${difference.previouslySettled}, ${difference.delta},
           ${JSON.stringify(period.candidate.reasons)}::jsonb, ${actorId}, ${actorId})
        returning id
      `));
      const settlementId = settlement.rows[0]!.id;
      for (const bucket of buckets) {
        await tx.execute(sql`
          insert into payroll_retro_allocations
            (org_id, settlement_id, component_id, description, project_id, department_id,
             original_amount, recomputed_amount, previously_settled, amount,
             original_hours, recomputed_hours, created_by, updated_by)
          values
            (${orgId}, ${settlementId}, ${bucket.componentId}, ${bucket.description},
             ${bucket.projectId}, ${bucket.departmentId},
             ${bucket.originalAmount}, ${bucket.recomputedAmount}, ${bucket.previouslySettled},
             ${bucket.amount}, ${bucket.originalHours}, ${bucket.recomputedHours},
             ${actorId}, ${actorId})
        `);
      }
    }
  });

  return {
    documentId: run.documentId,
    documentNumber: run.documentNumber,
    proposal,
    employees: employeePartyIds.length,
    settlements: paying.length,
    total: sum(paying.map((period) => period.difference!.delta)),
  };
}

/* ------------------------------------------------------------------ */
/* The retro run's earning lines                                       */
/* ------------------------------------------------------------------ */

export interface RetroStubEarningLine {
  componentId: string;
  description: string;
  projectId: string | null;
  departmentId: string | null;
  amount: string;
  /** The component's OWN flag — never a retro-specific hardcode. */
  vacationable: boolean;
  /** The PACK's declared retroactive treatment, resolved by the caller. */
  nonPeriodic: boolean;
  sequence: number;
}

/**
 * The settled differences, as earning lines for one employee's retro stub.
 *
 * Called from `calculateStub` (engine/src/payroll-run.ts). These rows are both
 * the payment and the audit evidence, so nothing here recomputes an amount:
 * every number was quantified, reviewed and written before the run existed,
 * and this only turns it into lines.
 *
 * Two invariants are enforced here rather than trusted, because this is the
 * last point at which they are checkable before money is on a stub:
 *
 *  - the lines must sum to EXACTLY the settled deltas for this employee;
 *  - every line must still have a live pay component, so the earning has a
 *    classification (taxable, pensionable, vacationable) and an expense
 *    account. A retired component would silently default all three.
 */
export async function retroEarningLinesForStub(
  tx: Pick<typeof db, "execute">,
  input: {
    orgId: string;
    payRunDocumentId: string;
    employeePartyId: string;
    employeeName: string;
    nonPeriodic: boolean;
    allowedSubsidiaryIds?: PayrollSubsidiaryScope;
  },
): Promise<RetroStubEarningLine[]> {
  const rows = (await tx.execute<{
      settlement_id: string;
      component_id: string | null; description: string;
      project_id: string | null; department_id: string | null; amount: string;
      vacationable: boolean | null; is_active: boolean | null; component_name: string | null;
      source_period_start: string; source_period_end: string; delta: string;
    }>(sql`
    select st.id as settlement_id,
           a.component_id, a.description, a.project_id, a.department_id, a.amount,
           c.vacationable, c.is_active, c.name as component_name,
           st.source_period_start::text as source_period_start,
           st.source_period_end::text as source_period_end,
           st.delta
      from payroll_retro_settlements st
      join payroll_retro_allocations a on a.settlement_id = st.id and a.org_id = st.org_id
      left join parties ep on ep.id = st.employee_party_id and ep.org_id = st.org_id
      left join pay_components c on c.id = a.component_id and c.org_id = st.org_id
     where st.org_id = ${input.orgId}
       and st.retro_pay_run_document_id = ${input.payRunDocumentId}
       and st.employee_party_id = ${input.employeePartyId}
       ${payrollSubsidiaryScopeFilter(sql`ep.subsidiary_id`, input.allowedSubsidiaryIds)}
     order by st.source_period_start, a.description
  `));
  if (rows.rows.length === 0) return [];

  const lines: RetroStubEarningLine[] = [];
  let sequence = 50;
  for (const row of rows.rows) {
    if (!row.component_id || row.is_active !== true) {
      throw new RetroPayError(
        `the retroactive difference for ${input.employeeName} in `
        + `${row.source_period_start} – ${row.source_period_end} is against `
        + `"${row.component_name ?? row.description}", a pay component that no longer exists or is `
        + "inactive — reactivate it, or re-quantify the retro run against the components in use",
      );
    }
    if (cmp(row.amount, "0") === 0) continue;
    lines.push({
      componentId: row.component_id,
      // Naming the period on the line is not decoration: an employee looking
      // at a retro cheque has to be able to see which pay it makes good.
      description: `${row.description} — retro ${row.source_period_start} to ${row.source_period_end}`,
      projectId: row.project_id,
      departmentId: row.department_id,
      amount: row.amount,
      vacationable: row.vacationable === true,
      nonPeriodic: input.nonPeriodic,
      sequence: sequence++,
    });
  }

  // The settled deltas, and the lines that are about to be paid against them.
  // Keyed on the SETTLEMENT, not on its period: two runs can legitimately cover
  // the same days (an off-cycle bonus inside a regular period), and collapsing
  // them by date would silently drop one of the two deltas from the check.
  const settledTotal = sum([...new Map(
    rows.rows.map((row) => [row.settlement_id, row.delta]),
  ).values()]);
  const lineTotal = sum(lines.map((line) => line.amount));
  if (cmp(lineTotal, settledTotal) !== 0) {
    throw new RetroPayError(
      `retroactive lines ${lineTotal} for ${input.employeeName} do not equal the `
      + `${settledTotal} settled — the run cannot pay an amount its evidence does not support`,
    );
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* Review of a retro run that already exists                           */
/* ------------------------------------------------------------------ */

export interface RetroReviewAllocation {
  componentName: string | null;
  description: string;
  projectId: string | null;
  projectName: string | null;
  departmentId: string | null;
  departmentName: string | null;
  originalAmount: string;
  recomputedAmount: string;
  previouslySettled: string;
  amount: string;
  originalHours: string | null;
  recomputedHours: string | null;
}

export interface RetroReviewSettlement {
  id: string;
  employeePartyId: string;
  employeeName: string;
  sourceDocumentNumber: string;
  sourcePeriodStart: string;
  sourcePeriodEnd: string;
  sourcePayDate: string;
  originalEarnings: string;
  recomputedEarnings: string;
  previouslySettled: string;
  delta: string;
  reasons: RetroReason[];
  allocations: RetroReviewAllocation[];
}

export interface RetroRunReview {
  documentId: string;
  settlements: RetroReviewSettlement[];
  employees: RetroEmployeeSummary[];
  total: string;
}

/** Old vs new vs delta, per employee per period, for a retro run that exists. */
export async function retroRunReview(
  orgId: string, documentId: string,
  executor: Pick<typeof db, "execute"> = db,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<RetroRunReview> {
  const settlements = (await executor.execute<{
      id: string; employee_party_id: string; employee_name: string;
      source_document_number: string; source_period_start: string;
      source_period_end: string; source_pay_date: string;
      original_earnings: string; recomputed_earnings: string;
      previously_settled: string; delta: string; reasons: RetroReason[];
    }>(sql`
    select st.id, st.employee_party_id, p.display_name as employee_name,
           d.document_number as source_document_number,
           st.source_period_start::text as source_period_start,
           st.source_period_end::text as source_period_end,
           st.source_pay_date::text as source_pay_date,
           st.original_earnings, st.recomputed_earnings, st.previously_settled, st.delta,
           st.reasons
      from payroll_retro_settlements st
      join parties p on p.id = st.employee_party_id and p.org_id = st.org_id
      join documents d on d.id = st.source_pay_run_document_id and d.org_id = st.org_id
      join documents retro_doc on retro_doc.id = st.retro_pay_run_document_id and retro_doc.org_id = st.org_id
     where st.org_id = ${orgId} and st.retro_pay_run_document_id = ${documentId}
       ${payrollSubsidiaryScopeFilter(sql`retro_doc.subsidiary_id`, allowedSubsidiaryIds)}
       ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
     order by p.display_name, st.source_period_start
  `));
  if (settlements.rows.length === 0) {
    return { documentId, settlements: [], employees: [], total: "0" };
  }

  const allocations = (await executor.execute<({ settlement_id: string } & Record<string, string | null>)>(sql`
    select a.settlement_id, a.description, c.name as component_name,
           a.project_id, proj.name as project_name,
           a.department_id, dept.name as department_name,
           a.original_amount, a.recomputed_amount, a.previously_settled, a.amount,
           a.original_hours, a.recomputed_hours
      from payroll_retro_allocations a
      join payroll_retro_settlements st on st.id = a.settlement_id and st.org_id = a.org_id
      left join pay_components c on c.id = a.component_id and c.org_id = a.org_id
      left join projects proj on proj.id = a.project_id and proj.org_id = a.org_id
      left join departments dept on dept.id = a.department_id and dept.org_id = a.org_id
     where a.org_id = ${orgId} and st.retro_pay_run_document_id = ${documentId}
     order by a.amount desc
  `));
  const bySettlement = new Map<string, RetroReviewAllocation[]>();
  for (const row of allocations.rows) {
    const list = bySettlement.get(row.settlement_id) ?? [];
    list.push({
      componentName: row.component_name ?? null,
      description: String(row.description ?? ""),
      projectId: row.project_id ?? null,
      projectName: row.project_name ?? null,
      departmentId: row.department_id ?? null,
      departmentName: row.department_name ?? null,
      originalAmount: String(row.original_amount ?? "0"),
      recomputedAmount: String(row.recomputed_amount ?? "0"),
      previouslySettled: String(row.previously_settled ?? "0"),
      amount: String(row.amount ?? "0"),
      originalHours: row.original_hours ?? null,
      recomputedHours: row.recomputed_hours ?? null,
    });
    bySettlement.set(row.settlement_id, list);
  }

  const rows: RetroReviewSettlement[] = settlements.rows.map((row) => ({
    id: row.id,
    employeePartyId: row.employee_party_id,
    employeeName: row.employee_name,
    sourceDocumentNumber: row.source_document_number,
    sourcePeriodStart: row.source_period_start,
    sourcePeriodEnd: row.source_period_end,
    sourcePayDate: row.source_pay_date,
    originalEarnings: row.original_earnings,
    recomputedEarnings: row.recomputed_earnings,
    previouslySettled: row.previously_settled,
    delta: row.delta,
    reasons: Array.isArray(row.reasons) ? row.reasons : [],
    allocations: bySettlement.get(row.id) ?? [],
  }));

  return {
    documentId,
    settlements: rows,
    employees: summarizeRetro(rows.map((row) => ({
      employeePartyId: row.employeePartyId,
      employeeName: row.employeeName,
      delta: row.delta,
    }))),
    total: sum(rows.map((row) => row.delta)),
  };
}

/* ------------------------------------------------------------------ */
/* Pre-flight                                                          */
/* ------------------------------------------------------------------ */

/**
 * A retro-specific pre-flight finding, in the shape `payRunReadiness` flags.
 *
 * Kept here rather than in payroll-readiness.ts so the whole retro rule set
 * has one home; the pre-flight surfaces them (see .local/handoff-retro.md).
 * They are also ENFORCED — not merely displayed — at the two points where it
 * matters: `createRetroPayRun` cannot build a run that violates them, and
 * `retroEarningLinesForStub` refuses to produce lines for one that does.
 */
export interface RetroReadinessFinding {
  severity: "blocker" | "warning";
  /** Stable code; the run wizard localizes it. */
  code: string;
  detail?: string;
  employees: { partyId: string; name: string }[];
}

export async function retroRunFindings(
  orgId: string, documentId: string,
  executor: Pick<typeof db, "execute"> = db,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<RetroReadinessFinding[]> {
  const findings: RetroReadinessFinding[] = [];
  const runRows = (await executor.execute<{ run_type: string; tax_year: number }>(sql`
    select r.run_type, r.tax_year from pay_runs r
     where r.org_id = ${orgId} and r.document_id = ${documentId}
  `));
  const run = runRows.rows[0];
  if (!run || run.run_type !== "retro") return findings;

  const rows = (await executor.execute<{
      id: string; employee_party_id: string; employee_name: string;
      source_pay_run_document_id: string; source_tax_year: number;
      previously_settled: string; delta: string; source_document_number: string;
      source_run_status: string; wage_moved: boolean; component_moved: boolean;
      other_committed: string; other_open: number; retired_components: number;
    }>(sql`
    select st.id, st.employee_party_id, p.display_name as employee_name,
           st.source_pay_run_document_id, st.source_tax_year, st.quantified_at,
           st.previously_settled, st.delta,
           d.document_number as source_document_number,
           -- The source run's own status. A voided source has no difference to
           -- make good, and its stub lines are no longer part of the subledger.
           src.run_status as source_run_status,
           -- Has anything the detection triggers watch moved since this
           -- settlement was quantified? If so the numbers on it are stale and
           -- the run would pay a difference nobody has reviewed.
           exists (
             select 1 from labor_cost_rates w
              where w.org_id = st.org_id and w.employee_party_id = st.employee_party_id
                and w.effective_from <= st.source_period_end
                and greatest(w.created_at, w.updated_at) > st.quantified_at) as wage_moved,
           exists (
             select 1 from employee_pay_components a
              where a.org_id = st.org_id and a.employee_party_id = st.employee_party_id
                and a.effective_from <= st.source_period_end
                and greatest(a.created_at, a.updated_at) > st.quantified_at) as component_moved,
           -- Another retro run holding the same cell. If it is COMMITTED its
           -- delta must already be inside our previously_settled; if it is not,
           -- two open runs are about to settle the same money.
           coalesce((select sum(other.delta) from payroll_retro_settlements other
                       join pay_runs orr on orr.document_id = other.retro_pay_run_document_id
                                        and orr.org_id = other.org_id
                      where other.org_id = st.org_id
                        and other.employee_party_id = st.employee_party_id
                        and other.source_pay_run_document_id = st.source_pay_run_document_id
                        and other.retro_pay_run_document_id <> st.retro_pay_run_document_id
                        and orr.run_status = 'committed'), 0)::text as other_committed,
           (select count(*) from payroll_retro_settlements other
              join pay_runs orr on orr.document_id = other.retro_pay_run_document_id
                               and orr.org_id = other.org_id
             where other.org_id = st.org_id
               and other.employee_party_id = st.employee_party_id
               and other.source_pay_run_document_id = st.source_pay_run_document_id
               and other.retro_pay_run_document_id <> st.retro_pay_run_document_id
               and orr.run_status in ('draft', 'calculated'))::int as other_open,
           (select count(*) from payroll_retro_allocations a
              left join pay_components c on c.id = a.component_id and c.org_id = a.org_id
             where a.settlement_id = st.id
               and (a.component_id is null or c.is_active is not true))::int as retired_components
      from payroll_retro_settlements st
      join parties p on p.id = st.employee_party_id and p.org_id = st.org_id
      join pay_runs src on src.document_id = st.source_pay_run_document_id and src.org_id = st.org_id
      join documents d on d.id = st.source_pay_run_document_id and d.org_id = st.org_id
      join documents retro_doc on retro_doc.id = st.retro_pay_run_document_id and retro_doc.org_id = st.org_id
     where st.org_id = ${orgId} and st.retro_pay_run_document_id = ${documentId}
       ${payrollSubsidiaryScopeFilter(sql`retro_doc.subsidiary_id`, allowedSubsidiaryIds)}
       ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
  `));

  if (rows.rows.length === 0) {
    findings.push({
      severity: "blocker", code: "retro.noSettlements", employees: [],
    });
    return findings;
  }

  const collect = (
    severity: "blocker" | "warning",
    code: string,
    matching: typeof rows.rows,
    detail?: string,
  ) => {
    if (matching.length === 0) return;
    const employees = [...new Map(matching.map((row) =>
      [row.employee_party_id, { partyId: row.employee_party_id, name: row.employee_name }],
    )).values()];
    findings.push({ severity, code, employees, ...(detail ? { detail } : {}) });
  };

  collect("blocker", "retro.sourceVoided",
    rows.rows.filter((row) => row.source_run_status !== "committed"),
    rows.rows.find((row) => row.source_run_status !== "committed")?.source_document_number);

  collect("blocker", "retro.crossTaxYear",
    rows.rows.filter((row) => Number(row.source_tax_year) !== Number(run.tax_year)),
    String(run.tax_year));

  collect("blocker", "retro.stale",
    rows.rows.filter((row) =>
      row.wage_moved || row.component_moved
      || cmp(row.other_committed, row.previously_settled) !== 0));

  collect("blocker", "retro.doubleSettled",
    rows.rows.filter((row) => row.other_open > 0));

  collect("blocker", "retro.componentRetired",
    rows.rows.filter((row) => row.retired_components > 0));

  // Advisory: the run pays nothing for somebody it names. Not a blocker — the
  // stub is correct and an operator may have excluded the amount deliberately.
  collect("warning", "retro.zeroDelta",
    rows.rows.filter((row) => cmp(row.delta, "0") === 0));

  return findings;
}

/** Total a retro run will pay, for the wizard's summary line. */
export async function retroRunTotal(
  orgId: string, documentId: string,
  executor: Pick<typeof db, "execute"> = db,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<string> {
  const rows = (await executor.execute<{ total: string }>(sql`
    select coalesce(sum(st.delta), 0)::text as total from payroll_retro_settlements st
      join documents d on d.id = st.retro_pay_run_document_id and d.org_id = st.org_id
      join parties p on p.id = st.employee_party_id and p.org_id = st.org_id
     where st.org_id = ${orgId} and st.retro_pay_run_document_id = ${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
       ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
  `));
  return rows.rows[0]?.total ?? "0";
}

export type { RetroBucket, RetroDifference, RetroEmployeeSummary, RetroReason };
