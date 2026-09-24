/**
 * Pay-run period lifecycle: create, discard, and subsidiary re-scoping.
 *
 * Extracted verbatim from engine/src/payroll/run.ts; bodies preserve exact
 * math, transaction/lock sequencing, and refusal identity.
 */
import { payrollSubsidiaryInScope, type PayrollSubsidiaryScope } from "./scope.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "../records/transaction-audit.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { resolvePayrollRunContext } from "./packs.ts";
import { businessToday, isIsoCalendarDate } from "../platform/business-date.ts";
import { type ScheduleRow, DAY, iso, at, nextPeriodAfter } from "./run-calendar.ts";
import { type PayRunType } from "./run-contracts.ts";
import { isUuid } from "../platform/uuid.ts";

const RUN_TYPE_MEMO: Record<PayRunType, string> = {
  regular: "Pay run",
  bonus: "Off-cycle bonus run",
  termination: "Final pay run",
  retro: "Retroactive pay run",
};

/** Run types that must NAME the employees they pay before they can exist. */
const SCOPED_RUN_TYPES = new Set<string>(["termination", "retro"]);

/**
 * The roster a run pays, as the caller names it.
 *
 * REQUIRED on a termination run. A final pay run pays out and ZEROES every
 * accrued bank, so an unscoped one does that to the whole schedule: one person
 * quits, the operator opens a final-pay run, and every other employee receives
 * a second full period of salary and has their vacation bank drained. The
 * scope is persisted as `pay_run_adjustments` exclusion rows for everyone
 * else, which is the scope machinery the run already has.
 */
