import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, fromUnits, isZero, neg, sum, toUnits } from "./money.ts";
import { loadSubsidiaryContext, validateSubsidiaryRestrictions } from "./subsidiaries.ts";

/**
 * Revenue recognition (ASC 606 / IFRS 15), NetSuite ARM-shaped.
 *
 * An obligation carries an allocated amount to recognize over a term. A rule
 * (method + date sources + offsets + accounts) spreads that amount into a
 * per-book, per-period plan (recognition_schedules + one line per period). All
 * of it is org-configured data — see schema/src/revenue.ts.
 *
 * runRevenueRecognition(asOfDate) walks every schedule line whose period has
 * ended on or before the as-of date and is not yet posted, and posts one
 * balanced system journal per line straight through the kernel:
 *
 *     DR deferred revenue      (planned amount)
 *     CR recognized revenue    (planned amount)
 *
 * origin = 'revenue_recognition'; the entry is NOT a document. Idempotency: a
 * line is "posted" once its journal_entry_id is set, so re-running never
 * double-posts. The upstream invoice must have parked the money in deferred
 * revenue (posting.ts credits the item's deferred account for rev-rec lines),
 * so recognition simply drains deferred → earned over the term.
 */

export type RecognitionMethod =
  | "point_in_time"
  | "straight_line_even"
  | "straight_line_prorate_first_last"
  | "straight_line_daily"
  | "percent_complete"
  | "milestone"
  | "usage";

// ---------------------------------------------------------------------------
// Date helpers (UTC, no wall-clock dependency)
// ---------------------------------------------------------------------------

/** First day of the month for a YYYY-MM-DD date, as YYYY-MM-01. */
function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Add n months to a YYYY-MM-01 string, returning YYYY-MM-01. */
function addMonths(monthStartDate: string, n: number): string {
  const [y, m] = monthStartDate.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
}

