import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, schema } from "./db.ts";
import { add, cmp, fromUnits, isZero, neg, sum, toUnits } from "./money.ts";
import { loadSubsidiaryContext, validateSubsidiaryRestrictions } from "./subsidiaries.ts";

/**
 * Fixed-asset depreciation.
 *
 * A schedule is a per-book plan of monthly depreciation amounts derived from an
 * asset (cost, salvage, in-service date, useful life, method). Building a
 * schedule stores the plan (depreciation_schedules + one line per calendar
 * month it can be posted into, mapped to an accounting_period).
 *
 * runDepreciation(asOfDate) walks every schedule line whose period has ended on
 * or before the as-of date and is not yet posted, and posts one balanced system
 * journal per line straight through the kernel:
 *
 *     DR depreciation expense        (planned amount)
 *     CR accumulated depreciation    (planned amount)
 *
 * origin = 'depreciation'; the entry is NOT a document. Idempotency: a line is
 * "posted" once its journal_entry_id is set, so re-running never double-posts —
 * the posted period is tracked on the line itself.
 */

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

/**
 * The GL accounts a depreciation entry touches. The asset may override them in
 * `custom.accounts`; otherwise they come from the asset's category (the schema
 * design — accounts live on asset_categories).
 */
export interface AssetAccounts {
  assetAccountId: string;
  accumulatedDepreciationAccountId: string;
  depreciationExpenseAccountId: string;
}

export function resolveAssetAccounts(
  asset: { custom?: Record<string, any> | null },
  category: {
    assetAccountId: string;
    accumulatedDepreciationAccountId: string;
    depreciationExpenseAccountId: string;
  },
): AssetAccounts {
  const o = (asset.custom?.accounts ?? {}) as Record<string, string | undefined>;
  return {
    assetAccountId: o.asset || category.assetAccountId,
    accumulatedDepreciationAccountId:
      o.accumulated || category.accumulatedDepreciationAccountId,
    depreciationExpenseAccountId: o.expense || category.depreciationExpenseAccountId,
  };
}

// ---------------------------------------------------------------------------
// Schedule computation (pure)
// ---------------------------------------------------------------------------

export type DepreciationMethod =
  | "straight_line"
  | "declining_balance"
  | "double_declining"
  | "units_of_production"
  | "manual";

export interface ScheduleInput {
  /** acquisition cost, decimal string */
  cost: string;
  /** salvage value, decimal string */
  salvage: string;
  /** YYYY-MM-DD */
  inServiceOn: string;
  /** total useful life in months (> 0) */
  lifeMonths: number;
  method: DepreciationMethod;
  /**
   * Annual rate percent for declining-balance (e.g. "30" = 30%/yr). Ignored for
   * double_declining (rate is derived as 2 / life-years). Defaults, when absent,
   * to the straight-line-equivalent rate (1 / life-years).
   */
  ratePercent?: string | null;
}

export interface ScheduleLinePlan {
  sequence: number;
  /** YYYY-MM-01 — the calendar month this depreciation belongs to */
  periodMonth: string;
  /** planned depreciation for the month, decimal string (>= 0) */
  planned: string;
  /** accumulated depreciation through and including this month */
  accumulated: string;
  /** net book value at end of month = cost - accumulated */
  netBookValue: string;
}