export async function createPayRun(input: {
  orgId: string; actorId: string; payScheduleId: string;
  periodStart?: string; periodEnd?: string; payDate?: string;
  /** Regular follows the schedule; bonus/termination are off-cycle. */
  runType?: PayRunType;
  /** Employees this run pays; required for `termination`, ignored otherwise. */
  employeePartyIds?: readonly string[];
  /** Caller role scope; null/undefined is unrestricted. */
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}): Promise<{ documentId: string; documentNumber: string }> {
  const { orgId, actorId } = input;
  for (const key of ["periodStart", "periodEnd", "payDate"] as const) {
    if (input[key] != null && !isIsoCalendarDate(input[key])) {
      throw new PayrollError(`invalid ${key} (YYYY-MM-DD calendar date required)`);
    }
  }
  // Derive a schedule period only when BOTH endpoints were omitted. Never
  // discard an explicit date and silently pay a different period.
  if ((input.periodStart != null) !== (input.periodEnd != null)) {
    throw new PayrollError("periodStart and periodEnd must be supplied together");
  }
  if (input.periodStart && input.periodEnd && input.periodEnd < input.periodStart) {
    throw new PayrollError("periodEnd must not precede periodStart");
  }
  return await db.transaction(async (tx) => {
    if (!(await lockAndCheckOrgFeature(tx, orgId, "payroll"))) throw new PayrollError("Payroll feature is disabled");
    const s = (await tx.execute<(ScheduleRow & { subsidiary_id: string | null })>(sql`
      select id, frequency, periods_per_year, anchor_period_end, pay_date_offset_days, subsidiary_id
        from pay_schedules where org_id = ${orgId} and id = ${input.payScheduleId} and is_active
    `));
    const schedule = s.rows[0];
    if (!schedule) throw new PayrollError("pay schedule not found");

    let periodStart = input.periodStart;
    let periodEnd = input.periodEnd;
    if (!periodStart || !periodEnd) {
      // Regular-cycle scheduling anchors on the REGULAR schedule only: an
      // off-cycle bonus, retro or final-pay run landing mid-span must not drag
      // max(period_end) forward, or the next regular run silently skips the
      // period the off-cycle run interrupted.
      const last = (await tx.execute<{ last_end: string | null }>(sql`
        select max(period_end) as last_end from pay_runs
         where org_id = ${orgId} and pay_schedule_id = ${schedule.id}
           and run_type = 'regular'
      `));
      const next = nextPeriodAfter(schedule, last.rows[0]?.last_end ?? null);
      periodStart = next.periodStart;
      periodEnd = next.periodEnd;
    }
    const payDate = input.payDate ??
      iso(new Date(at(periodEnd).getTime() + schedule.pay_date_offset_days * DAY));
    if (!isIsoCalendarDate(periodStart) || !isIsoCalendarDate(periodEnd)
        || !isIsoCalendarDate(payDate)) {
      throw new PayrollError("pay schedule produced a date outside the supported calendar");
    }
    if (payDate < periodEnd) throw new PayrollError("payDate must not precede periodEnd");

    // Scoped schedules pin the run to their legal entity (and its currency);
    // org-wide schedules keep the historical root-subsidiary behaviour.
    //
    // Resolved BEFORE the tax year, because the tax year is the country pack's
    // answer and the country is the entity's. `Number(payDate.slice(0, 4))`
    // was the calendar year of the pay date — right for the CRA and the IRS,
    // wrong for any jurisdiction whose statutory year is not the calendar one,
    // and silently so: every YTD accumulator and every year-end slip keys on
    // `tax_year`.
    const sub = (await tx.execute<{ id: string; name: string; country: string | null; currency_code: string | null }>(schedule.subsidiary_id
      ? sql`
        select s.id, s.name, s.country, s.base_currency as currency_code from subsidiaries s
         where s.org_id = ${orgId} and s.id = ${schedule.subsidiary_id} and s.is_active`
      : sql`
        select s.id, s.name, s.country, s.base_currency as currency_code from subsidiaries s
         where s.org_id = ${orgId} and s.parent_id is null and s.is_active
         order by s.created_at limit 1
    `));
    const subsidiary = sub.rows[0];
    if (!subsidiary) {
      throw new PayrollError(schedule.subsidiary_id
        ? "the pay schedule's subsidiary is missing or inactive"
        : "no active root subsidiary");
    }
    if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, subsidiary.id)) {
      // Match the schedule lookup's not-found response and leave the
      // transaction untouched: an out-of-scope schedule must be opaque.
      throw new PayrollError("pay schedule not found");
    }
    const runContext = resolvePayrollRunContext({
      payDate,
      subsidiary: {
        id: subsidiary.id, name: subsidiary.name,
        country: subsidiary.country, baseCurrency: subsidiary.currency_code,
      },
    });
    const taxYear = runContext.taxYear;

    // Guard 1 — no REGULAR run may overlap another regular run on the same
    // schedule: two of them covering one period would pay (and remit) the
    // period twice. Off-cycle bonus and termination runs are exempt — landing
    // inside an already-paid period is exactly what they are for.
    const runType: PayRunType = input.runType ?? "regular";
    if (runType === "regular") {
      const overlap = (await tx.execute<{ document_number: string }>(sql`
        select d.document_number from pay_runs r
          join documents d on d.id = r.document_id and d.org_id = r.org_id
         where r.org_id = ${orgId} and r.pay_schedule_id = ${schedule.id}
           and r.run_type = 'regular'
           and r.period_start <= ${periodEnd} and r.period_end >= ${periodStart}
           -- 'voided', not 'void' — the documents status enum
           -- (schema/src/documents.ts). Matching the wrong spelling made a
           -- VOIDED regular run go on blocking its own replacement.
           and d.status <> 'voided'
         limit 1
      `));
      if (overlap.rows[0]) {
        throw new PayrollError(
          `pay run ${overlap.rows[0].document_number} already covers ${periodStart} to ${periodEnd}`,
        );
      }
    }

    // Guard 2 — a run cannot be opened for a period that has not begun.
    // Processing a few days before period END is normal payroll practice;
    // opening a period that starts in the future is not, and it would compute
    // statutory amounts from time that cannot exist yet.
    const today = await businessToday(orgId);
    if (periodStart > today) {
      throw new PayrollError(
        `pay period starts ${periodStart}, which has not begun yet`,
      );
    }

    // Guard 3 — a scoped run must NAME the employees it pays. Resolved before
    // anything is written so an unscoped one cannot exist at all. A final pay
    // run pays out and clears every accrued bank; a retro run settles named
    // differences for named people. Either one loosed on a whole schedule is
    // unrecoverable.
    const scopedEmployeeIds = [...new Set(input.employeePartyIds ?? [])];
    if (SCOPED_RUN_TYPES.has(runType)) {
      if (scopedEmployeeIds.length === 0) {
        throw new PayrollError(
          runType === "termination"
            ? "a final pay run must name the employees it pays — it pays out and clears "
              + "every accrued bank, so it may never run against the whole schedule"
            : "a retroactive pay run must name the employees it pays — it settles the "
              + "differences quantified for those people, so it may never run against "
              + "the whole schedule",
        );
      }
      const onSchedule = (await tx.execute<{ employee_party_id: string }>(sql`
        select prof.employee_party_id
          from employee_payroll_profiles prof
          join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
         where prof.org_id = ${orgId} and prof.pay_schedule_id = ${schedule.id} and prof.is_active
           and (${schedule.subsidiary_id}::uuid is null
                or p.subsidiary_id = ${schedule.subsidiary_id}::uuid)
      `));
      const roster = new Set(onSchedule.rows.map((row) => row.employee_party_id));
      const strangers = scopedEmployeeIds.filter((id) => !roster.has(id));
      if (strangers.length > 0) {
        throw new PayrollError(
          `${strangers.length} named employee(s) are not on this pay schedule`,
        );
      }
    }

    const seq = (await tx.execute<{ prefix: string; next_number: number; padding: number }>(sql`
      insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
      values (${orgId}, 'pay_run', null, 'PAY-')
      on conflict on constraint sequences_org_kind_sub
      do update set next_number = number_sequences.next_number + 1
      where number_sequences.org_id = ${orgId}
      returning prefix, next_number, padding
    `));
    const number = `${seq.rows[0]!.prefix}${String(seq.rows[0]!.next_number).padStart(seq.rows[0]!.padding, "0")}`;

    const doc = (await tx.execute<{ id: string }>(sql`
      insert into documents (org_id, kind, document_number, subsidiary_id, document_date,
                             currency, status, memo, created_by, updated_by)
      values (${orgId}, 'pay_run', ${number}, ${runContext.subsidiaryId}, ${payDate},
              ${runContext.currency}, 'draft',
              ${`${RUN_TYPE_MEMO[runType]} ${periodStart} – ${periodEnd}`}, ${actorId}, ${actorId})
      returning id
    `));
    const documentId = doc.rows[0]!.id;
    await tx.execute(sql`
      insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end,
                            pay_date, tax_year, run_type, created_by, updated_by)
      values (${documentId}, ${orgId}, ${schedule.id}, ${periodStart}, ${periodEnd},
              ${payDate}, ${taxYear}, ${runType}, ${actorId}, ${actorId})
    `);

    // The scope, written as exclusions for everyone the run does NOT pay —
    // the mechanism `calculatePayRun` already honours, and one the operator
    // can see and adjust in the wizard like any other run adjustment.
    if (SCOPED_RUN_TYPES.has(runType)) {
      await tx.execute(sql`
        insert into pay_run_adjustments (org_id, pay_run_document_id, employee_party_id,
                                         adjustment_type, note, created_by, updated_by)
        select ${orgId}, ${documentId}, prof.employee_party_id, 'exclude',
               'Not in the final pay run''s scope', ${actorId}, ${actorId}
          from employee_payroll_profiles prof
          join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
         where prof.org_id = ${orgId} and prof.pay_schedule_id = ${schedule.id} and prof.is_active
           and (${schedule.subsidiary_id}::uuid is null
                or p.subsidiary_id = ${schedule.subsidiary_id}::uuid)
           and prof.employee_party_id <> all(${`{${scopedEmployeeIds.join(",")}}`}::uuid[])
      `);
    }
    return { documentId, documentNumber: number };
  });
}