/** Days in the calendar month containing a YYYY-MM-DD date. */
function daysInMonth(date: string): number {
  const [y, m] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Last day of the month for a YYYY-MM-DD date, as YYYY-MM-DD. */
function monthEnd(date: string): string {
  const [y, m] = date.split("-").map(Number);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(daysInMonth(date)).padStart(2, "0")}`;
}

/** Parse YYYY-MM-DD to a UTC epoch-day integer. */
function epochDay(date: string): number {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** Inclusive day count between two YYYY-MM-DD dates (end − start + 1). */
function inclusiveDays(startOn: string, endOn: string): number {
  return epochDay(endOn) - epochDay(startOn) + 1;
}

/** Shift a YYYY-MM-DD date by n days, returning YYYY-MM-DD. */
export function addDays(date: string, n: number): string {
  const t = (epochDay(date) + n) * 86_400_000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Exact apportionment (integer money units, no drift)
// ---------------------------------------------------------------------------

/**
 * Split `totalUnits` across `weights` so the parts are proportional and sum
 * EXACTLY to the total (largest-remainder / Hamilton apportionment). A zero
 * total or non-positive weight sum yields all zeros.
 */
export function apportion(totalUnits: bigint, weights: number[]): bigint[] {
  const n = weights.length;
  if (n === 0) return [];
  const wsum = weights.reduce((a, b) => a + b, 0);
  if (wsum <= 0 || totalUnits === 0n) return new Array(n).fill(0n);

  const negative = totalUnits < 0n;
  const total = negative ? -totalUnits : totalUnits;

  // Scale weights to integers so the apportionment is deterministic. Scale each
  // weight directly (NOT weight/wsum) so integer weights stay exact — the ratio
  // iw_i / Σiw is then identical to weight_i / Σweight.
  const SCALE = 1_000_000n;
  const iw = weights.map((w) => BigInt(Math.max(0, Math.round(w * Number(SCALE)))));
  let iwsum = iw.reduce((a, b) => a + b, 0n);
  if (iwsum === 0n) {
    iw[0] = SCALE;
    iwsum = SCALE;
  }

  const base = iw.map((w) => (total * w) / iwsum);
  const distributed = base.reduce((a, b) => a + b, 0n);
  let remainder = total - distributed;

  // Hand leftover units out by descending fractional part (stable by index).
  const order = iw
    .map((w, i) => ({ i, frac: (total * w) % iwsum }))
    .sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : a.i - b.i));
  let k = 0;
  while (remainder > 0n) {
    base[order[k % order.length].i] += 1n;
    remainder -= 1n;
    k++;
  }
  return negative ? base.map((u) => -u) : base;
}

/**
 * Allocate a bundle's transaction price across obligations in proportion to
 * their standalone selling price (relative-SSP method, ASC 606-10-32-31).
 * Returns allocated amounts (decimal strings) that sum EXACTLY to `total`.
 * Obligations with no SSP fall back to their booked amount as the weight.
 */
export function allocateByRelativeSSP(
  total: string,
  obligations: { ssp?: string | null; booked?: string | null }[],
): string[] {
  const weights = obligations.map((o) => {
    const w = o.ssp != null && o.ssp !== "" ? o.ssp : (o.booked ?? "0");
    return Number(w);
  });
  return apportion(toUnits(total), weights).map(fromUnits);
}

// ---------------------------------------------------------------------------
// Schedule computation (pure)
// ---------------------------------------------------------------------------

export interface RecognitionInput {
  /** Amount to recognize over the term (post-allocation), decimal string. */
  total: string;
  method: RecognitionMethod;
  /** Recognition start, YYYY-MM-DD. */
  startOn: string;
  /** Recognition end, YYYY-MM-DD (required for prorate / daily precision). */
  endOn?: string | null;
  /** Term length in months, used when endOn is absent (even/prorate/daily). */
  termPeriods?: number | null;
  /** Shift the start date by N days before spreading. */
  startOffsetDays?: number | null;
  /** Percent (0..100) recognized up front in the first period. */
  initialAmountPercent?: string | null;
  /** Shift the whole schedule later by N periods (deferral). */
  periodOffset?: number | null;
  // percent_complete inputs:
  percentComplete?: string | null; // 0..100 cumulative target
  alreadyRecognized?: string | null; // recognized-to-date, decimal string
  /** Explicit period amounts for milestone / usage methods (YYYY-MM-01 → amount). */
  events?: { periodMonth: string; amount: string }[];
}

export interface RecognitionLinePlan {
  sequence: number;
  /** YYYY-MM-01 — the accounting month this recognition belongs to. */
  periodMonth: string;
  /** planned recognition for the month, decimal string (may be 0). */
  planned: string;
  /** cumulative recognized through and including this month. */
  cumulative: string;
}

/** Cumulative-percent × total, exact to 4dp. */
function pctOf(totalUnits: bigint, pct: number): bigint {
  const clamped = Math.max(0, Math.min(100, pct));
  return (totalUnits * BigInt(Math.round(clamped * 10_000))) / 1_000_000n;
}

/** Resolve the term end from an explicit endOn, else start + termPeriods. */
function resolveEnd(startOn: string, input: RecognitionInput): string {
  if (input.endOn) return input.endOn;
  const term = Math.max(1, Math.trunc(input.termPeriods ?? 1));
  return monthEnd(addMonths(monthStart(startOn), term - 1));
}

/** Whole calendar months a term spans, inclusive of first and last. */
function monthSpan(startOn: string, endOn: string): number {
  const [sy, sm] = monthStart(startOn).split("-").map(Number);
  const [ey, em] = monthStart(endOn).split("-").map(Number);
  return ey * 12 + (em - 1) - (sy * 12 + (sm - 1)) + 1;
}

/**
 * Spread the total across the given month weights, honoring an initial up-front
 * percentage recognized in the first period on top of its ratable share.
 * Returns { month, units } aligned to `start` + i months.
 */
function spreadWithInitial(input: RecognitionInput, start: string, weights: number[]): { month: string; units: bigint }[] {
  const totalUnits = toUnits(input.total);
  const initialUnits = pctOf(totalUnits, Number(input.initialAmountPercent ?? "0"));
  const parts = apportion(totalUnits - initialUnits, weights);
  if (weights.length > 0) parts[0] += initialUnits;
  return parts.map((units, i) => ({ month: addMonths(start, i), units }));
}

/**
 * Compute the period-by-period recognition plan for one obligation. Every
 * method recognizes from the (offset) start month forward and sums EXACTLY to
 * the recognizable amount — the apportionment never loses or invents a cent.
 */
export function computeRecognitionSchedule(input: RecognitionInput): RecognitionLinePlan[] {
  const periodOffset = Math.max(0, Math.trunc(input.periodOffset ?? 0));
  const rawStart = input.startOffsetDays ? addDays(input.startOn, Math.trunc(input.startOffsetDays)) : input.startOn;
  const start = monthStart(rawStart);

  const lines: { month: string; units: bigint }[] = (() => {
    switch (input.method) {
      case "point_in_time":
        return [{ month: start, units: toUnits(input.total) }];

      case "percent_complete": {
        const targetUnits = pctOf(toUnits(input.total), Number(input.percentComplete ?? "0"));
        const already = toUnits(input.alreadyRecognized ?? "0");
        const catchUp = targetUnits - already;
        return [{ month: start, units: catchUp > 0n ? catchUp : 0n }];
      }

      case "milestone":
      case "usage":
        return (input.events ?? []).map((e) => ({ month: monthStart(e.periodMonth), units: toUnits(e.amount) }));

      case "straight_line_even": {
        const end = resolveEnd(rawStart, input);
        const n = Math.max(1, monthSpan(rawStart, end));
        return spreadWithInitial(input, start, new Array(n).fill(1));
      }

      case "straight_line_prorate_first_last": {
        const end = resolveEnd(rawStart, input);
        const n = Math.max(1, monthSpan(rawStart, end));
        const weights: number[] = [];
        for (let i = 0; i < n; i++) {
          const m = addMonths(start, i);
          if (n === 1) weights.push(inclusiveDays(rawStart, end));
          else if (i === 0) weights.push(inclusiveDays(rawStart, monthEnd(rawStart)));
          else if (i === n - 1) weights.push(inclusiveDays(m, end));
          else weights.push(daysInMonth(m));
        }
        return spreadWithInitial(input, start, weights);
      }

      case "straight_line_daily": {
        const end = resolveEnd(rawStart, input);
        const n = Math.max(1, monthSpan(rawStart, end));
        const weights: number[] = [];
        for (let i = 0; i < n; i++) {
          const m = addMonths(start, i);
          const segStart = i === 0 ? rawStart : m;
          const segEnd = i === n - 1 ? end : monthEnd(m);
          weights.push(inclusiveDays(segStart, segEnd));
        }
        return spreadWithInitial(input, start, weights);
      }

      default:
        return [];
    }
  })();

  let cumulative = 0n;
  return lines.map((l, idx) => {
    cumulative += l.units;
    return {
      sequence: idx,
      periodMonth: addMonths(l.month, periodOffset),
      planned: fromUnits(l.units),
      cumulative: fromUnits(cumulative),
    };
  });
}

// ---------------------------------------------------------------------------
// Persist a schedule (plan → recognition_schedules + lines)
// ---------------------------------------------------------------------------

/** Primary accounting book id (schedules are book-aware). */
async function primaryBookId(orgId: string): Promise<string> {
  const res = (await db.execute(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary = true limit 1`)) as unknown as {
    rows: { id: string }[];
  };
  if (!res.rows[0]) throw new Error("no primary accounting book");
  return res.rows[0].id;
}

