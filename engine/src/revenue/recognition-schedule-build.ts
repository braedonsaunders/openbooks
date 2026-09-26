/** Schedule persistence: locks, progress, legacy rebuild, build paths. Split from revenue/recognition.ts (pure moves only). */
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { defaultPostingSubsidiaryId, loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { isLegacyProvenance } from "../platform/legacy-provenance.ts";
import { type CreditExposure } from "./deferred-credit-pool.ts";
import { add, fromUnits, isZero, mulPercent, neg, roundDiv, sum, toUnits } from "../money/money.ts";
import { RevenueRecognitionError } from "./recognition-transaction-price.ts";
import { computeRecognitionSchedule, pctOf, type RecognitionMethod } from "./recognition-schedule.ts";

// ---------------------------------------------------------------------------
// Persist a schedule (plan → recognition_schedules + lines)
// ---------------------------------------------------------------------------

/** All plan writers and posting take the contract mutex before row locks.
 * This serializes multi-obligation amendments without an obligation/contract
 * lock inversion. The key is tenant-qualified; no organization-wide lock. */
export async function lockRevenueContract(runner:SqlExecutor,orgId:string,contractId:string):Promise<void> {
  await runner.execute(sql`select pg_advisory_xact_lock(hashtext(${orgId}),hashtext(${`revenue-contract:${contractId}`}))`);
}
export async function lockObligationContract(runner:SqlExecutor,orgId:string,obligationId:string):Promise<void> {
  const row=(await runner.execute<{contract_id:string}>(sql`select contract_id from performance_obligations where org_id=${orgId} and id=${obligationId}`)).rows[0];
  if(row)await lockRevenueContract(runner,orgId,row.contract_id);
}

/** Primary accounting book id (schedules are book-aware): the shared active
 * posting primary, so planning reads the same book the run posts to — never
 * a deactivated primary. */
async function primaryBookId(runner: SqlExecutor, orgId: string): Promise<string> {
  const id = await activePostingPrimaryBookId(orgId, runner);
  if (!id) throw new Error("no primary accounting book");
  return id;
}

/** Resolve the (non-adjustment) accounting period covering a date, or null. */
async function periodForDate(runner: SqlExecutor, orgId: string, date: string): Promise<string | null> {
  // Through the shared covering-period resolver: the default calendar wins
  // and overlaps resolve deterministically, instead of whichever row the
  // database happens to return first.
  return (await resolveCoveringPeriod(runner, orgId, date))?.id ?? null;
}

export interface RevenueChangeBasis {
  changeId: string; effectiveOn: string; treatment: 'separate'|'prospective'|'catch_up';
  totalAmount: string; remaining: string; targetRecognized: string; progressAtChange: string;
  creditBaseline: string; creditExposure?: CreditExposure; excludedEventIds: string[]; retired: boolean;
  deferredAccountId: string; recognizedAccountId: string; currency: string; fxRate: string; functionalCurrency:string; method:RecognitionMethod;
}

export function recognitionProgressTarget(total:string,percent:string,basis?:RevenueChangeBasis|null):string {
  pctOf(0n,percent);
  if(!basis || basis.treatment!=='prospective')return mulPercent(total,percent,4);
  const progress=toUnits(percent),baseline=toUnits(basis.progressAtChange);
  if(progress<baseline)throw new RevenueRecognitionError('progress is below the performance retained by the prospective amendment; propose a cumulative catch-up assessment before revising previously earned revenue');
  const denominator=toUnits('100')-baseline;
  const earned=denominator===0n?toUnits(basis.remaining):roundDiv(toUnits(basis.remaining)*(progress-baseline),denominator);
  return fromUnits(toUnits(basis.targetRecognized)+earned);
}

export interface BuildRecognitionResult {
  scheduleId: string;
  lineCount: number;
  /** Period months the rebuild placed no line for: already-posted periods
   * keep their postings, and zero-planned catch-up/event months carry
   * nothing. A month with no accounting period is a refusal, never a skip. */
  skippedMonths: string[];
}

/**
 * A legacy-provenance rebuild block: the obligation pins a rule whose
 * pre-upgrade history is unverified (0326), it was never reconciled (0328),
 * and it already carries schedule lines that a rebuild would destroy or
 * extend under a policy the obligation may not have been built under.
 */
export interface LegacyRebuildBlock {
  ruleId: string;
  lineCount: number;
  message: string;
}

function legacyRebuildRemedy(obligationId: string): string {
  return (
    `verify the existing schedule against the policy in force when the obligation was created, ` +
    `then reconcile the obligation with a reason via reconcileLegacyObligationProvenance ` +
    `(POST /api/revenue/obligations/${obligationId}/reconcile-legacy); the rebuild proceeds once reconciled`
  );
}

/**
 * Null when a rebuild may proceed; a block naming the remedy otherwise.
 * Shared by buildRecognitionScheduleOn (which refuses) and the project
 * revenue sync (which skips the project with a named problem instead of
 * aborting every other project), so the two predicates cannot drift.
 */
export async function legacyRebuildBlock(
  runner: SqlExecutor,
  orgId: string,
  obligationId: string,
): Promise<LegacyRebuildBlock | null> {
  const o = (await runner.execute<{
    recognition_rule_id: string;
    rule_version: number | null;
    rule_superseded_by: string | null;
    reconciled_at: string | null;
  }>(sql`
    select o.recognition_rule_id, r.version as rule_version,
           r.superseded_by as rule_superseded_by,
           o.legacy_reconciled_at::text as reconciled_at
      from performance_obligations o
      join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
     where o.id = ${obligationId} and o.org_id = ${orgId}`)).rows[0];
  if (!o) throw new Error("obligation not found");
  if (o.reconciled_at) return null;
  const legacy = await isLegacyProvenance(runner, orgId, "recognition_rules", o.recognition_rule_id, {
    // Before 0326 applies there is no registry: an unsurpassed version 1 is
    // exactly what the backfill stamps, so it stays suspect.
    fallback: o.rule_version === 1 && o.rule_superseded_by == null,
  });
  if (!legacy) return null;
  const lines = (await runner.execute<{ n: string }>(sql`
    select count(*)::text as n
      from recognition_schedule_lines l
      join recognition_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
     where s.obligation_id = ${obligationId} and s.org_id = ${orgId}`)).rows[0];
  const lineCount = Number(lines?.n ?? "0");
  if (lineCount === 0) return null;
  return {
    ruleId: o.recognition_rule_id,
    lineCount,
    message:
      `obligation ${obligationId} pins recognition rule ${o.recognition_rule_id}, whose pre-upgrade history is ` +
      `legacy-unverified (0297): rebuilding would re-time its ${lineCount} existing schedule line(s) under a ` +
      `policy the obligation may not have been built under. ${legacyRebuildRemedy(obligationId)}`,
  };
}

export interface ObligationAttribution {
  reconciledAt: string | null;
  subsidiaryId: string | null;
}

/**
 * An obligation's entity for scope decisions: its contract's subsidiary,
 * falling back through the source line, source document and project to the
 * posting fallback root. The subsidiary leg mirrors
 * recognitionObligationScope exactly, so reconcile, preview-by-id and the
 * run/postings agree on which entity an obligation belongs to. Null when the
 * obligation is missing or cross-org. Pass forUpdate inside a writer's
 * transaction to hold the obligation row while the caller asserts scope.
 */
export async function obligationAttribution(
  runner: SqlExecutor,
  orgId: string,
  obligationId: string,
  forUpdate = false,
): Promise<ObligationAttribution | null> {
  const fallbackSubsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(runner, orgId));
  const lock = forUpdate ? sql` for update of o` : sql``;
  const row = (await runner.execute<{ reconciled_at: string | null; subsidiary_id: string | null }>(sql`
    select o.legacy_reconciled_at::text as reconciled_at,
           coalesce(c.subsidiary_id, dl.subsidiary_id, doc.subsidiary_id, prj.subsidiary_id, ${fallbackSubsidiaryId}) as subsidiary_id
      from performance_obligations o
      join revenue_contracts c on c.id = o.contract_id and c.org_id = o.org_id
      left join document_lines dl on dl.id = o.document_line_id and dl.org_id = o.org_id
      left join documents doc on doc.id = dl.document_id and doc.org_id = dl.org_id
      left join projects prj on prj.id = c.project_id and prj.org_id = c.org_id
     where o.id = ${obligationId} and o.org_id = ${orgId}${lock}`)).rows[0];
  return row ? { reconciledAt: row.reconciled_at, subsidiaryId: row.subsidiary_id } : null;
}