/**
 * The subsidiary a pay schedule pays for, as a refusal or null.
 *
 * A schedule with no subsidiary pays from the root entity (the historical
 * behaviour `createPayRun` keeps for single-entity tenants). In a tenant
 * running more than one legal entity that silence is the start of the
 * frozen-wrong-entity chain — a run created before the schedule is scoped
 * freezes the wrong paying entity and currency — so creation (and
 * re-scoping back to none) is refused there, naming what to choose.
 */
export async function payScheduleSubsidiaryProblem(
  orgId: string,
  subsidiaryId: string | null,
  runner: Pick<typeof db, "execute"> = db,
): Promise<string | null> {
  if (subsidiaryId) {
    const sub = (await runner.execute<{ id: string }>(sql`
      select id from subsidiaries
       where org_id = ${orgId} and id = ${subsidiaryId}
         and is_active and not is_elimination`));
    if (!sub.rows[0]) return "Choose an active subsidiary from this organization";
    return null;
  }
  const count = (await runner.execute<{ n: number }>(sql`
    select count(*)::int as n from subsidiaries
     where org_id = ${orgId} and is_active and not is_elimination`));
  if ((count.rows[0]?.n ?? 0) > 1) {
    return "Choose the subsidiary this schedule pays for — this organization runs more than "
      + "one legal entity, and a pay run freezes its paying entity and currency when it is "
      + "created, so a schedule with no subsidiary pays from the wrong entity";
  }
  return null;
}