/** Resolve the (non-adjustment) accounting period covering a date, or null. */
async function periodForDate(orgId: string, date: string): Promise<string | null> {
  const res = (await db.execute(sql`
    select id from accounting_periods
     where org_id = ${orgId} and is_adjustment = false
       and starts_on <= ${date} and ends_on >= ${date}
     limit 1`)) as unknown as { rows: { id: string }[] };
  return res.rows[0]?.id ?? null;
}

export interface BuildRecognitionResult {
  scheduleId: string;
  lineCount: number;
  /** months that had no accounting period and were skipped. */
  skippedMonths: string[];
}

/**
 * (Re)build the recognition schedule for an obligation on a book from its rule
 * and resolved term. Existing UNPOSTED lines are replaced; posted lines are
 * preserved so a rebuild after some periods have recognized never disturbs
 * history. Returns the schedule id and how many lines it planned.
 */
export async function buildRecognitionSchedule(
  obligationId: string,
  orgId: string,
  actorId: string | null,
  forBookId?: string,
): Promise<BuildRecognitionResult> {
  const oblRes = (await db.execute(sql`
    select o.id, o.allocated_price, o.recognition_starts_on, o.recognition_ends_on,
           o.percent_complete, c.starts_on as contract_starts, c.ends_on as contract_ends,
           r.method, r.recognition_periods, r.period_offset, r.start_offset_days,
           r.initial_amount_percent, r.start_date_source, r.end_date_source
      from performance_obligations o
      join revenue_contracts c on c.id = o.contract_id
      join recognition_rules r on r.id = o.recognition_rule_id
     where o.id = ${obligationId} and o.org_id = ${orgId}`)) as unknown as {
    rows: {
      id: string;
      allocated_price: string;
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
    }[];
  };
  const o = oblRes.rows[0];
  if (!o) throw new Error("obligation not found");

  const startOn = o.recognition_starts_on ?? o.contract_starts;
  if (!startOn) throw new Error("obligation has no recognition start date");
  const endOn = o.recognition_ends_on ?? (o.end_date_source === "contract" ? o.contract_ends : null);

  const plan = computeRecognitionSchedule({
    total: o.allocated_price,
    method: o.method,
    startOn,
    endOn,
    termPeriods: o.recognition_periods,
    startOffsetDays: o.start_offset_days,
    initialAmountPercent: o.initial_amount_percent,
    periodOffset: o.period_offset,
    percentComplete: o.percent_complete,
  });

  const bookId = forBookId ?? (await primaryBookId(orgId));

  return await db.transaction(async (tx) => {
    const existing = (await tx.execute(sql`
      select id from recognition_schedules
       where obligation_id = ${obligationId} and org_id = ${orgId} and book_id = ${bookId} limit 1`)) as unknown as {
      rows: { id: string }[];
    };
    let scheduleId: string;
    if (existing.rows[0]) {
      scheduleId = existing.rows[0].id;
      await tx.execute(sql`
        update recognition_schedules
           set total_amount = ${o.allocated_price}, updated_at = now(), updated_by = ${actorId}
         where id = ${scheduleId}`);
    } else {
      const ins = (await tx.execute(sql`
        insert into recognition_schedules (org_id, obligation_id, book_id, total_amount, created_by, updated_by)
        values (${orgId}, ${obligationId}, ${bookId}, ${o.allocated_price}, ${actorId}, ${actorId})
        returning id`)) as unknown as { rows: { id: string }[] };
      scheduleId = ins.rows[0].id;
    }

    const posted = (await tx.execute(sql`
      select period_id from recognition_schedule_lines
       where schedule_id = ${scheduleId} and journal_entry_id is not null`)) as unknown as {
      rows: { period_id: string }[];
    };
    const postedPeriods = new Set(posted.rows.map((r) => r.period_id));

    await tx.execute(sql`
      delete from recognition_schedule_lines where schedule_id = ${scheduleId} and journal_entry_id is null`);

    const skippedMonths: string[] = [];
    let lineCount = 0;
    for (const p of plan) {
      const periodId = await periodForDate(orgId, p.periodMonth);
      if (!periodId) {
        skippedMonths.push(p.periodMonth);
        continue;
      }
      if (postedPeriods.has(periodId)) continue;
      await tx.execute(sql`
        insert into recognition_schedule_lines
          (org_id, schedule_id, period_id, sequence, planned_amount, created_by, updated_by)
        values (${orgId}, ${scheduleId}, ${periodId}, ${p.sequence}, ${p.planned}, ${actorId}, ${actorId})`);
      lineCount++;
    }
    return { scheduleId, lineCount, skippedMonths };
  });
}