/**
 * A bare contract's entity for scope decisions: its own subsidiary, falling
 * back through its project to the posting fallback root. Null when the
 * contract is missing or cross-org.
 */
export async function revenueContractAttribution(
  runner: SqlExecutor,
  orgId: string,
  contractId: string,
): Promise<{ subsidiaryId: string | null } | null> {
  const fallbackSubsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(runner, orgId));
  const row = (await runner.execute<{ subsidiary_id: string | null }>(sql`
    select coalesce(c.subsidiary_id, prj.subsidiary_id, ${fallbackSubsidiaryId}) as subsidiary_id
      from revenue_contracts c
      left join projects prj on prj.id = c.project_id and prj.org_id = c.org_id
     where c.id = ${contractId} and c.org_id = ${orgId}`)).rows[0];
  return row ? { subsidiaryId: row.subsidiary_id } : null;
}

/**
 * Record the operator's attestation that an obligation's existing schedule
 * matches the policy actually in force at its creation, lifting the
 * legacy-rebuild refusal for that obligation only (0328). Reconciliation is
 * per obligation because one legacy rule can pin obligations built under
 * different policies — clearing the rule would re-open the still-wrong one.
 *
 * Attesting is a cross-subsidiary write: the caller's scope is REQUIRED
 * (null is the explicit unrestricted sentinel) and is asserted against the
 * obligation's entity under the obligation lock, so a concurrent rehome
 * cannot move the attestation onto another entity's obligation. A denied
 * obligation answers exactly like a missing one.
 */