/**
 * Discard a draft pay run.
 *
 * The boundary is accounting consequence, enforced here rather than in the
 * UI: only an UNCOMMITTED run on a draft document with no GL lines and no
 * payment may be discarded. A committed run is refused with the remedy (void
 * it to reverse the posted payroll); anything the document lifecycle has
 * moved past draft is refused too. Discarding deletes the run and its
 * calculation traces outright, so duplicate protection — which only ever
 * sees live runs — no longer blocks a correct replacement for the period.
 */
/**
 * Attribute a committed run that was committed with no subsidiary (legacy).
 *
 * History stays history: the run keeps its stubs, lines, totals and status —
 * only the document's subsidiary moves null → target. Posted books are never
 * rewritten: journal lines cannot carry a null tag (not-null since baseline),
 * so a posted run attributes only to the entity its books already name —
 * anything else refuses, and the operator voids and re-issues under the
 * right entity. Anything else that would rewrite meaning refuses too: an
 * already-attributed run (re-attribution would move live books between
 * entities), a non-committed run (drafts are edited, voided runs are gone),
 * and an inactive target.
 *
 * Evidence is the run document's own audit trail (before/after, actor,
 * reason), the same envelope controlled voids write. The target must sit in
 * the caller's scope; entityless runs are invisible to scoped roles at the
 * route boundary, so attribution is an org-wide act.
 */
export async function attributePayRunEntity(input: {
  orgId: string; documentId: string; actorId: string; subsidiaryId: string;
  /** Caller role scope; null/undefined is unrestricted. */
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}): Promise<{ documentNumber: string; reclassedLines: number }> {
  const { orgId, documentId, actorId, subsidiaryId } = input;
  if (!isUuid(subsidiaryId)) {
    throw new PayrollError("choose a subsidiary to attribute this run to");
  }
  if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, subsidiaryId)) {
    throw new PayrollError("pay run not found");
  }
  return await db.transaction(async (tx) => {
    if (!(await lockAndCheckOrgFeature(tx, orgId, "payroll"))) throw new PayrollError("Payroll feature is disabled");
    const runRows = (await tx.execute<{
      run_status: string; document_number: string; doc_status: string;
      doc_subsidiary_id: string | null;
    }>(sql`
      select r.run_status, d.document_number, d.status as doc_status,
             d.subsidiary_id as doc_subsidiary_id
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
       for update of r, d
    `));
    const run = runRows.rows[0];
    if (!run) throw new PayrollError("pay run not found");
    const number = run.document_number;
    if (run.run_status !== "committed") {
      throw new PayrollError(
        run.run_status === "voided"
          ? `pay run ${number} is voided and cannot be attributed`
          : `pay run ${number} is not committed — set its subsidiary by editing the draft`,
      );
    }
    if (run.doc_subsidiary_id !== null) {
      throw new PayrollError(
        `pay run ${number} is already attributed and cannot be re-attributed`,
      );
    }
    const target = (await tx.execute<{ id: string; name: string | null }>(sql`
      select id::text as id, name from subsidiaries
       where org_id = ${orgId} and id = ${subsidiaryId} and is_active
    `)).rows[0];
    if (!target) {
      throw new PayrollError("the subsidiary is missing or inactive — choose an active subsidiary");
    }
    // Posted books are never rewritten: the run's posted lines must all
    // already name the target (the entityless document posts into the root
    // by default, so attributing to the root is a header alignment, not a
    // move). Lines naming any other entity are live books elsewhere — void
    // the run and re-issue it under the right entity. No posted row is
    // written here, so the journal immutability guard is never engaged.
    const posted = (await tx.execute<{ subsidiary_id: string | null }>(sql`
      select l.subsidiary_id::text as subsidiary_id
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
       where l.org_id = ${orgId} and e.source_document_id = ${documentId}
         and e.status = 'posted'
       for update of l
    `));
    const foreign = posted.rows.filter((line) => line.subsidiary_id !== subsidiaryId);
    if (foreign.length > 0) {
      throw new PayrollError(
        `pay run ${number} already posts into another entity — void the run and re-issue it under the right entity`,
      );
    }
    const before = await captureTransactionAuditSnapshot(tx, documentId, orgId);
    if (!before) throw new PayrollError("pay run not found");
    await tx.execute(sql`
      update documents set subsidiary_id = ${subsidiaryId},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${documentId}`);
    const after = await captureTransactionAuditSnapshot(tx, documentId, orgId);
    await recordTransactionAudit(tx, {
      orgId, documentId, action: "update", actorId,
      source: "payroll_legacy_attribution",
      reason: `legacy attribution of a committed run with no subsidiary to ${target.name ?? subsidiaryId}`,
      before, after,
    });
    // No posted row moves: the header aligns to books that already name the
    // target (or to no books yet, for an unposted run). The count stays in
    // the contract so callers can assert nothing was rewritten.
    return { documentNumber: number, reclassedLines: 0 };
  });
}