/** Build the recognition schedule on every GL-posting book (multi-book). */
export async function buildAllRecognitionSchedules(
  obligationId: string,
  orgId: string,
  actorId: string | null,
): Promise<BuildRecognitionResult[]> {
  const books = (await db.execute(sql`
    select id from accounting_books where org_id = ${orgId} and is_active and posts_gl
     order by is_primary desc, code`)) as unknown as { rows: { id: string }[] };
  const results: BuildRecognitionResult[] = [];
  for (const b of books.rows) results.push(await buildRecognitionSchedule(obligationId, orgId, actorId, b.id));
  return results;
}

// ---------------------------------------------------------------------------
// runRevenueRecognition — post due periods through the kernel
// ---------------------------------------------------------------------------

export interface RunRecognitionResult {
  posted: number;
  skipped: number;
  totalAmount: string;
  entries: { contract: string; obligation: string; period: string; amount: string; entryId: string }[];
  problems: string[];
}

/**
 * Post every due, unposted recognition line whose period ends on or before
 * `asOfDate`. Each line becomes one balanced journal entry (DR deferred / CR
 * recognized) posted through the kernel, origin = 'revenue_recognition'. A
 * closed GL period is skipped (not an error). Idempotent: a line with a
 * journal_entry_id is never reconsidered.
 */