export async function reconcileLegacyObligationProvenance(
  runner: SqlExecutor,
  orgId: string,
  obligationId: string,
  actorId: string | null,
  reason: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<void> {
  const clean = reason.trim();
  if (clean.length < 5 || clean.length > 500) {
    throw new RevenueRecognitionError(
      "a reconciliation reason of 5 to 500 characters is required — name the evidence the existing schedule was verified against",
    );
  }
  await lockObligationContract(runner, orgId, obligationId);
  const o = await obligationAttribution(runner, orgId, obligationId, true);
  if (!o || !subsidiaryScopeAllows(allowedSubsidiaryIds, o.subsidiaryId)) throw new ScopeNotFoundError();
  const reconciledAt = o.reconciledAt;
  if (reconciledAt) {
    throw new RevenueRecognitionError("this obligation is already reconciled — its rebuild refusal is lifted");
  }
  const block = await legacyRebuildBlock(runner, orgId, obligationId);
  if (!block) {
    throw new RevenueRecognitionError(
      "nothing to reconcile: the pinned rule is not legacy-unverified, or there is no schedule evidence to verify against",
    );
  }
  // A write that matches zero rows is a failure, not a success.
  const updated = (await runner.execute<{ id: string }>(sql`
    update performance_obligations
       set legacy_reconciled_at = now(), legacy_reconciled_by = ${actorId},
           legacy_reconciliation_reason = ${clean},
           updated_at = now(), updated_by = coalesce(${actorId}, updated_by)
     where id = ${obligationId} and org_id = ${orgId}
     returning id`)).rows;
  if (updated.length !== 1) throw new Error("the reconciliation could not be recorded");
}

/**
 * (Re)build the recognition schedule for an obligation on a book from its rule
 * and resolved term. Existing UNPOSTED lines are replaced; posted lines are
 * preserved so a rebuild after some periods have recognized never disturbs
 * history. Returns the schedule id and how many lines it planned.
 *
 * percent_complete: the cumulative target is credited for what the schedule
 * has already POSTED, and the catch-up delta is planned prospectively in the
 * `asOfDate` month (a percent change is a change in estimate — ASC 250 —
 * recognized in the current period, never restated to the contract start).
 */
export async function buildRecognitionScheduleOn(
  runner: SqlExecutor,
  obligationId: string,
  orgId: string,
  actorId: string | null,
  bookId: string,
  asOfDate?: string,
): Promise<BuildRecognitionResult> {
  await lockObligationContract(runner,orgId,obligationId);
  const oblRes = (await runner.execute<{
      id: string;
      allocated_price: string;
      status: string;
      recognition_starts_on: string | null;
      recognition_ends_on: string | null;
      percent_complete: string | null;
      contract_starts: string | null;
      contract_ends: string | null;
      method: RecognitionMethod;
      recognition_periods: number | null;
      period_offset: number;
      start_offset_days: number;
      initial_amount_percent: string;
      start_date_source: string;
      end_date_source: string;
    }>(sql`
    select o.id, o.allocated_price, o.status, o.recognition_starts_on, o.recognition_ends_on,
           o.percent_complete, c.starts_on as contract_starts, c.ends_on as contract_ends,
           r.method, r.recognition_periods, r.period_offset, r.start_offset_days,
           r.initial_amount_percent, r.start_date_source, r.end_date_source
      from performance_obligations o
      join revenue_contracts c on c.id = o.contract_id and c.org_id = o.org_id
      join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
     where o.id = ${obligationId} and o.org_id = ${orgId}
     for update of o`));
  const o = oblRes.rows[0];
  if (!o) throw new Error("obligation not found");
  if (o.status === "cancelled") throw new RevenueRecognitionError("cancelled obligations cannot be rebuilt");

  // Historical deferral rate (0256): the invoice's own rate, immutable once
  // posted, so recognition drains deferred revenue at the rate it was
  // credited at. Document-less (project) obligations measure in the
  // contract currency at par.
  const txMoney = (await runner.execute<{ tx_currency: string | null; tx_fx_rate: string | null }>(sql`
    select coalesce(d.currency, c.currency) as tx_currency,
           coalesce(d.fx_rate, 1)::text as tx_fx_rate
      from performance_obligations o
      join revenue_contracts c on c.id = o.contract_id and c.org_id = o.org_id
      left join document_lines dl on dl.id = o.document_line_id and dl.org_id = o.org_id
      left join documents d on d.id = dl.document_id and d.org_id = dl.org_id
     where o.id = ${obligationId} and o.org_id = ${orgId}`)).rows[0];
  const txCurrency = txMoney?.tx_currency ?? undefined;
  const txFxRate = txMoney?.tx_fx_rate ?? "1";

  const startOn = o.recognition_starts_on ?? o.contract_starts;
  if (!startOn) throw new Error("obligation has no recognition start date");
  const endOn = o.recognition_ends_on ?? (o.end_date_source === "contract" ? o.contract_ends : null);

  const existing = (await runner.execute<{ id: string; revision: number; change_basis: RevenueChangeBasis | null }>(sql`
    select id,revision,change_basis from recognition_schedules
     where obligation_id = ${obligationId} and org_id = ${orgId} and book_id = ${bookId} limit 1`));
  const basis = existing.rows[0]?.change_basis;
  const method = basis?.method ?? o.method;
  const isPercentComplete = method === "percent_complete";
  const revision = existing.rows[0]?.revision ?? 1;
  const scheduleTotal = basis?.totalAmount ?? o.allocated_price;
  if (basis?.retired) return {scheduleId:existing.rows[0]!.id,lineCount:0,skippedMonths:[]};
  // Legacy provenance (0326/0328): a pre-versioning rule edited in place
  // cannot be trusted to re-time this obligation's existing lines. Refuse
  // before any line is destroyed; the remedy is a per-obligation
  // reconciliation, never a silent rebuild.
  const block = await legacyRebuildBlock(runner, orgId, obligationId);
  if (block) throw new RevenueRecognitionError(block.message);
  let scheduleId: string;
  if (existing.rows[0]) {
    scheduleId = existing.rows[0].id;
    await runner.execute(sql`
      update recognition_schedules
         set total_amount = ${scheduleTotal},
             transaction_currency = coalesce(transaction_currency, ${txCurrency ?? null}),
             transaction_fx_rate = coalesce(transaction_fx_rate, ${txFxRate}),
             updated_at = now(), updated_by = ${actorId}
       where id = ${scheduleId} and org_id = ${orgId}`);
    } else {
      // Concurrent replays may race on the (obligation, book) identity; lose
      // deterministically to the winner and adopt its row instead of failing.
      const ins = (await runner.execute<{ id: string }>(sql`
        insert into recognition_schedules (org_id, obligation_id, book_id, total_amount, transaction_currency, transaction_fx_rate, created_by, updated_by)
        values (${orgId}, ${obligationId}, ${bookId}, ${o.allocated_price}, ${txCurrency ?? null}, ${txFxRate}, ${actorId}, ${actorId})
        on conflict do nothing
        returning id`));
      scheduleId =
        ins.rows[0]?.id ??
        (await runner.execute<{ id: string }>(sql`
          select id from recognition_schedules
           where obligation_id = ${obligationId} and org_id = ${orgId} and book_id = ${bookId} limit 1`)).rows[0]!.id;
    }

  const posted = (await runner.execute<{ period_id: string; planned_amount: string; sequence: number; revision: number; modification_adjustment: boolean }>(sql`
    select period_id, case when reversal_journal_entry_id is null then coalesce(recognized_amount,0) else 0 end::text as planned_amount, sequence, revision, modification_adjustment from recognition_schedule_lines
     where org_id = ${orgId} and schedule_id = ${scheduleId} and journal_entry_id is not null`));
  const currentPosted = basis ? posted.rows.filter(r=>r.revision === revision && !r.modification_adjustment) : posted.rows;
  const postedPeriods = new Set(currentPosted.map((r) => r.period_id));
  const postedByPeriod = new Map<string, string>();
  for (const row of currentPosted) {
    postedByPeriod.set(row.period_id, add(postedByPeriod.get(row.period_id) ?? "0", row.planned_amount));
  }
  const postedToDate = sum(posted.rows.map((r) => r.planned_amount));
  const nextSequence = posted.rows.reduce((a, r) => Math.max(a, r.sequence + 1), 0);

  // Milestone and usage methods recognize from recorded events rather than
  // a term. Load the obligation's persisted events so computeRecognitionSchedule
  // produces period targets that can be compared with posted recognition.
  const isMilestoneOrUsage = method === "milestone" || method === "usage";
  let events: { periodMonth: string; amount: string }[] | undefined;
  if (isMilestoneOrUsage) {
    const eventRes = (await runner.execute<{ period_month: string; amount: string }>(sql`
      select period_month, amount from recognition_events
       where org_id = ${orgId} and obligation_id = ${obligationId}
       ${basis ? sql`and id not in (select jsonb_array_elements_text(${JSON.stringify(basis.excludedEventIds)}::jsonb)::uuid)` : sql``}
       order by period_month`));
    events = eventRes.rows.map((e) => ({ periodMonth: e.period_month, amount: e.amount }));
  }

  // Percent-complete: the catch-up delta lands in the as-of month (clamped to
  // the term start), credited for everything this schedule already posted.
  const plan = computeRecognitionSchedule({
    total: basis && !isPercentComplete ? basis.remaining : scheduleTotal,
    method,
    startOn: isPercentComplete && asOfDate && asOfDate > (basis?.effectiveOn ?? startOn) ? asOfDate : (basis?.effectiveOn ?? startOn),
    endOn,
    termPeriods: o.recognition_periods,
    startOffsetDays: basis ? 0 : o.start_offset_days,
    initialAmountPercent: basis ? '0' : o.initial_amount_percent,
    periodOffset: basis ? 0 : o.period_offset,
    percentComplete: o.percent_complete,
    alreadyRecognized: isPercentComplete ? postedToDate : null,
    events,
  });

  // For a prospective series, progress is measured over the remaining service,
  // not reapplied to revenue earned under the previous version.
  if (basis?.treatment === 'prospective' && isPercentComplete && plan[0]) {
    plan[0].planned=add(recognitionProgressTarget(scheduleTotal,o.percent_complete??'0',basis),neg(postedToDate));
  }
  await runner.execute(sql`
    delete from recognition_schedule_lines where org_id = ${orgId} and schedule_id = ${scheduleId}
     and journal_entry_id is null and superseded_by_change_id is null and not modification_adjustment`);

  // Events are immutable evidence; a period can receive more events after its
  // first posting. Plan the period's current total less its posted amount as
  // an additional line, preserving every prior posting and its sequence.
  const periodPlans: { periodId: string; periodMonth: string; planned: string; sequence: number }[] = [];
  const eventPlans = new Map<string, (typeof periodPlans)[number]>();
  const periodIds = new Map<string, string>();
  for (const p of plan) {
    const periodId = periodIds.get(p.periodMonth) ?? await periodForDate(runner, orgId, p.periodMonth);
    if (!periodId) {
      throw new RevenueRecognitionError(
        `no accounting period covers ${p.periodMonth} — provision all periods spanning the recognition term before building a schedule`,
      );
    }
    periodIds.set(p.periodMonth, periodId);
    if (isMilestoneOrUsage) {
      const prior = eventPlans.get(periodId);
      if (prior) prior.planned = add(prior.planned, p.planned);
      else {
        const pending = { periodId, periodMonth: p.periodMonth, planned: p.planned, sequence: p.sequence };
        periodPlans.push(pending);
        eventPlans.set(periodId, pending);
      }
    } else {
      periodPlans.push({ periodId, periodMonth: p.periodMonth, planned: p.planned, sequence: p.sequence });
    }
  }

  // Months the builder actually skips: already-posted periods keep their
  // lines (rebuilding never duplicates a posting), and zero-planned
  // catch-up/event months carry nothing to place. Returned alongside the
  // schedule so callers can name the gap instead of silently planning
  // nothing — the depreciation builder's skippedMonths contract.
  const skippedMonths: string[] = [];
  let lineCount = 0;
  for (const p of periodPlans) {
    const { periodId } = p;
    if (!isPercentComplete && !isMilestoneOrUsage && postedPeriods.has(periodId)) {
      skippedMonths.push(p.periodMonth);
      continue;
    }
    const planned = isMilestoneOrUsage
      ? add(p.planned, neg(postedByPeriod.get(periodId) ?? "0"))
      : p.planned;
    if ((isPercentComplete || isMilestoneOrUsage) && isZero(planned)) {
      skippedMonths.push(p.periodMonth);
      continue;
    }
    const sequence = basis || isPercentComplete || isMilestoneOrUsage ? nextSequence + lineCount : p.sequence;
    await runner.execute(sql`
      insert into recognition_schedule_lines
        (org_id, schedule_id, period_id, sequence, planned_amount, revision, created_by, updated_by)
      values (${orgId}, ${scheduleId}, ${periodId}, ${sequence}, ${planned}, ${revision}, ${actorId}, ${actorId})`);
    lineCount++;
  }
  if (lineCount > 0) {
    await runner.execute(sql`
      update recognition_schedules set status = ${posted.rows.length ? "in_progress" : "planned"},
        updated_at = now(), updated_by = ${actorId} where id = ${scheduleId} and org_id = ${orgId}`);
    await runner.execute(sql`
      update performance_obligations set status = 'open', updated_at = now(), updated_by = ${actorId}
       where id = ${obligationId} and org_id = ${orgId} and status = 'satisfied'`);
  }
  return { scheduleId, lineCount, skippedMonths };
}

/**
 * Build one obligation's recognition schedule on a book in its own transaction.
 * Callers that must keep obligations and their schedules atomic (the invoice
 * posting effect) use `buildRecognitionScheduleOn` on their transaction instead.
 */
export async function buildRecognitionSchedule(
  obligationId: string,
  orgId: string,
  actorId: string | null,
  forBookId?: string,
  asOfDate?: string,
): Promise<BuildRecognitionResult> {
  const bookId = forBookId ?? (await primaryBookId(db, orgId));
  return await db.transaction(async (tx) =>
    buildRecognitionScheduleOn(tx, obligationId, orgId, actorId, bookId, asOfDate));
}

/** Build the recognition schedule on every GL-posting book (multi-book). */
export async function buildAllRecognitionSchedulesOn(
  runner: SqlExecutor,
  obligationId: string,
  orgId: string,
  actorId: string | null,
  asOfDate?: string,
): Promise<BuildRecognitionResult[]> {
  const books = (await runner.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_active and posts_gl
     order by is_primary desc, code`));
  const results: BuildRecognitionResult[] = [];
  for (const b of books.rows) {
    results.push(await buildRecognitionScheduleOn(runner, obligationId, orgId, actorId, b.id, asOfDate));
  }
  return results;
}

/** Build the recognition schedule on every GL-posting book (multi-book). */
export async function buildAllRecognitionSchedules(
  obligationId: string,
  orgId: string,
  actorId: string | null,
  asOfDate?: string,
): Promise<BuildRecognitionResult[]> {
  return db.transaction(tx => buildAllRecognitionSchedulesOn(tx, obligationId, orgId, actorId, asOfDate));
}

/**
 * Build every active GL-posting book's schedule inside one caller-supplied
 * transaction (`tx`). The multi-book percent-complete sync must be atomic:
 * a failure after the first book leaves no book changed.
 */
export async function buildAllRecognitionSchedulesInTransaction(
  tx: SqlExecutor,
  obligationId: string,
  orgId: string,
  actorId: string | null,
  asOfDate?: string,
): Promise<BuildRecognitionResult[]> {
  return buildAllRecognitionSchedulesOn(tx, obligationId, orgId, actorId, asOfDate);
}