/** First day of the month for a YYYY-MM-DD date. */
function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Add n months to a YYYY-MM-01 string, returning YYYY-MM-01. */
function addMonths(monthStartDate: string, n: number): string {
  const [y, m] = monthStartDate.split("-").map(Number);
  const total = (y * 12 + (m - 1)) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-01`;
}

/**
 * Compute the monthly depreciation plan for an asset. Every method depreciates
 * from the in-service month forward, one entry per calendar month, and never
 * takes NBV below salvage — the final month absorbs any rounding remainder so
 * total lifetime depreciation is exactly (cost − salvage).
 */
export function computeSchedule(input: ScheduleInput): ScheduleLinePlan[] {
  const life = Math.max(1, Math.trunc(input.lifeMonths));
  const cost = toUnits(input.cost);
  const salvage = toUnits(input.salvage);
  const depreciableBase = cost - salvage; // total to depreciate over life
  if (depreciableBase <= 0n) return [];

  const start = monthStart(input.inServiceOn);
  const plans: ScheduleLinePlan[] = [];

  let accumulated = 0n; // units already depreciated

  if (input.method === "straight_line" || input.method === "manual") {
    // Even monthly amount; last month absorbs the rounding remainder.
    const per = depreciableBase / BigInt(life);
    for (let i = 0; i < life; i++) {
      let amt = i === life - 1 ? depreciableBase - accumulated : per;
      if (amt < 0n) amt = 0n;
      accumulated += amt;
      plans.push(makeLine(i, addMonths(start, i), amt, accumulated, cost));
    }
    return plans;
  }

  // Declining-balance family: apply a monthly rate to the *remaining* book
  // value (above salvage) each month; stop at salvage; last month plugs.
  // annual rate: double_declining => 2/lifeYears; declining_balance => provided
  // ratePercent (else 1/lifeYears straight-line-equivalent).
  const lifeYears = life / 12;
  let annualRate: number;
  if (input.method === "double_declining") {
    annualRate = 2 / lifeYears;
  } else {
    // declining_balance
    const provided = input.ratePercent != null ? Number(input.ratePercent) / 100 : NaN;
    annualRate = Number.isFinite(provided) && provided > 0 ? provided : 1 / lifeYears;
  }
  const monthlyRate = annualRate / 12;

  for (let i = 0; i < life; i++) {
    const remaining = depreciableBase - accumulated; // book value above salvage, units
    if (remaining <= 0n) {
      plans.push(makeLine(i, addMonths(start, i), 0n, accumulated, cost));
      continue;
    }
    let amt: bigint;
    if (i === life - 1) {
      // final month: take everything left so NBV lands exactly on salvage
      amt = remaining;
    } else {
      // round to whole cents
      amt = BigInt(Math.round(Number(remaining) * monthlyRate));
      if (amt < 0n) amt = 0n;
      if (amt > remaining) amt = remaining;
    }
    accumulated += amt;
    plans.push(makeLine(i, addMonths(start, i), amt, accumulated, cost));
  }
  return plans;
}

function makeLine(
  sequence: number,
  periodMonth: string,
  amtUnits: bigint,
  accumulatedUnits: bigint,
  costUnits: bigint,
): ScheduleLinePlan {
  return {
    sequence,
    periodMonth,
    planned: fromUnits(amtUnits),
    accumulated: fromUnits(accumulatedUnits),
    netBookValue: fromUnits(costUnits - accumulatedUnits),
  };
}

// ---------------------------------------------------------------------------
// Persist a schedule (plan → depreciation_schedules + lines)
// ---------------------------------------------------------------------------

/** Primary accounting book id (schedules are book-aware). */
async function primaryBookId(): Promise<string> {
  const [book] = await db
    .select({ id: schema.accountingBooks.id })
    .from(schema.accountingBooks)
    .where(eq(schema.accountingBooks.isPrimary, true));
  if (!book) throw new Error("no primary accounting book");
  return book.id;
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

export interface BuildScheduleResult {
  scheduleId: string;
  lineCount: number;
  /** months that had no accounting period and were skipped */
  skippedMonths: string[];
}

/**
 * (Re)build the primary-book depreciation schedule for an asset from its
 * current cost / salvage / in-service / life / method. Any existing schedule
 * lines that have NOT yet posted are replaced; posted lines are preserved so a
 * rebuild after some periods have run never disturbs history.
 *
 * Called from the asset save path and by "Run depreciation".
 */
export async function buildSchedule(
  assetId: string,
  orgId: string,
  actorId: string | null,
): Promise<BuildScheduleResult> {
  const assetRes = (await db.execute(sql`
    select id, org_id, category_id, in_service_on, acquisition_cost, salvage_value, custom
      from fixed_assets where id = ${assetId} and org_id = ${orgId}`)) as unknown as {
    rows: {
      id: string;
      category_id: string;
      in_service_on: string | null;
      acquisition_cost: string;
      salvage_value: string;
      custom: Record<string, any> | null;
    }[];
  };
  const asset = assetRes.rows[0];
  if (!asset) throw new Error("asset not found");
  if (!asset.in_service_on) throw new Error("asset has no in-service date");

  const catRes = (await db.execute(sql`
    select default_method, default_life_months
      from asset_categories where id = ${asset.category_id} and org_id = ${orgId}`)) as unknown as {
    rows: { default_method: DepreciationMethod; default_life_months: number | null }[];
  };
  const category = catRes.rows[0];
  if (!category) throw new Error("asset category not found");

  // Method / life / rate live on the schedule; seed them from the asset's
  // custom overrides (set by the drawer) else the category defaults.
  const custom = asset.custom ?? {};
  const method: DepreciationMethod = custom.method ?? category.default_method ?? "straight_line";
  const lifeMonths: number = Number(custom.lifeMonths ?? category.default_life_months ?? 0);
  const ratePercent: string | null = custom.ratePercent != null ? String(custom.ratePercent) : null;
  if (!lifeMonths || lifeMonths <= 0) throw new Error("asset has no useful life (months)");

  const bookId = await primaryBookId();

  const plan = computeSchedule({
    cost: asset.acquisition_cost,
    salvage: asset.salvage_value,
    inServiceOn: asset.in_service_on,
    lifeMonths,
    method,
    ratePercent,
  });

  return await db.transaction(async (tx) => {
    // find (or create) the primary-book schedule for this asset
    const existing = (await tx.execute(sql`
      select id from depreciation_schedules
       where asset_id = ${assetId} and org_id = ${orgId} and book_id = ${bookId} limit 1`)) as unknown as {
      rows: { id: string }[];
    };
    let scheduleId: string;
    if (existing.rows[0]) {
      scheduleId = existing.rows[0].id;
      await tx.execute(sql`
        update depreciation_schedules
           set method = ${method}, life_months = ${lifeMonths},
               rate_percent = ${ratePercent}, updated_at = now(), updated_by = ${actorId}
         where id = ${scheduleId}`);
    } else {
      const ins = (await tx.execute(sql`
        insert into depreciation_schedules (org_id, asset_id, book_id, method, life_months, rate_percent, created_by, updated_by)
        values (${orgId}, ${assetId}, ${bookId}, ${method}, ${lifeMonths}, ${ratePercent}, ${actorId}, ${actorId})
        returning id`)) as unknown as { rows: { id: string }[] };
      scheduleId = ins.rows[0].id;
    }

    // preserve posted lines; drop only the unposted plan and rewrite it
    const posted = (await tx.execute(sql`
      select period_id from depreciation_schedule_lines
       where schedule_id = ${scheduleId} and journal_entry_id is not null`)) as unknown as {
      rows: { period_id: string }[];
    };
    const postedPeriods = new Set(posted.rows.map((r) => r.period_id));

    await tx.execute(sql`
      delete from depreciation_schedule_lines
       where schedule_id = ${scheduleId} and journal_entry_id is null`);

    const skippedMonths: string[] = [];
    let lineCount = 0;
    for (const p of plan) {
      const periodId = await periodForDate(orgId, p.periodMonth);
      if (!periodId) {
        skippedMonths.push(p.periodMonth);
        continue;
      }
      if (postedPeriods.has(periodId)) continue; // already posted — keep as is
      await tx.execute(sql`
        insert into depreciation_schedule_lines
          (org_id, schedule_id, period_id, sequence, planned_amount, created_by, updated_by)
        values (${orgId}, ${scheduleId}, ${periodId}, ${p.sequence}, ${p.planned}, ${actorId}, ${actorId})`);
      lineCount++;
    }
    return { scheduleId, lineCount, skippedMonths };
  });
}

// ---------------------------------------------------------------------------
// runDepreciation — post due periods through the kernel
// ---------------------------------------------------------------------------

export interface RunDepreciationResult {
  posted: number;
  skipped: number;
  totalAmount: string;
  entries: { assetNumber: string; period: string; amount: string; entryId: string }[];
  problems: string[];
}

/**
 * Post every due, unposted depreciation line whose period ends on or before
 * `asOfDate`. Each line becomes one balanced journal entry (DR expense / CR
 * accumulated) posted through the kernel draft→lines→posted, origin =
 * 'depreciation'. A closed GL period is skipped (not an error). Idempotent:
 * a line with a journal_entry_id is never reconsidered.
 */
export async function runDepreciation(
  orgId: string,
  asOfDate: string,
  actorId: string | null,
  assetId?: string,
  allowedSubsidiaryIds?: string[],
): Promise<RunDepreciationResult> {
  const bookId = await primaryBookId();
  const subsidiaryContext = await loadSubsidiaryContext(db, orgId);

  // Due, unposted lines with their asset + resolved accounts + period window.
  const due = (await db.execute(sql`
    select l.id            as line_id,
           l.planned_amount as planned,
           l.sequence      as sequence,
           l.period_id     as period_id,
           p.name          as period_name,
           p.ends_on       as period_ends_on,
           (period_module_is_closed(${orgId}, p.id, ${bookId}, a.subsidiary_id, 'assets')
             or period_module_is_closed(${orgId}, p.id, ${bookId}, a.subsidiary_id, 'gl')) as period_closed,
           a.id            as asset_id,
           a.subsidiary_id as subsidiary_id,
           sub.base_currency as base_currency,
           a.asset_number  as asset_number,
           a.name          as asset_name,
           a.custom        as asset_custom,
           a.department_id as department_id,
           a.project_id    as project_id,
           a.location_id   as location_id,
           c.asset_account_id                    as cat_asset,
           c.accumulated_depreciation_account_id as cat_accum,
           c.depreciation_expense_account_id     as cat_expense
      from depreciation_schedule_lines l
      join depreciation_schedules s on s.id = l.schedule_id and s.book_id = ${bookId}
      join fixed_assets a on a.id = s.asset_id
      join subsidiaries sub on sub.id = a.subsidiary_id
      join asset_categories c on c.id = a.category_id
      join accounting_periods p on p.id = l.period_id
     where l.org_id = ${orgId}
       and l.journal_entry_id is null
       and a.status not in ('disposed', 'written_off')
       and p.ends_on <= ${asOfDate}
       ${allowedSubsidiaryIds ? sql`and a.subsidiary_id = any(${`{${allowedSubsidiaryIds.join(",")}}`}::uuid[])` : sql``}
       ${assetId ? sql`and a.id = ${assetId}` : sql``}
     order by a.asset_number, l.sequence`)) as unknown as {
    rows: any[];
  };

  const result: RunDepreciationResult = {
    posted: 0,
    skipped: 0,
    totalAmount: "0",
    entries: [],
    problems: [],
  };

  for (const row of due.rows) {
    const planned: string = row.planned;
    if (isZero(planned)) {
      // a zero-planned month: mark it posted-with-no-entry so it never recurs.
      await db.execute(sql`
        update depreciation_schedule_lines set posted_amount = '0', updated_at = now()
         where id = ${row.line_id}`);
      result.skipped++;
      continue;
    }
    if (row.period_closed) {
      result.skipped++;
      result.problems.push(`${row.asset_number} ${row.period_name}: GL period closed`);
      continue;
    }

    const accounts = resolveAssetAccounts(
      { custom: row.asset_custom },
      {
        assetAccountId: row.cat_asset,
        accumulatedDepreciationAccountId: row.cat_accum,
        depreciationExpenseAccountId: row.cat_expense,
      },
    );

    // DR expense (+planned), CR accumulated (−planned) — balanced by construction.
    const lines = [
      { accountId: accounts.depreciationExpenseAccountId, amount: planned },
      { accountId: accounts.accumulatedDepreciationAccountId, amount: neg(planned) },
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
      result.problems.push(`${row.asset_number} ${row.period_name}: ${(error as Error).message}`);
      continue;
    }
    const bal = sum(lines.map((l) => l.amount));
    if (!isZero(bal)) {
      result.problems.push(`${row.asset_number} ${row.period_name}: unbalanced (${bal})`);
      continue;
    }

    const postingDate: string = row.period_ends_on;
    try {
      const entryId = await db.transaction(async (tx) => {
        const entryRes = (await tx.execute(sql`
          insert into journal_entries
            (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
          values (${orgId}, ${bookId}, ${row.subsidiary_id},
                  ${`DEP-${row.asset_number}-${row.period_name}`},
                  ${postingDate}, ${row.period_id},
                  ${`Depreciation — ${row.asset_name} (${row.period_name})`},
                  'draft', 'depreciation', ${actorId}, ${actorId})
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
                    ${`Depreciation ${row.period_name}`})`);
        }

        await tx.execute(sql`
          update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId}
           where id = ${eid}`);

        await tx.execute(sql`
          update depreciation_schedule_lines
             set posted_amount = ${planned}, journal_entry_id = ${eid}, updated_at = now(), updated_by = ${actorId}
           where id = ${row.line_id}`);

        return eid;
      });

      result.posted++;
      result.totalAmount = add(result.totalAmount, planned);
      result.entries.push({
        assetNumber: row.asset_number,
        period: row.period_name,
        amount: planned,
        entryId,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.problems.push(`${row.asset_number} ${row.period_name}: ${msg.slice(0, 120)}`);
    }
  }

  // Flip fully-depreciated assets (NBV reached salvage — no unposted lines left
  // and accumulated == cost − salvage) to 'fully_depreciated'.
  await db.execute(sql`
    update fixed_assets a
       set status = 'fully_depreciated', updated_at = now()
     where a.org_id = ${orgId} and a.status = 'in_service'
       ${assetId ? sql`and a.id = ${assetId}` : sql``}
       and not exists (
         select 1 from depreciation_schedules s
           join depreciation_schedule_lines l on l.schedule_id = s.id
          where s.asset_id = a.id and l.journal_entry_id is null and l.planned_amount <> '0')
       and exists (
         select 1 from depreciation_schedules s
           join depreciation_schedule_lines l on l.schedule_id = s.id
          where s.asset_id = a.id and l.journal_entry_id is not null)`);

  return result;
}

/** Sort helper re-export (kept local so callers don't import money directly). */
export { cmp as compareMoney };
