/**
 * Calculated-run reset and subsidiary rescope.
 *
 * Kept beside run-lifecycle.ts so each operation module stays within the
 * line bound. Callers still import these functions from run-lifecycle.ts.
 */
import { clearCalculatedHolidayAllocations } from "./holiday-obligation-source.ts";

import { sql } from "drizzle-orm";

import { db } from "../platform/db.ts";

import { PayrollError } from "./error.ts";

import { resolvePayrollRunContext } from "./packs.ts";

import { releaseLeavePayrollInputs } from "./leave-payroll-inputs.ts";

import { releaseAllowancePayrollInputs } from "./allowance-payroll-inputs.ts";

/**
 * Drop a run's derived calculation snapshot and return it to draft: stubs,
 * calculation errors and the refusal acknowledgement TOGETHER.
 *
 * The three are one fact — "what the last calculate saw" — and every path
 * that resets a calculated run to draft must clear all three. Clearing the
 * stubs while leaving `calculation_errors` and `refusal_acknowledgement`
 * behind shows exceptions (and an acknowledgement) for stubs that no longer
 * exist until the next calculation, and an acknowledgement outliving its
 * refusal set reads as authorizing a situation nobody saw. A recalculation
 * re-derives all three wholesale, so nothing cleared here is lost.
 */
export async function invalidateCalculatedRun(
  tx: Pick<typeof db, "execute">,
  input: { orgId: string; actorId: string; documentId: string },
): Promise<void> {
  const { orgId, actorId, documentId } = input;
  await releaseLeavePayrollInputs(tx, { orgId, runDocumentId: documentId });
  await releaseAllowancePayrollInputs(tx, { orgId, runDocumentId: documentId });
  await tx.execute(
    sql`delete from pay_run_benefit_allocations where org_id = ${orgId} and pay_run_document_id = ${documentId}`,
  );
  await clearCalculatedHolidayAllocations(tx, orgId, documentId);
  // Derived bank movements must go before their stub lines; clearing a line
  // reference would rewrite append-only entitlement evidence.
  await tx.execute(
    sql`delete from entitlement_ledger where org_id = ${orgId} and pay_run_document_id = ${documentId}`,
  );
  await tx.execute(sql`
    delete from pay_stubs where org_id = ${orgId} and pay_run_document_id = ${documentId}`);
  await tx.execute(sql`
    update pay_runs
       set run_status = 'draft', gross_total = 0, net_total = 0,
           employer_cost_total = 0, employee_count = 0, calculated_at = null,
           calculation_errors = '[]'::jsonb, refusal_acknowledgement = null, benefit_source_snapshot = null,
           updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and document_id = ${documentId}`);
}

/**
 * Move one uncommitted run onto its schedule's current subsidiary.
 *
 * Entity and currency move TOGETHER — they froze together at creation, and
 * moving one without the other fixes the error message while leaving the
 * wrong-money half behind. The stale calculation is dropped (stubs, ledger
 * movements, totals, evidence digest) so the next test calculates against
 * the new entity from scratch; operator adjustments are kept. The run's own
 * row is locked and its status re-asserted as uncommitted under the lock, so
 * a commit racing the re-scope serializes here instead of being reset to
 * draft beneath its posted lines.
 */