export async function runRevenueRecognition(
  orgId: string,
  asOfDate: string,
  actorId: string | null,
  obligationId?: string,
  allowedSubsidiaryIds?: string[],
): Promise<RunRecognitionResult> {
  const subsidiaryContext = await loadSubsidiaryContext(db, orgId);

  const due = (await db.execute(sql`
    select l.id             as line_id,
           l.planned_amount as planned,
           l.period_id      as period_id,
           s.book_id        as book_id,
           p.name           as period_name,
           p.ends_on        as period_ends_on,
           period_module_is_closed(${orgId}, p.id, s.book_id, doc.subsidiary_id, 'gl') as period_closed,
           o.id             as obligation_id,
           o.description    as obligation_desc,
           o.deferred_account_id    as obl_deferred,
           o.recognized_account_id  as obl_recognized,
           it.deferred_account_id   as item_deferred,
           it.income_account_id     as item_income,
           r.deferred_account_id    as rule_deferred,
           r.recognized_account_id  as rule_recognized,
           c.contract_number as contract_number,
           coalesce(doc.subsidiary_id, sub0.id) as subsidiary_id,
           coalesce(sub.base_currency, sub0.base_currency) as base_currency,
           dl.department_id as department_id,
           dl.project_id    as project_id,
           dl.location_id   as location_id
      from recognition_schedule_lines l
      join recognition_schedules s on s.id = l.schedule_id
      join accounting_books bk on bk.id = s.book_id and bk.posts_gl and bk.is_active
      join performance_obligations o on o.id = s.obligation_id
      join revenue_contracts c on c.id = o.contract_id
      join recognition_rules r on r.id = o.recognition_rule_id
      join accounting_periods p on p.id = l.period_id
      left join document_lines dl on dl.id = o.document_line_id
      left join documents doc on doc.id = dl.document_id
      left join items it on it.id = o.item_id
      left join subsidiaries sub on sub.id = doc.subsidiary_id
      left join lateral (
        select id, base_currency from subsidiaries where org_id = ${orgId} order by created_at limit 1
      ) sub0 on true
     where l.org_id = ${orgId}
       and l.journal_entry_id is null
       and o.status <> 'cancelled'
       and p.ends_on <= ${asOfDate}
       ${obligationId ? sql`and o.id = ${obligationId}` : sql``}
       ${allowedSubsidiaryIds ? sql`and coalesce(doc.subsidiary_id, sub0.id) = any(${`{${allowedSubsidiaryIds.join(",")}}`}::uuid[])` : sql``}
     order by c.contract_number, o.description, l.sequence`)) as unknown as { rows: any[] };

  const result: RunRecognitionResult = { posted: 0, skipped: 0, totalAmount: "0", entries: [], problems: [] };

  for (const row of due.rows) {
    const planned: string = row.planned;
    if (isZero(planned)) {
      await db.execute(sql`
        update recognition_schedule_lines set recognized_amount = '0', updated_at = now() where id = ${row.line_id}`);
      result.skipped++;
      continue;
    }
    if (row.period_closed) {
      result.skipped++;
      result.problems.push(`${row.contract_number} ${row.period_name}: GL period closed`);
      continue;
    }

    const deferredAccountId = row.obl_deferred ?? row.item_deferred ?? row.rule_deferred;
    const recognizedAccountId = row.obl_recognized ?? row.rule_recognized ?? row.item_income;
    if (!deferredAccountId || !recognizedAccountId) {
      result.skipped++;
      result.problems.push(`${row.contract_number} ${row.obligation_desc}: deferred/recognized account not configured`);
      continue;
    }

    // DR deferred (+planned), CR recognized (−planned) — balanced by construction.
    const lines = [
      { accountId: deferredAccountId, amount: planned },
      { accountId: recognizedAccountId, amount: neg(planned) },
    ];
    try {
      await validateSubsidiaryRestrictions(db, {
        orgId,
        ctx: subsidiaryContext,
        docSubsidiaryId: row.subsidiary_id,
        lines: lines.map((line) => ({
          ...line,
          subsidiaryId: row.subsidiary_id,
          departmentId: row.department_id,
          projectId: row.project_id,
          locationId: row.location_id,
        })),
      });
    } catch (error) {
      result.problems.push(`${row.contract_number} ${row.period_name}: ${(error as Error).message}`);
      continue;
    }
    const bal = sum(lines.map((l) => l.amount));
    if (!isZero(bal)) {
      result.problems.push(`${row.contract_number} ${row.period_name}: unbalanced (${bal})`);
      continue;
    }

    const postingDate: string = row.period_ends_on;
    try {
      const entryId = await db.transaction(async (tx) => {
        const entryRes = (await tx.execute(sql`
          insert into journal_entries
            (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
          values (${orgId}, ${row.book_id}, ${row.subsidiary_id},
                  ${`REV-${row.contract_number}-${row.period_name}`},
                  ${postingDate}, ${row.period_id},
                  ${`Revenue recognition — ${row.obligation_desc} (${row.period_name})`},
                  'draft', 'revenue_recognition', ${actorId}, ${actorId})
          returning id`)) as unknown as { rows: { id: string }[] };
        const eid = entryRes.rows[0].id;

        for (let i = 0; i < lines.length; i++) {
          const l = lines[i];
          await tx.execute(sql`
            insert into journal_lines
              (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
               department_id, project_id, location_id, memo)
            values (${orgId}, ${eid}, ${i + 1}, ${l.accountId}, ${row.subsidiary_id}, ${l.amount}, ${row.base_currency}, ${l.amount}, 1,
                    ${row.department_id}, ${row.project_id}, ${row.location_id},
                    ${`Revenue recognition ${row.period_name}`})`);
        }

        await tx.execute(sql`
          update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId} where id = ${eid}`);

        await tx.execute(sql`
          update recognition_schedule_lines
             set recognized_amount = ${planned}, journal_entry_id = ${eid}, updated_at = now(), updated_by = ${actorId}
           where id = ${row.line_id}`);

        return eid;
      });

      result.posted++;
      result.totalAmount = add(result.totalAmount, planned);
      result.entries.push({
        contract: row.contract_number,
        obligation: row.obligation_desc,
        period: row.period_name,
        amount: planned,
        entryId,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.problems.push(`${row.contract_number} ${row.period_name}: ${msg.slice(0, 120)}`);
    }
  }

  // Flip fully-recognized obligations to 'satisfied' (no unposted non-zero lines left).
  await db.execute(sql`
    update performance_obligations o
       set status = 'satisfied', updated_at = now()
     where o.org_id = ${orgId} and o.status = 'open'
       ${obligationId ? sql`and o.id = ${obligationId}` : sql``}
       and exists (select 1 from recognition_schedules s where s.obligation_id = o.id)
       and not exists (
         select 1 from recognition_schedules s
           join recognition_schedule_lines l on l.schedule_id = s.id
          where s.obligation_id = o.id and l.journal_entry_id is null and l.planned_amount <> '0')`);

  // Advance schedule status for reporting.
  await db.execute(sql`
    update recognition_schedules s set status = case
        when not exists (select 1 from recognition_schedule_lines l where l.schedule_id = s.id and l.journal_entry_id is null and l.planned_amount <> '0') then 'complete'
        when exists (select 1 from recognition_schedule_lines l where l.schedule_id = s.id and l.journal_entry_id is not null) then 'in_progress'
        else 'planned' end,
      updated_at = now()
    where s.org_id = ${orgId}
      ${obligationId ? sql`and s.obligation_id = ${obligationId}` : sql``}`);

  return result;
}