export async function discardPayRun(input: {
  orgId: string; documentId: string; actorId: string;
  /** Caller role scope; null/undefined is unrestricted. */
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}): Promise<{ documentNumber: string }> {
  const { orgId, documentId, actorId } = input;
  return await db.transaction(async (tx) => {
    if (!(await lockAndCheckOrgFeature(tx, orgId, "payroll"))) throw new PayrollError("Payroll feature is disabled");
    const runRows = (await tx.execute<{
      run_status: string; paid_at: string | null; paid_entry_id: string | null;
      document_number: string; doc_status: string; doc_subsidiary_id: string | null;
      has_lines: boolean; has_links: boolean;
    }>(sql`
      select r.run_status, r.paid_at::text as paid_at, r.paid_entry_id::text as paid_entry_id,
             d.document_number, d.status as doc_status, d.subsidiary_id as doc_subsidiary_id,
             exists (select 1 from document_lines l
                      where l.org_id = ${orgId} and l.document_id = ${documentId}) as has_lines,
             exists (select 1 from document_links k
                      where k.org_id = ${orgId}
                        and (k.from_document_id = ${documentId} or k.to_document_id = ${documentId})) as has_links
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
       for update of r, d
    `));
    const run = runRows.rows[0];
    if (!run) throw new PayrollError("pay run not found");
    if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, run.doc_subsidiary_id)) {
      throw new PayrollError("pay run not found");
    }
    const number = run.document_number;
    if (run.run_status === "committed") {
      throw new PayrollError(
        `pay run ${number} is committed and cannot be discarded — void it to reverse the posted payroll`,
      );
    }
    if (run.doc_status !== "draft") {
      throw new PayrollError(
        `pay run ${number} is ${run.doc_status} and cannot be discarded — only a draft run can be discarded`,
      );
    }
    if (run.has_lines) {
      throw new PayrollError(
        `pay run ${number} already has general-ledger lines — void it to reverse them`,
      );
    }
    if (run.paid_at || run.paid_entry_id) {
      throw new PayrollError(
        `pay run ${number} is already paid and cannot be discarded — void it to reverse the payment`,
      );
    }
    if (run.has_links) {
      throw new PayrollError(
        `pay run ${number} is linked to other documents and cannot be discarded`,
      );
    }
    // Explicit deletes first: the ledger nulls its run link when the document
    // goes (ON DELETE SET NULL) and bank files restrict it — neither may
    // survive a discarded run. Deleting the document then cascades to the run,
    // its stubs and lines, its adjustments, and any retro/parallel traces.
    // The ledger guard permits these deletes while the run is uncommitted.
    await tx.execute(sql`
      delete from entitlement_ledger where org_id = ${orgId} and pay_run_document_id = ${documentId}`);
    await tx.execute(sql`
      delete from pay_run_bank_files where org_id = ${orgId} and pay_run_document_id = ${documentId}`);
    await tx.execute(sql`delete from documents where org_id = ${orgId} and id = ${documentId}`);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'documents', ${documentId}, 'delete',
              ${JSON.stringify({ operation: "discard_pay_run", documentNumber: number })}::jsonb,
              ${actorId})`);
    return { documentNumber: number };
  });
}

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
  await tx.execute(sql`
    delete from pay_stubs where org_id = ${orgId} and pay_run_document_id = ${documentId}`);
  await tx.execute(sql`
    update pay_runs
       set run_status = 'draft', gross_total = 0, net_total = 0,
           employer_cost_total = 0, employee_count = 0, calculated_at = null,
           calculation_errors = '[]'::jsonb, refusal_acknowledgement = null,
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
 * the new entity from scratch; operator adjustments are kept. The caller
 * decides the run is uncommitted — this helper asserts nothing about
 * lifecycle, it only re-stamps.
 */