export async function reresolveRunToSubsidiary(
  tx: Pick<typeof db, "execute">,
  input: { orgId: string; actorId: string; documentId: string; subsidiaryId: string },
): Promise<{ currency: string; taxYear: number }> {
  const { orgId, actorId, documentId, subsidiaryId } = input;
  const sub = await tx.execute<{
    id: string;
    name: string;
    country: string | null;
    currency_code: string | null;
  }>(
    sql`
    select id, name, country, base_currency as currency_code from subsidiaries
     where org_id = ${orgId} and id = ${subsidiaryId} and is_active`,
    "objects",
  );
  const subsidiary = sub[0];
  if (!subsidiary) {
    throw new PayrollError(
      "the pay schedule is scoped to a subsidiary that is missing or inactive — choose an " +
        "active subsidiary on the pay schedule, or discard this run and open a new one",
    );
  }
  // Defence in depth: hold the run's own row lock and re-assert it is still
  // uncommitted before dropping its calculation. The rescope caller rechecks
  // the full discardable predicate under the same lock; this assertion keeps
  // every OTHER caller (re-test healing, future writers) from resetting a
  // committed run to draft and orphaning its GL lines, even if they checked
  // the status earlier in their own transaction. The commit path takes this
  // same row lock first, so a commit racing a rescope serializes here.
  const runRow = await tx.execute<{
    pay_date: string;
    document_number: string;
    run_status: string;
  }>(
    sql`
    select r.pay_date::text as pay_date, d.document_number, r.run_status
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${documentId}
     for update of r, d`,
    "objects",
  );
  const run = runRow[0];
  if (!run) throw new PayrollError("pay run not found");
  if (run.run_status === "committed") {
    throw new PayrollError(
      `pay run ${run.document_number} committed while its schedule was being re-scoped — ` +
        "it stays on its frozen entity; void it to move it",
    );
  }
  let runContext;
  try {
    runContext = resolvePayrollRunContext({
      payDate: run.pay_date,
      subsidiary: {
        id: subsidiary.id,
        name: subsidiary.name,
        country: subsidiary.country,
        baseCurrency: subsidiary.currency_code,
      },
    });
  } catch (error) {
    throw new PayrollError(
      `pay run ${run.document_number} cannot follow its schedule to ${subsidiary.name}: ` +
        `${error instanceof Error ? error.message : String(error)} — fix the subsidiary, ` +
        "then re-save the schedule",
    );
  }
  await tx.execute(sql`
    delete from entitlement_ledger where org_id = ${orgId} and pay_run_document_id = ${documentId}`);
  // One shared invalidation: stubs, errors and acknowledgement go together.
  await invalidateCalculatedRun(tx, { orgId, actorId, documentId });
  await tx.execute(sql`
    update documents set subsidiary_id = ${subsidiary.id}, currency = ${runContext.currency},
           updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and id = ${documentId}`);
  await tx.execute(sql`
    update pay_runs set tax_year = ${runContext.taxYear},
           calculation_source_snapshot = null,
           calculation_source_digest = null, updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and document_id = ${documentId}`);
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'pay_runs', ${documentId}, 'update',
            ${JSON.stringify({
              operation: "rescope_pay_run",
              subsidiaryId: subsidiary.id,
              currency: runContext.currency,
              taxYear: runContext.taxYear,
            })}::jsonb, ${actorId})`);
  return { currency: runContext.currency, taxYear: runContext.taxYear };
}

/**
 * Re-resolve every uncommitted run on a re-scoped pay schedule.
 *
 * Freezing the paying entity at creation is correct — a posted run must be
 * reproducible — but the freeze must follow the schedule while the run is
 * still uncommitted. Committed, posted, paid and voided runs are history and
 * stay frozen; they are counted as untouched, not refused. An unscoped
 * schedule (subsidiary null) resolves nothing and returns zeros.
 */
export interface RescopedRunSkipped {
  documentId: string;
  documentNumber: string | null;
  reason: string;
}

export async function rescopePayScheduleRuns(
  runner: Pick<typeof db, "execute">,
  input: { orgId: string; payScheduleId: string; actorId: string },
): Promise<{ reresolved: number; untouched: number; skipped: RescopedRunSkipped[] }> {
  const { orgId, payScheduleId, actorId } = input;
  const s = await runner.execute<{ subsidiary_id: string | null }>(
    sql`
    select subsidiary_id from pay_schedules where org_id = ${orgId} and id = ${payScheduleId}`,
    "objects",
  );
  const schedule = s[0];
  if (!schedule) throw new PayrollError("pay schedule not found");
  if (!schedule.subsidiary_id) return { reresolved: 0, untouched: 0, skipped: [] };
  const runs = await runner.execute<{ document_id: string }>(
    sql`
    select r.document_id::text as document_id
      from pay_runs r
     where r.org_id = ${orgId} and r.pay_schedule_id = ${payScheduleId}
     order by r.document_id`,
    "objects",
  );
  let reresolved = 0;
  let untouched = 0;
  const skipped: RescopedRunSkipped[] = [];
  for (const candidate of runs) {
    // Lock the candidate and recheck its lifecycle UNDER the lock. The
    // snapshot above is only a candidate list: a commit that posts lines and
    // flips the status after the snapshot would otherwise have its stubs
    // deleted and its status reset to draft below, orphaning GL lines and
    // time-entry claims. The commit path takes this same row lock first, so
    // the two serialize — the loser of the race sees the winner's status.
    const locked = await runner.execute<{
      run_status: string;
      doc_status: string;
      document_number: string | null;
      paid_at: string | null;
      paid_entry_id: string | null;
      has_lines: boolean;
    }>(
      sql`
      select r.run_status, d.status as doc_status, d.document_number,
             r.paid_at::text as paid_at, r.paid_entry_id::text as paid_entry_id,
             exists (select 1 from document_lines l
                      where l.org_id = ${orgId} and l.document_id = r.document_id) as has_lines
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${candidate.document_id}
       for update of r, d`,
      "objects",
    );
    const run = locked[0];
    if (!run) {
      untouched += 1;
      skipped.push({
        documentId: candidate.document_id,
        documentNumber: null,
        reason: "the pay run disappeared while its schedule was being re-scoped — left untouched",
      });
      continue;
    }
    const discardable =
      (run.run_status === "draft" || run.run_status === "calculated") &&
      run.doc_status === "draft" &&
      !run.has_lines &&
      !run.paid_at &&
      !run.paid_entry_id;
    if (!discardable) {
      untouched += 1;
      // A run that stopped being discardable after the snapshot is not an
      // error — history stays frozen — but it must be reported BY NAME, or
      // the operator believes the whole schedule followed.
      const number = run.document_number ?? candidate.document_id;
      const why =
        run.run_status === "committed"
          ? "it committed"
          : run.has_lines
            ? "it has general-ledger lines"
            : run.paid_at || run.paid_entry_id
              ? "it is paid"
              : `its document is ${run.doc_status}`;
      skipped.push({
        documentId: candidate.document_id,
        documentNumber: run.document_number,
        reason: `pay run ${number} was left on its frozen entity: ${why} while its schedule was being re-scoped`,
      });
      continue;
    }
    await reresolveRunToSubsidiary(runner, {
      orgId,
      actorId,
      documentId: candidate.document_id,
      subsidiaryId: schedule.subsidiary_id,
    });
    reresolved += 1;
  }
  return { reresolved, untouched, skipped };
}
