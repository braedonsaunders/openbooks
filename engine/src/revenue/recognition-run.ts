/** Recognition run: due-period posting through the kernel. Split from revenue/recognition.ts (ARCH-FILE-SPLIT; pure moves only). */
import { sql } from "drizzle-orm";
import { db, withTransactionSavepoint } from "../platform/db.ts";
import { arePeriodModulesOpen } from "../periods/period-policy.ts";
import { postEntry } from "../journal/post-entry.ts";
import { defaultPostingSubsidiaryId, loadSubsidiaryContext, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";
import { add, cmp, isZero, mulRate, neg, sum } from "../money/money.ts";
import { recognitionDate } from "./recognition-dates.ts";
import { assertEnabled, recognitionBaseAmount, RevenueRecognitionError } from "./recognition-transaction-price.ts";
import { lockObligationContract } from "./recognition-schedule-build.ts";
import { previewRevenueRecognition, type RecognitionPreviewInput } from "./recognition-preview.ts";
import { recognitionNetRecognized, recognitionObligationScope, recognitionPostingRows, recognitionUnearnedRemaining } from "./recognition-posting-rows.ts";

// ---------------------------------------------------------------------------
// runRevenueRecognition — post due periods through the kernel
// ---------------------------------------------------------------------------

export interface RevenueRecognitionEntryIdentity {
  contractNumber: string;
  periodName: string;
  obligationId: string;
  bookId: string;
  sequence: number;
  lineId: string;
}

/**
 * Stable identity for one recognition journal in the organization-wide entry
 * number namespace. Full source ids are deliberate: one contract can carry
 * several obligations, every obligation can have a schedule on several books,
 * and percent-complete schedules can post several lines in one period.
 */
export function revenueRecognitionEntryNumber(
  identity: RevenueRecognitionEntryIdentity,
): string {
  return [
    "REV",
    identity.contractNumber,
    identity.periodName,
    identity.obligationId,
    identity.bookId,
    identity.sequence,
    identity.lineId,
  ].join("-");
}

export interface RunRecognitionResult {
  posted: number;
  skipped: number;
  totalAmount: string;
  entries: { contract: string; obligation: string; period: string; amount: string; entryId: string }[];
  problems: string[];
}
/**
 * A confirmed run whose reviewed set no longer matches live state. The route
 * maps this to 409 stale_preview — preview again, then confirm. Never a
 * partial post: this is raised before the first write.
 */
export class StaleRecognitionPreviewError extends Error {}

/**
 * The reviewed-run fence, in one place.
 *
 * When `confirm` is supplied, the exact reviewed set is re-derived and
 * compared BEFORE anything posts: a changed amount, account, period, entity
 * or membership aborts the whole run (StaleRecognitionPreviewError) with zero
 * writes, and only the reviewed lines are considered afterwards.
 *
 * It is a pre-flight fence, not one transaction: each line still posts in its
 * own transaction, so a failure part-way through leaves the lines already
 * posted (each individually balanced and linked to its plan). What it removes
 * is the silent case — posting something the operator never reviewed, or
 * skipping something they did.
 */

/**
 * Post every due, unposted recognition line whose period ends on or before
 * `asOfDate`. Each line becomes one balanced journal entry (DR deferred / CR
 * recognized) posted through the kernel, origin = 'revenue_recognition'. A
 * closed GL period is skipped (not an error). Idempotent: a line with a
 * journal_entry_id is never reconsidered. Every posting is capped at what
 * remains genuinely unearned for its obligation (F-w5-001): a fully-credited
 * obligation holds its plan lines (skipped with an explanatory problem), a
 * partially-credited one posts only the remainder.
 */
export async function runRevenueRecognition(
  orgId: string,
  asOfDate: string,
  actorId: string | null,
  obligationId?: string,
  allowedSubsidiaryIds?: string[],
  confirm?: { fingerprint: string; scope: RecognitionPreviewInput },
): Promise<RunRecognitionResult> {
  recognitionDate(asOfDate, "recognition as-of date");
  await assertEnabled(db, orgId);
  // Unattributed obligations default to the hierarchy root through the
  // shared resolver — never the oldest subsidiary.
  const fallbackSubsidiaryId = defaultPostingSubsidiaryId(await loadSubsidiaryContext(db, orgId));
  const obligationScope = recognitionObligationScope(orgId, allowedSubsidiaryIds, fallbackSubsidiaryId);

  const effectiveMethod=sql`coalesce((select s.change_basis->>'method' from recognition_schedules s join accounting_books b on b.id=s.book_id and b.org_id=s.org_id and b.is_primary and b.is_active and b.posts_gl where s.obligation_id=o.id and s.org_id=o.org_id limit 1),r.method)`;

  let confirmedLineIds: Set<string> | null = null;
  if (confirm) {
    const current = await previewRevenueRecognition(orgId, confirm.scope);
    if (current.fingerprint !== confirm.fingerprint) {
      throw new StaleRecognitionPreviewError(
        "the reviewed set changed; preview again before confirming",
      );
    }
    confirmedLineIds = new Set(
      current.rows.filter((row) => row.skipReason === null).map((row) => row.lineId),
    );
    if (confirmedLineIds.size === 0) return { posted: 0, skipped: 0, totalAmount: "0", entries: [], problems: [] };
  }

  const due = (await recognitionPostingRows(db, orgId, asOfDate, fallbackSubsidiaryId, obligationId, allowedSubsidiaryIds))
    .filter((row) => confirmedLineIds === null || confirmedLineIds.has(row.line_id));

  const result: RunRecognitionResult = { posted: 0, skipped: 0, totalAmount: "0", entries: [], problems: [] };

  for (const candidate of due) {
    try {
      const posted = await db.transaction(async (tx) => withTransactionSavepoint(tx, async () => {
        await lockObligationContract(tx,orgId,candidate.obligation_id);
        // Rebuilds, event writes and cancellation share this aggregate lock.
        // Nothing from the preliminary scan is a financial posting input.
        const obligation = await tx.execute<{ id: string }>(sql`
          select o.id from performance_obligations o
           where o.org_id = ${orgId} and o.id = ${candidate.obligation_id}
           for update of o`);
        if (!obligation.rows[0]) return { status: "already_posted" as const };
        await assertEnabled(tx, orgId);
        const row = (await recognitionPostingRows(
          tx, orgId, asOfDate, fallbackSubsidiaryId, candidate.obligation_id, allowedSubsidiaryIds,
          candidate.line_id, true,
        ))[0];
        if (!row) return { status: "already_posted" as const };
        // One period gate: the shared GL check replaces the raw
        // period_module_is_closed projection. Discovery stays advisory — a
        // closed line is skipped, not fatal — and source-owned imported
        // locks skip exactly like user locks.
        if (!(await arePeriodModulesOpen(tx, {
          orgId,
          periodId: row.period_id,
          bookId: row.book_id,
          subsidiaryIds: row.subsidiary_id ? [row.subsidiary_id] : [],
          modules: ["gl"],
        }))) return { status: "period_closed" as const };
        const planned = row.planned;
        if (isZero(planned)) {
          await tx.execute(sql`
            update recognition_schedule_lines set recognized_amount = '0',
                   updated_at = now(), updated_by = ${actorId}
             where id = ${row.line_id} and org_id = ${orgId} and journal_entry_id is null`);
          return { status: "zero" as const };
        }
        const deferredAccountId = row.obl_deferred ?? row.item_deferred ?? row.rule_deferred;
        const recognizedAccountId = row.obl_recognized ?? row.rule_recognized ?? row.item_income;
        if (!deferredAccountId || !recognizedAccountId) {
          return { status: "not_configured" as const, row };
        }
        // F-w5-001: a manual credit memo relieves deferred without touching
        // the plan. Never post more than what remains genuinely unearned; a
        // fully-credited obligation holds its plan lines, a partially-credited
        // one posts only the remainder (the final line may post partial).
        // A negative plan line is a same-period correction that reduces earned
        // revenue — it can never breach the unearned ceiling, so the cap
        // constrains positive postings only. Capping a correction at an
        // exhausted remainder would silently drop legitimate evidence.
        const cap = await recognitionUnearnedRemaining(tx, {
          orgId, obligationId: row.obligation_id, bookId: row.book_id, deferredAccountId,
        });
        let posting = planned;
        if (cmp(planned, "0") > 0) {
          if (cmp(cap.remaining, "0") <= 0) {
            return { status: "credit_capped" as const, credited: cap.credited, row };
          }
          posting = cmp(planned, cap.remaining) > 0 ? cap.remaining : planned;
        } else if (cmp(planned, "0") < 0) {
          // A negative plan line is a correction reversing earned revenue. It
          // can never drive cumulative net earned negative on its book: with
          // nothing (or too little) earned, the correction reverses unearned
          // revenue that was never recognized. Hold the whole line unposted
          // with an explanatory problem — never floor it at zero, which would
          // silently drop the operator's evidence. The unearned cap above
          // constrains positive postings only, so an exhausted remainder never
          // blocks a legitimate negative.
          const net = await recognitionNetRecognized(tx, {
            orgId, obligationId: row.obligation_id, bookId: row.book_id,
          });
          if (cmp(add(net, planned), "0") < 0) {
            return { status: "negative_floor" as const, net, planned, row };
          }
        }
        if (!row.subsidiary_id || !row.base_currency) {
          throw new RevenueRecognitionError("recognition legal entity and functional currency are required");
        }
        if(row.functional_currency && row.functional_currency!==row.base_currency) throw new RevenueRecognitionError("complete the legal entity functional-currency transition before posting this amended contract");
        const subsidiaryId = row.subsidiary_id;
        // Hold the legal-entity tree while validating the current account and
        // dimension restrictions; discovery-time validation is not sufficient.
        await tx.execute(sql`select id from subsidiaries where org_id = ${orgId} order by id for share`);
        const subsidiaryContext = await loadSubsidiaryContext(tx, orgId);
        const basePosting = mulRate(posting, row.recognition_fx_rate);
        const lines = [
          { accountId: deferredAccountId, amount: basePosting, txnAmount: posting },
          { accountId: recognizedAccountId, amount: neg(basePosting), txnAmount: neg(posting) },
        ];
        await validateSubsidiaryRestrictions(tx, {
          orgId, ctx: subsidiaryContext, docSubsidiaryId: subsidiaryId,
          lines: lines.map(line => ({
            ...line, subsidiaryId,
            departmentId: row.department_id, projectId: row.project_id,
            locationId: row.location_id, classId: row.class_id,
          })),
        });
        const balance = sum(lines.map(line => line.amount));
        if (!isZero(balance)) throw new RevenueRecognitionError(`unbalanced (${balance})`);
        const postingDate = row.recognition_on ?? (row.method === "percent_complete" && asOfDate < row.period_ends_on
          ? asOfDate : row.period_ends_on);
        // Every journal write routes through the ONE ledger API.
        const postedRecognition = await postEntry(tx, {
          orgId,
          bookId: row.book_id,
          subsidiaryId: row.subsidiary_id,
          entryNumber: revenueRecognitionEntryNumber({
            contractNumber: row.contract_number,
            periodName: row.period_name,
            obligationId: row.obligation_id,
            bookId: row.book_id,
            sequence: row.sequence,
            lineId: row.line_id,
          }),
          postingDate,
          periodId: row.period_id,
          memo: `Revenue recognition — ${row.obligation_desc} (${row.period_name})`,
          origin: "revenue_recognition",
          actorId,
          currency: row.recognition_currency ?? row.base_currency,
          lines: lines.map((l) => ({
            accountId: l.accountId,
            amount: l.amount,
            txnAmount: l.txnAmount,
            fxRate: row.recognition_fx_rate,
            departmentId: row.department_id,
            projectId: row.project_id,
            locationId: row.location_id,
            classId: row.class_id,
            equipmentUnitId: row.equipment_unit_id,
            extraDims: row.extra_dims ?? {},
            memo: `Revenue recognition ${row.period_name}`,
          })),
        });
        const eid = postedRecognition.entryId;
        const linked=await tx.execute(sql`
          update recognition_schedule_lines
             set recognized_amount = ${posting}, journal_entry_id = ${eid}, updated_at = now(), updated_by = ${actorId}
           where id = ${row.line_id} and org_id = ${orgId} and journal_entry_id is null and superseded_by_change_id is null returning id`);
        if(linked.rows.length!==1)throw new RevenueRecognitionError('recognition journal could not be linked to its plan');
        return { status: "posted" as const, entryId: eid, planned: posting, row };
      }));
      if (posted.status === "already_posted" || posted.status === "zero") {
        result.skipped++;
        continue;
      }
      if (posted.status === "credit_capped") {
        result.skipped++;
        result.problems.push(
          `${posted.row.contract_number} ${posted.row.obligation_desc}: fully credited — ${posted.credited} relieved to deferred, nothing remains unearned; plan line held`,
        );
        continue;
      }
      if (posted.status === "negative_floor") {
        result.skipped++;
        result.problems.push(
          `${posted.row.contract_number} ${posted.row.obligation_desc}: correction of ${posted.planned} exceeds the ${posted.net} recognized to date — held unposted; record an offsetting recognition event for the excess (events are additive, so the offset replans the held line into a valid correction)`,
        );
        continue;
      }
      if (posted.status === "not_configured") {
        result.skipped++;
        result.problems.push(`${posted.row.contract_number} ${posted.row.obligation_desc}: deferred/recognized account not configured`);
        continue;
      }
      if (posted.status === "period_closed") {
        result.skipped++;
        result.problems.push(`${candidate.contract_number} ${candidate.period_name}: GL period closed`);
        continue;
      }
      result.posted++;
      result.totalAmount = add(result.totalAmount, recognitionBaseAmount(posted.planned, posted.row.recognition_fx_rate));
      result.entries.push({
        contract: posted.row.contract_number,
        obligation: posted.row.obligation_desc,
        period: posted.row.period_name,
        amount: posted.planned,
        entryId: posted.entryId,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.problems.push(`${candidate.contract_number} ${candidate.period_name}: ${msg.slice(0, 120)}`);
    }
  }

  // Milestone/usage plans come from explicitly recorded events. A schedule
  // built with none carries zero lines: nothing ever posts, nothing ever
  // satisfies, and the invoiced amount sits parked in deferred revenue
  // indefinitely. Surface the gap instead of skipping it silently.
  const emptyPlans = (await db.execute<{ contract_number: string; description: string }>(sql`
    select c.contract_number, o.description
      from performance_obligations o
      join revenue_contracts c on c.id = o.contract_id and c.org_id = o.org_id
      join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
     where o.org_id = ${orgId} and o.status = 'open'
       and (not r.is_forecast or o.last_change_id is not null) and ${obligationScope}
       and ${effectiveMethod} in ('milestone', 'usage')
       ${obligationId ? sql`and o.id = ${obligationId}` : sql``}
       and (
         not exists (select 1 from recognition_schedules s where s.obligation_id = o.id and s.org_id = o.org_id)
         or (
           exists (select 1 from recognition_schedules s where s.obligation_id = o.id and s.org_id = o.org_id)
           and not exists (
             select 1 from recognition_schedule_lines l
               join recognition_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
              where s.obligation_id = o.id and s.org_id = o.org_id and l.superseded_by_change_id is null)
         )
       )`));
  for (const row of emptyPlans.rows) {
    result.problems.push(
      `${row.contract_number} ${row.description}: milestone/usage obligation has no recognition events recorded`,
    );
  }

  // Flip fully-recognized obligations to 'satisfied' (no unposted non-zero lines
  // left). Percent-complete obligations are the exception: "caught up to the
  // current estimate" is not "done" — they satisfy only at 100% complete, so an
  // ongoing project contract stays open between catch-ups. The flip also
  // demands positive evidence of completion — at least one schedule line — so a
  // zero-line schedule (e.g. milestone/usage with no events recorded) can never
  // vacuously satisfy an obligation with nothing recognized.
  await db.execute(sql`
    update performance_obligations o
       set status = 'satisfied', updated_at = now()
      from recognition_rules r
     where r.id = o.recognition_rule_id
       and r.org_id = o.org_id
       and o.org_id = ${orgId} and o.status = 'open'
       and (not r.is_forecast or o.last_change_id is not null) and ${obligationScope}
       ${obligationId ? sql`and o.id = ${obligationId}` : sql``}
       and (${effectiveMethod} <> 'percent_complete' or coalesce(o.percent_complete, '0')::numeric >= 100)
       and (${effectiveMethod} not in ('milestone', 'usage') or not exists (
         select 1 from recognition_schedules event_schedule
          where event_schedule.org_id = o.org_id and event_schedule.obligation_id = o.id
            and coalesce((select sum(event_line.recognized_amount)
              from recognition_schedule_lines event_line
              where event_line.org_id = o.org_id and event_line.schedule_id = event_schedule.id
                and event_line.journal_entry_id is not null), 0) <> event_schedule.total_amount
       ))
       and exists (
         select 1 from recognition_schedule_lines l
           join recognition_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
          where s.obligation_id = o.id and s.org_id = o.org_id)
       and not exists (
         select 1 from recognition_schedules s
           join recognition_schedule_lines l on l.schedule_id = s.id and l.org_id = s.org_id
          where s.obligation_id = o.id and s.org_id = o.org_id and l.journal_entry_id is null and l.superseded_by_change_id is null and l.planned_amount <> '0')`);

  // Advance schedule status for reporting.
  await db.execute(sql`
    update recognition_schedules s set status = case
        when not exists (select 1 from recognition_schedule_lines l where l.schedule_id = s.id and l.org_id = s.org_id and l.journal_entry_id is null and l.superseded_by_change_id is null and l.planned_amount <> '0') then 'complete'
        when exists (select 1 from recognition_schedule_lines l where l.schedule_id = s.id and l.org_id = s.org_id and l.journal_entry_id is not null) then 'in_progress'
        else 'planned' end,
      updated_at = now()
    from performance_obligations o
      join recognition_rules r on r.id = o.recognition_rule_id and r.org_id = o.org_id
    where s.org_id = ${orgId} and s.obligation_id = o.id and s.org_id = o.org_id
      and o.status <> 'cancelled' and (not r.is_forecast or o.last_change_id is not null) and ${obligationScope}
      ${obligationId ? sql`and s.obligation_id = ${obligationId}` : sql``}`);

  return result;
}