export async function reresolveRunToSubsidiary(
  tx: Pick<typeof db, "execute">,
  input: { orgId: string; actorId: string; documentId: string; subsidiaryId: string },
): Promise<{ currency: string; taxYear: number }> {
  const { orgId, actorId, documentId, subsidiaryId } = input;
  const sub = (await tx.execute<{
    id: string; name: string; country: string | null; currency_code: string | null;
  }>(sql`
    select id, name, country, base_currency as currency_code from subsidiaries
     where org_id = ${orgId} and id = ${subsidiaryId} and is_active`));
  const subsidiary = sub.rows[0];
  if (!subsidiary) {
    throw new PayrollError(
      "the pay schedule is scoped to a subsidiary that is missing or inactive — choose an "
      + "active subsidiary on the pay schedule, or discard this run and open a new one",
    );
  }
  const runRow = (await tx.execute<{ pay_date: string; document_number: string }>(sql`
    select r.pay_date::text as pay_date, d.document_number
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${documentId}`));
  const run = runRow.rows[0];
  if (!run) throw new PayrollError("pay run not found");
  let runContext;
  try {
    runContext = resolvePayrollRunContext({
      payDate: run.pay_date,
      subsidiary: {
        id: subsidiary.id, name: subsidiary.name,
        country: subsidiary.country, baseCurrency: subsidiary.currency_code,
      },
    });
  } catch (error) {
    throw new PayrollError(
      `pay run ${run.document_number} cannot follow its schedule to ${subsidiary.name}: `
      + `${error instanceof Error ? error.message : String(error)} — fix the subsidiary, `
      + "then re-save the schedule",
    );
  }
  await tx.execute(sql`
    delete from entitlement_ledger where org_id = ${orgId} and pay_run_document_id = ${documentId}`);
  await tx.execute(sql`
    delete from pay_stubs where org_id = ${orgId} and pay_run_document_id = ${documentId}`);
  await tx.execute(sql`
    update documents set subsidiary_id = ${subsidiary.id}, currency = ${runContext.currency},
           updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and id = ${documentId}`);
  await tx.execute(sql`
    update pay_runs set tax_year = ${runContext.taxYear}, run_status = 'draft',
           gross_total = '0', net_total = '0', employer_cost_total = '0', employee_count = 0,
           calculated_at = null, calculation_source_snapshot = null,
           calculation_source_digest = null, updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and document_id = ${documentId}`);
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'pay_runs', ${documentId}, 'update',
            ${JSON.stringify({
              operation: "rescope_pay_run",
              subsidiaryId: subsidiary.id, currency: runContext.currency, taxYear: runContext.taxYear,
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
export async function rescopePayScheduleRuns(
  runner: Pick<typeof db, "execute">,
  input: { orgId: string; payScheduleId: string; actorId: string },
): Promise<{ reresolved: number; untouched: number }> {
  const { orgId, payScheduleId, actorId } = input;
  const s = (await runner.execute<{ subsidiary_id: string | null }>(sql`
    select subsidiary_id from pay_schedules where org_id = ${orgId} and id = ${payScheduleId}`));
  const schedule = s.rows[0];
  if (!schedule) throw new PayrollError("pay schedule not found");
  if (!schedule.subsidiary_id) return { reresolved: 0, untouched: 0 };
  const runs = (await runner.execute<{
    document_id: string; run_status: string; doc_status: string;
    paid_at: string | null; paid_entry_id: string | null; has_lines: boolean;
  }>(sql`
    select r.document_id::text as document_id, r.run_status,
           d.status as doc_status, r.paid_at::text as paid_at,
           r.paid_entry_id::text as paid_entry_id,
           exists (select 1 from document_lines l
                    where l.org_id = ${orgId} and l.document_id = r.document_id) as has_lines
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId} and r.pay_schedule_id = ${payScheduleId}`));
  let reresolved = 0;
  let untouched = 0;
  for (const run of runs.rows) {
    const discardable =
      (run.run_status === "draft" || run.run_status === "calculated")
      && run.doc_status === "draft"
      && !run.has_lines && !run.paid_at && !run.paid_entry_id;
    if (!discardable) {
      untouched += 1;
      continue;
    }
    await reresolveRunToSubsidiary(runner, {
      orgId, actorId, documentId: run.document_id, subsidiaryId: schedule.subsidiary_id,
    });
    reresolved += 1;
  }
  return { reresolved, untouched };
}
