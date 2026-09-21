import { assetBasisDelta } from "./asset-basis.ts";import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { assertPeriodModulesOpen, CloseError } from "../close/period-policy.ts";
import { buildScheduleWithRunner, reconcileAssetDepreciationStatusWithRunner, resolveAssetAccounts, unimpairedAssetCarryingValue } from "./depreciation.ts";
import { add, cmp, fromUnits, isZero, neg, toUnits } from "../money/money.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { orgReportingFramework } from "../platform/reporting-framework.ts";
import { loadSubsidiaryContext, SubsidiaryError, uuidArray, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";

/**
 * Fixed-asset lifecycle posting — disposal by sale and write-off.
 *
 * Disposal clears the asset's cost and accumulated depreciation, recognizes any
 * proceeds, and books the balancing gain or loss:
 *
 *   DR  proceeds account            (sale proceeds, if any)
 *   DR  accumulated depreciation    (accum to date)
 *   CR  asset                       (original cost)
 *   DR/CR gain-or-loss on disposal  (balancing; gain = credit, loss = debit)
 *
 * A write-off is a disposal with zero proceeds (the whole net book value is a
 * loss). The entry posts through the kernel (balanced, closed-period-aware) with
 * origin='disposal', and records an asset_events row carrying the journal.
 */

export class AssetLifecycleError extends Error {
  readonly name = "AssetLifecycleError";
}

export interface DisposalAccounts {
  assetAccountId: string;
  accumulatedDepreciationAccountId: string;
  gainLossAccountId: string;
  /** Where proceeds land (bank/AR); omitted for a write-off. */
  proceedsAccountId?: string | null;
}

/** A signed GL line: positive = debit, negative = credit. */
export interface DisposalLine {
  accountId: string;
  amount: string;
  currency?: string;
  txnAmount?: string;
  fxRate?: string;
}

const sub = (a: string, b: string) => add(a, neg(b));

/**
 * Application-level companion to the je_guard Postgres gate (which refuses
 * the draft→posted flip in a GL-closed period): fail fast with a named
 * AssetLifecycleError instead of dying at the flip with a raw driver error.
 * Unlike je_guard, this also enforces the assets workstream lock — the same
 * lock the depreciation claim already honors — so closing the assets module
 * actually stops disposals, remeasurements, and reversals. GL is always
 * implied.
 */
export async function assertAssetPeriodOpen(
  tx: SqlExecutor,
  args: {
    orgId: string;
    periodId: string;
    bookId: string;
    subsidiaryIds: string[];
  },
): Promise<void> {
  try {
    await assertPeriodModulesOpen(tx, { ...args, modules: ["assets"] });
  } catch (error) {
    if (error instanceof CloseError)
      throw new AssetLifecycleError(error.message);
    throw error;
  }
}

/**
 * Pure disposal arithmetic. NBV = cost − accumulated; gain/loss = proceeds − NBV
 * (positive = gain). Returns the balanced GL lines (zeros dropped). Pure, so the
 * accounting is unit-tested without a database.
 */
/** Posted money is numeric(19,4): fifteen whole digits. The format check admits
 * any magnitude, so a pasted 20-digit amount died in Postgres with a storage
 * error. Fail closed with the same named refusal. */
function assertLedgerMagnitude(value: string, label: string): void {
  if (value.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15) {
    throw new AssetLifecycleError(`${label} exceeds the supported ledger magnitude`);
  }
}

export function computeDisposal(args: {
  cost: string;
  accumulated: string;
  proceeds: string;
  accounts: DisposalAccounts;
}): { nbv: string; gainLoss: string; lines: DisposalLine[] } {
  const { accounts } = args;
  // Normalize inputs to the ledger's 4dp so every emitted line amount matches.
  const cost = add(args.cost, "0");
  const accumulated = add(args.accumulated, "0");
  const proceeds = add(args.proceeds, "0");
  const nbv = sub(cost, accumulated);
  const gainLoss = sub(proceeds, nbv);

  const lines: DisposalLine[] = [{ accountId: accounts.assetAccountId, amount: neg(cost) }];
  if (!isZero(accumulated)) {
    lines.push({ accountId: accounts.accumulatedDepreciationAccountId, amount: accumulated });
  }
  if (!isZero(proceeds)) {
    if (!accounts.proceedsAccountId) throw new AssetLifecycleError("a proceeds account is required when there are proceeds");
    lines.push({ accountId: accounts.proceedsAccountId, amount: proceeds });
  }
  // Balancing line = −gainLoss (a gain credits income, a loss debits it).
  const glAmount = neg(gainLoss);
  if (!isZero(glAmount)) lines.push({ accountId: accounts.gainLossAccountId, amount: glAmount });

  const total = lines.reduce((acc, l) => add(acc, l.amount), "0");
  if (!isZero(total)) throw new AssetLifecycleError(`disposal entry does not balance (residual ${total})`);
  return { nbv, gainLoss, lines };
}

/**
 * Pure remeasurement (impairment write-down / revaluation write-up) arithmetic.
 * delta = new carrying value − current NBV. A write-down debits the adjustment
 * (loss) account and credits accumulated depreciation (reducing NBV); a write-up
 * does the reverse. Balanced by construction.
 */
export function computeRemeasurement(args: {
  cost: string;
  accumulated: string;
  newCarryingValue: string;
  accumulatedDepreciationAccountId: string;
  adjustmentAccountId: string;
}): { delta: string; lines: DisposalLine[] } {
  const cost = add(args.cost, "0");
  const accumulated = add(args.accumulated, "0");
  const newCv = add(args.newCarryingValue, "0");
  const currentNbv = sub(cost, accumulated);
  const delta = sub(newCv, currentNbv);
  if (isZero(delta)) return { delta, lines: [] };

  const lines: DisposalLine[] =
    cmp(delta, "0") < 0
      ? [
          { accountId: args.adjustmentAccountId, amount: neg(delta) }, // DR loss (|delta|)
          { accountId: args.accumulatedDepreciationAccountId, amount: delta }, // CR accum (−|delta|)
        ]
      : [
          { accountId: args.accumulatedDepreciationAccountId, amount: delta }, // DR accum (+delta)
          { accountId: args.adjustmentAccountId, amount: neg(delta) }, // CR reserve/gain
        ];
  const total = lines.reduce((a, l) => add(a, l.amount), "0");
  if (!isZero(total)) throw new AssetLifecycleError(`remeasurement does not balance (${total})`);
  return { delta, lines };
}

async function primaryBookId(orgId: string, exec: SqlExecutor = db): Promise<string> {
  const r = (await exec.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary and is_active and posts_gl
     limit 1 for share`));
  if (!r.rows[0]) throw new AssetLifecycleError("no active primary posting book");
  return r.rows[0].id;
}

/**
 * Serialize remeasurement mutations on the authoritative asset row. This must
 * be the first statement in the remeasurement transaction so a contender waits
 * before reading carrying-value inputs and then re-reads the committed state.
 */
export async function lockAssetRow(
  exec: SqlExecutor,
  orgId: string,
  assetId: string,
  allowedSubsidiaryIds?: readonly string[] | null,
): Promise<void> {
  const locked = await exec.execute<{ id: string; category_id: string }>(sql`
    select id, category_id from fixed_assets where org_id = ${orgId} and id = ${assetId}
      ${allowedSubsidiaryIds ? sql`and subsidiary_id = any(${`{${allowedSubsidiaryIds.join(",")}}`}::uuid[])` : sql``}
      for update`);
  if (!locked.rows[0]) throw new AssetLifecycleError("asset not found");
  // Match depreciation's asset-then-category order. Category policy writes must
  // finish before we read defaults, or wait until our financial history commits.
  const category = await exec.execute(sql`
    select id from asset_categories
     where org_id = ${orgId} and id = ${locked.rows[0].category_id} for update`);
  if (!category.rows[0])
    throw new AssetLifecycleError("asset category not found");
}

/**
 * Net signed remeasurement delta carried on an asset: the sum of every
 * un-reversed impairment (negative) and revaluation write-up (positive)
 * event. Remeasurements post against ACCUMULATED DEPRECIATION but never into
 * depreciation_schedule_lines, so any NBV derived from the schedule alone is
 * wrong the moment an asset has been impaired — a later remeasure would
 * measure off an overstated carrying amount, and a disposal would strand the
 * impairment credit on the accumulated-depreciation account.
 */
export async function netRemeasurementDelta(
  orgId: string,
  assetId: string,
  bookId: string,
  exec: SqlExecutor = db,
): Promise<string> {
  const r = await exec.execute<{ delta: string }>(sql`
    select coalesce(sum(event.amount), 0)::text as delta
      from asset_events event
      join journal_entries entry on entry.id = event.journal_entry_id and entry.org_id = event.org_id
     where event.org_id = ${orgId} and event.asset_id = ${assetId}
       and entry.book_id = ${bookId} and entry.status = 'posted'
       and event.kind in ('impaired', 'revalued')
       and not exists (
         select 1 from asset_events reversal
          where reversal.org_id = event.org_id
            and reversal.reverses_event_id = event.id)`);
  return r.rows[0]?.delta ?? "0";
}

export interface RemeasurementPolicyDecision {
  allowed: boolean;
  /** The part of an allowed write-up that releases prior impairment. */
  reversalPortion: string;
  reason?: string;
}

/**
 * Framework gate on remeasurement direction — pure, so the rule itself is
 * unit-testable and corpus-verifiable.
 *
 * Write-downs are always permitted. Write-ups on an asset carrying an
 * unreversed impairment are RESTORATIONS:
 *  - US GAAP (ASC 360-10-35-20): restoration of an impairment loss on a
 *    held-and-used asset is prohibited outright.
 *  - IFRS (IAS 36.114/117): a reversal is permitted but capped — the carrying
 *    amount may not exceed what it would have been had no impairment been
 *    recognised. This pure gate rejects increases beyond the original loss;
 *    the service also applies the depreciated counterfactual carrying-value
 *    ceiling from the asset's native policy at the effective posting date.
 * A write-up with NO impairment history is an ordinary revaluation and passes
 * through unchanged (both frameworks reach it via their revaluation models).
 */
export function remeasurementPolicy(args: {
  framework: "us_gaap" | "ifrs";
  delta: string;
  unreversedImpairment: string;
}): RemeasurementPolicyDecision {
  const { framework, delta, unreversedImpairment } = args;
  if (cmp(delta, "0") <= 0) return { allowed: true, reversalPortion: "0.0000" };
  if (cmp(unreversedImpairment, "0") <= 0) return { allowed: true, reversalPortion: "0.0000" };

  if (framework === "us_gaap") {
    return {
      allowed: false,
      reversalPortion: "0.0000",
      reason:
        "US GAAP prohibits restoring a previously recognised impairment loss on a held-and-used asset (ASC 360-10-35-20) — the impaired amount is the asset's new cost basis",
    };
  }
  if (cmp(delta, unreversedImpairment) > 0) {
    return {
      allowed: false,
      reversalPortion: "0.0000",
      reason:
        `IAS 36 caps an impairment reversal at the carrying amount that would have existed had no impairment been recognised — the write-up of ${delta} exceeds the unreversed impairment of ${unreversedImpairment}; the excess is a revaluation-surplus event, which this remeasurement path does not model`,
    };
  }
  return { allowed: true, reversalPortion: fromUnits(toUnits(delta)) };
}

type AssetAccountRow = {
  native_asset_account_id: string | null;
  native_accumulated_account_id: string | null;
  native_expense_account_id: string | null;
  asset_account_id: string;
  accumulated_depreciation_account_id: string;
  depreciation_expense_account_id: string;
};

function lifecycleAccounts(asset: AssetAccountRow) {
  return resolveAssetAccounts({
    assetAccountId: asset.native_asset_account_id,
    accumulatedDepreciationAccountId: asset.native_accumulated_account_id,
    depreciationExpenseAccountId: asset.native_expense_account_id,
  }, {
    assetAccountId: asset.asset_account_id,
    accumulatedDepreciationAccountId: asset.accumulated_depreciation_account_id,
    depreciationExpenseAccountId: asset.depreciation_expense_account_id,
  });
}

function assertLifecycleDate(date: string): void {
  if (!isIsoCalendarDate(date)) {
    throw new AssetLifecycleError("date must be a valid calendar date (YYYY-MM-DD)");
  }
}

/** Current carrying value cannot be used to post before the history it includes. */
export async function assertAssetPostingDate(
  tx: SqlExecutor,
  orgId: string,
  assetId: string,
  bookId: string,
  date: string,
): Promise<void> {
  const history = (
    await tx.execute<{
      acquired_on: string | null;
      depreciation_date: string | null;
      lifecycle_date: string | null;
    }>(sql`
    select asset.acquired_on::text,
           (select max(coalesce(entry.posting_date, period.ends_on))::text
              from depreciation_schedule_lines line
              join depreciation_schedules schedule on schedule.id = line.schedule_id and schedule.org_id = line.org_id
              join accounting_periods period on period.id = line.period_id and period.org_id = line.org_id
              left join journal_entries entry on entry.id = line.journal_entry_id and entry.org_id = line.org_id
             where schedule.asset_id = asset.id and schedule.org_id = asset.org_id
               and schedule.book_id = ${bookId} and line.posted_amount is not null) as depreciation_date,
           (select max(greatest(event.occurred_on, entry.posting_date))::text
              from asset_events event
              join journal_entries entry on entry.id = event.journal_entry_id and entry.org_id = event.org_id
             where event.asset_id = asset.id and event.org_id = asset.org_id
               and entry.status in ('posted', 'reversed')) as lifecycle_date
      from fixed_assets asset where asset.id = ${assetId} and asset.org_id = ${orgId}
  `)
  ).rows[0];
  if (!history) throw new AssetLifecycleError("asset not found");
  const changedBasis = (
    await tx.execute<{ date: string }>(
      sql`select max(effective_on)::text as date from asset_basis_changes where org_id=${orgId} and asset_id=${assetId} and book_id=${bookId}`,
    )
  ).rows[0]?.date;
  if (changedBasis && date < changedBasis)
    throw new AssetLifecycleError(
      `posting date cannot precede the approved asset basis change (${changedBasis})`,
    );
  for (const [source, boundary] of Object.entries(history)) {
    if (boundary !== null && date < boundary) {
      throw new AssetLifecycleError(
        `posting date cannot precede ${source.replaceAll("_", " ")} (${boundary})`,
      );
    }
  }
}

/** Validate new lifecycle legs under the same entity policy as native posting. */
export async function assertLifecyclePostingPolicy(
  tx: SqlExecutor,
  orgId: string,
  asset: {
    subsidiary_id: string;
    department_id: string | null;
    project_id: string | null;
    location_id: string | null;
  },
  lines: DisposalLine[],
): Promise<void> {
  const accountIds = [...new Set(lines.map((line) => line.accountId))];
  if (accountIds.length) {
    const accounts = (
      await tx.execute<{
        id: string;
        is_active: boolean;
        is_summary: boolean;
      }>(sql`
      select id, is_active, is_summary
        from accounts
       where org_id=${orgId}
         and id=any(${uuidArray(accountIds)}::uuid[])
       for share`)
    ).rows;
    const byId = new Map(accounts.map((account) => [account.id, account]));
    if (
      accountIds.some((id) => {
        const account = byId.get(id);
        return !account || !account.is_active || account.is_summary;
      })
    ) {
      throw new AssetLifecycleError(
        "asset posting requires active, non-summary accounts",
      );
    }
  }
  const dimensions = [
    { table: "departments", id: asset.department_id },
    { table: "projects", id: asset.project_id },
    { table: "locations", id: asset.location_id },
  ] as const;
  for (const dimension of dimensions) {
    if (!dimension.id) continue;
    await tx.execute(sql`select id from ${sql.raw(dimension.table)}
      where org_id=${orgId} and id=${dimension.id} for share`);
  }
  try {
    await validateSubsidiaryRestrictions(tx, {
      orgId,
      ctx: await loadSubsidiaryContext(tx, orgId),
      docSubsidiaryId: asset.subsidiary_id,
      lines: lines.map((line) => ({
        ...line,
        subsidiaryId: asset.subsidiary_id,
        departmentId: asset.department_id,
        projectId: asset.project_id,
        locationId: asset.location_id,
      })),
    });
  } catch (error) {
    if (error instanceof SubsidiaryError)
      throw new AssetLifecycleError(error.message);
    throw error;
  }
}

export interface DisposeResult {
  assetId: string;
  entryId: string;
  nbv: string;
  gainLoss: string;
  status: "disposed" | "written_off";
}

/**
 * Dispose an asset (sale or, with zero proceeds, a write-off): post the disposal
 * journal and flip the asset's status. Accumulated depreciation is taken as the
 * amount POSTED to date on the primary book.
 */
export async function disposeAsset(
  orgId: string,
  assetId: string,
  opts: {
    proceeds?: string;
    proceedsAccountId?: string | null;
    date: string;
    actorId: string | null;
    writeOff?: boolean;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<DisposeResult> {
  assertLifecycleDate(opts.date);
  // Fail closed on contradictory or impossible sale economics before touching
  // the database: a write-off takes no proceeds (the API coerces them to zero;
  // a direct caller passing both is a bug), and proceeds are never negative.
  const rawProceeds = opts.proceeds ?? "0";
  // A direct caller bypasses the route's format gate; junk would otherwise
  // die inside the money module with a raw Error instead of the domain
  // refusal. The write-off and negativity checks below assume exact input.
  if (canonicalDecimal(rawProceeds, 4) === null) {
    throw new AssetLifecycleError("proceeds must be an exact decimal");
  }
  if (opts.writeOff && !isZero(add(rawProceeds, "0"))) {
    throw new AssetLifecycleError(
      "a write-off takes no proceeds — omit proceeds or record a sale disposal",
    );
  }
  if (cmp(rawProceeds, "0") < 0) {
    throw new AssetLifecycleError("proceeds must be a non-negative amount");
  }
  const proceeds = opts.writeOff ? "0" : rawProceeds;
  assertLedgerMagnitude(add(proceeds, "0"), "proceeds");
  return db.transaction(async (tx) => {
    // Serialize disposal against remeasurement on the authoritative asset row.
    // This must precede every carrying-value read so a contender waits for the
    // prior mutation and then sees its committed schedule/event state.
    await lockAssetRow(tx, orgId, assetId, opts.allowedSubsidiaryIds);
    const bookId = await primaryBookId(orgId, tx);
    await tx.execute(
      sql`select id from subsidiaries where org_id=${orgId} order by id for share`,
    );
    await assertAssetPostingDate(tx, orgId, assetId, bookId, opts.date);

    const assetRes = await tx.execute<
      AssetAccountRow & {
        id: string;
        asset_number: string;
        status: string;
        subsidiary_id: string;
        acquisition_cost: string;
        department_id: string | null;
        project_id: string | null;
        location_id: string | null;
        base_currency: string;
        asset_account_id: string;
        accumulated_depreciation_account_id: string;
        gain_loss_account_id: string | null;
        accumulated: string;
        opening_accumulated_depreciation: string | null;
      }
    >(sql`
      select a.id, a.asset_number, a.status, a.subsidiary_id, a.acquisition_cost,
             a.department_id, a.project_id, a.location_id, sub.base_currency,
             a.asset_account_id as native_asset_account_id,
             a.accumulated_depreciation_account_id as native_accumulated_account_id,
             a.depreciation_expense_account_id as native_expense_account_id,
             a.opening_accumulated_depreciation::text as opening_accumulated_depreciation,
             c.asset_account_id, c.accumulated_depreciation_account_id,
             c.depreciation_expense_account_id, c.gain_loss_account_id,
             coalesce((select sum(l.posted_amount) from depreciation_schedule_lines l
                         join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id and s.book_id = ${bookId}
                        where l.org_id = a.org_id and s.asset_id = a.id and l.posted_amount is not null), 0)::text as accumulated
        from fixed_assets a
        join subsidiaries sub on sub.id = a.subsidiary_id and sub.org_id = a.org_id
        join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
       where a.org_id = ${orgId} and a.id = ${assetId}`);
    const asset = assetRes.rows[0];
    if (!asset) throw new AssetLifecycleError("asset not found");
    if (asset.status === "disposed" || asset.status === "written_off") {
      throw new AssetLifecycleError(
        `asset ${asset.asset_number} is already ${asset.status}`,
      );
    }
    if (!asset.gain_loss_account_id) {
      throw new AssetLifecycleError(
        "configure a gain/loss on disposal account on the asset category first",
      );
    }

    // SCHEDULE TIE — once depreciation posting has begun, the schedule is the
    // authoritative NBV trail: refuse while a planned-but-unposted line's
    // period has already begun by the disposal date. Booking NBV off
    // posted-to-date alone would silently skip the stub period's charge (a
    // mid-period disposal understates accumulated depreciation and misstates
    // the gain or loss, flipping its sign when the stub charge exceeds the
    // margin); posting the period first keeps the disposal tied to the
    // schedule. A disposal dated the first day of a period precedes any holding
    // in it, so the boundary itself stays open; and before anything is posted
    // there is no posted trail to leapfrog — NBV is cost plus explicit
    // remeasurements.
    const stub = await tx.execute<{ period_name: string }>(sql`
      select p.name as period_name
        from depreciation_schedule_lines l
        join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
        join accounting_periods p on p.id = l.period_id and p.org_id = l.org_id
       where l.org_id = ${orgId} and s.asset_id = ${assetId} and s.book_id = ${bookId}
         and l.posted_amount is null and p.starts_on < ${opts.date}
         and exists (
           select 1 from depreciation_schedule_lines posted
            join depreciation_schedules ps on ps.id = posted.schedule_id and ps.org_id = posted.org_id
            where posted.org_id = ${orgId} and ps.asset_id = ${assetId} and ps.book_id = ${bookId}
              and posted.posted_amount is not null
         )
       order by p.starts_on limit 1`);
    if (stub.rows[0]) {
      throw new AssetLifecycleError(
        `asset ${asset.asset_number} has unposted depreciation for period ${stub.rows[0].period_name} covering the disposal date — post the stub period's depreciation before disposing so the gain or loss ties to the schedule`,
      );
    }

    const basisChange = await assetBasisDelta(tx, orgId, assetId, bookId);
    asset.acquisition_cost = add(asset.acquisition_cost, basisChange.cost);
    asset.accumulated = add(asset.accumulated, basisChange.accumulated);
    const resolvedAccounts = lifecycleAccounts(asset);
    const accounts: DisposalAccounts = {
      assetAccountId: resolvedAccounts.assetAccountId,
      accumulatedDepreciationAccountId:
        resolvedAccounts.accumulatedDepreciationAccountId,
      gainLossAccountId: asset.gain_loss_account_id,
      proceedsAccountId: opts.proceedsAccountId,
    };
    // Impairments and revaluations sit on the accumulated-depreciation account
    // without schedule lines; fold them in so derecognition clears the account
    // exactly (an impaired asset must not strand its impairment credit).
    // Continue-from-accumulated (migration 0156): the opening figure is
    // pre-cutover depreciation on that same account — without it a mid-life
    // disposal would under-clear accumulated depreciation and misstate the
    // gain or loss by exactly the opening amount.
    const remeasureDelta = await netRemeasurementDelta(
      orgId,
      assetId,
      bookId,
      tx,
    );
    const effectiveAccumulated = sub(
      add(asset.accumulated, asset.opening_accumulated_depreciation ?? "0"),
      remeasureDelta,
    );
    const { nbv, gainLoss, lines } = computeDisposal({
      cost: asset.acquisition_cost,
      accumulated: effectiveAccumulated,
      proceeds,
      accounts,
    });

    await assertLifecyclePostingPolicy(tx, orgId, asset, lines);
    const status: "disposed" | "written_off" =
      opts.writeOff || isZero(proceeds) ? "written_off" : "disposed";

    // A disposal dated into a GL-closed period must refuse here — resolving
    // the period once also turns a dateless insert (null period_id) into a
    // named error instead of a raw constraint failure.
    const period = await tx.execute<{ id: string }>(sql`
      select id from accounting_periods where org_id = ${orgId} and not is_adjustment
       and starts_on <= ${opts.date} and ends_on >= ${opts.date} limit 1`);
    if (!period.rows[0])
      throw new AssetLifecycleError(`no accounting period covers ${opts.date}`);
    await assertAssetPeriodOpen(tx, {
      orgId,
      periodId: period.rows[0].id,
      bookId,
      subsidiaryIds: [asset.subsidiary_id],
    });

    const entryRes = await tx.execute<{ id: string }>(sql`
      insert into journal_entries
        (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
      values (${orgId}, ${bookId}, ${asset.subsidiary_id}, ${`DISP-${asset.asset_number}-${randomUUID()}`}, ${opts.date},
              (select id from accounting_periods where org_id = ${orgId} and not is_adjustment
                 and starts_on <= ${opts.date} and ends_on >= ${opts.date} limit 1),
              ${`${status === "written_off" ? "Write-off" : "Disposal"} — ${asset.asset_number}`},
              'draft', 'disposal', ${opts.actorId}, ${opts.actorId})
      returning id`);
    const eid = entryRes.rows[0]!.id;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
           department_id, project_id, location_id, memo)
        values (${orgId}, ${eid}, ${i + 1}, ${l.accountId}, ${asset.subsidiary_id}, ${l.amount},
                ${asset.base_currency}, ${l.amount}, 1, ${asset.department_id}, ${asset.project_id},
                ${asset.location_id}, ${`${status} ${asset.asset_number}`})`);
    }
    await tx.execute(
      sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${opts.actorId} where id = ${eid} and org_id = ${orgId}`,
    );
    await tx.execute(
      sql`update fixed_assets set status = ${status}, updated_at = now(), updated_by = ${opts.actorId} where id = ${assetId} and org_id = ${orgId}`,
    );
    await tx.execute(sql`
      insert into asset_events (org_id, asset_id, kind, occurred_on, amount, journal_entry_id, created_by, created_at)
      values (${orgId}, ${assetId}, ${status === "written_off" ? "written_off" : "disposed"}, ${opts.date}, ${proceeds}, ${eid}, ${opts.actorId}, clock_timestamp())`);
    return { assetId, entryId: eid, nbv, gainLoss, status };
  });
}

export interface RemeasureResult {
  assetId: string;
  entryId: string;
  delta: string;
  kind: "revalued" | "impaired";
  rebuiltLines: number;
}

export interface ReverseAssetEventResult {
  assetId: string;
  sourceEventId: string;
  reversalEventId: string;
  reversalEntryId: string;
  restoredStatus: "in_service" | "fully_depreciated" | null;
  created: boolean;
}

/**
 * Reverse the latest posted disposal or remeasurement without changing its
 * retained event or journal.  The reversal is an exact negated journal linked
 * through both journal_entries.reverses_entry_id and
 * asset_events.reverses_event_id.  Remeasurement reversals rebuild only the
 * still-unposted formula plan from the asset's original policy; posted
 * depreciation evidence remains untouched.
 */
export async function reverseAssetLifecycleEvent(
  orgId: string,
  eventId: string,
  opts: { date: string; actorId: string; reason: string },
): Promise<ReverseAssetEventResult> {
  const reason = opts.reason.trim();
  if (reason.length < 8 || reason.length > 500) {
    throw new AssetLifecycleError(
      "a reversal reason between 8 and 500 characters is required",
    );
  }
  if (!isIsoCalendarDate(opts.date)) {
    throw new AssetLifecycleError(
      "reversal date must be a valid calendar date in YYYY-MM-DD format",
    );
  }
  if (!opts.actorId) {
    throw new AssetLifecycleError("an attributable reversal actor is required");
  }

  return db.transaction(async (tx) => {
    const sourceResult = await tx.execute<{
      id: string;
      asset_id: string;
      kind: string;
      journal_entry_id: string;
      financial_change_id: string | null;
      created_at: string;
      asset_number: string;
      status: string;
      subsidiary_id: string;
      department_id: string | null;
      project_id: string | null;
      location_id: string | null;
      acquisition_cost: string;
      salvage_value: string;
      book_id: string;
      entry_number: string;
      origin: "disposal" | "revaluation";
      entry_status: string;
      occurred_on: string;
      posting_date: string;
    }>(sql`
      select event.id, event.asset_id, event.kind, event.journal_entry_id,event.financial_change_id,
             event.created_at::text as created_at, asset.asset_number, asset.status,
             asset.subsidiary_id, asset.acquisition_cost, asset.salvage_value,
             asset.department_id, asset.project_id, asset.location_id,
             entry.book_id, entry.entry_number, entry.origin, entry.status as entry_status,
             event.occurred_on::text as occurred_on, entry.posting_date::text as posting_date
        from asset_events event
        join fixed_assets asset
          on asset.id = event.asset_id and asset.org_id = event.org_id
        join journal_entries entry
          on entry.id = event.journal_entry_id and entry.org_id = event.org_id
       where event.id = ${eventId} and event.org_id = ${orgId}
       for update of event, asset, entry
    `);
    const source = sourceResult.rows[0];
    if (!source)
      throw new AssetLifecycleError("asset lifecycle event not found");

    if (source.financial_change_id)
      throw new AssetLifecycleError(
        "This event belongs to an approved multi-book change; reverse it from Accounting changes to preserve every book and transfer link.",
      );

    const prior = await tx.execute<{
      id: string;
      journal_entry_id: string;
      restored_status: "in_service" | "fully_depreciated" | null;
    }>(sql`
      select event.id, event.journal_entry_id,
             case
               when asset.status = 'fully_depreciated' then 'fully_depreciated'
               when asset.status = 'in_service' then 'in_service'
               else null
             end as restored_status
        from asset_events event
        join fixed_assets asset on asset.id = event.asset_id and asset.org_id = event.org_id
       where event.org_id = ${orgId}
         and event.reverses_event_id = ${source.id}
       limit 1
    `);
    if (prior.rows[0]) {
      return {
        assetId: source.asset_id,
        sourceEventId: source.id,
        reversalEventId: prior.rows[0].id,
        reversalEntryId: prior.rows[0].journal_entry_id,
        restoredStatus: prior.rows[0].restored_status,
        created: false,
      };
    }

    if (
      !["revalued", "impaired", "disposed", "written_off"].includes(source.kind)
    ) {
      throw new AssetLifecycleError(
        `${source.kind} asset events do not have a financial reversal workflow`,
      );
    }
    const basisBoundary = await assetBasisDelta(
      tx,
      orgId,
      source.asset_id,
      source.book_id,
    );
    if (basisBoundary.cutoff && basisBoundary.cutoff >= source.occurred_on)
      throw new AssetLifecycleError(
        "this event predates an approved asset basis change; record a new remeasurement against the remaining asset instead of restoring a disposed portion",
      );
    if (source.entry_status !== "posted") {
      throw new AssetLifecycleError(
        "the source asset journal is not an unreversed posted entry",
      );
    }
    if (opts.date < source.occurred_on || opts.date < source.posting_date) {
      throw new AssetLifecycleError(
        "the reversal date cannot be before the source asset event or journal date",
      );
    }
    // Preserve full PostgreSQL timestamp precision. Legacy equal-time sources
    // have ambiguous order and must not authorize an out-of-order reversal.
    const later = await tx.execute<{ kind: string }>(sql`
      select later.kind
        from asset_events later
       where later.org_id = ${orgId}
         and later.asset_id = ${source.asset_id}
         and later.id <> ${source.id}
         and later.reverses_event_id is null
         and later.created_at >= ${source.created_at}::timestamptz
         and not exists (
           select 1 from asset_events reversal
            where reversal.org_id = later.org_id and reversal.reverses_event_id = later.id
         )
       order by later.created_at
       limit 1
    `);
    if (later.rows[0]) {
      throw new AssetLifecycleError(
        `reverse the later ${later.rows[0].kind} asset event first`,
      );
    }
    const period = await tx.execute<{ id: string }>(sql`
      select id from accounting_periods
       where org_id = ${orgId} and not is_adjustment
         and starts_on <= ${opts.date} and ends_on >= ${opts.date}
       limit 1
    `);
    if (!period.rows[0]) {
      throw new AssetLifecycleError(`no accounting period covers ${opts.date}`);
    }

    const book = (
      await tx.execute<{ id: string }>(sql`
      select id
        from accounting_books
       where org_id = ${orgId} and id = ${source.book_id}
         and is_active and posts_gl
       for share
    `)
    ).rows[0];
    if (!book) {
      throw new AssetLifecycleError(
        "the source journal book is not active for posting",
      );
    }

    // A reversal is a new posting, not a privileged copy of historical
    // lines. Recheck the current legal-entity/account/dimension policy before
    // creating the compensating entry; setup may have been restricted since
    // the source event was posted.
    const sourceLines = (
      await tx.execute<{
        account_id: string;
        amount: string;
        subsidiary_id: string;
      }>(sql`
      select account_id, amount::text as amount, subsidiary_id
        from journal_lines
       where org_id = ${orgId} and entry_id = ${source.journal_entry_id}
       order by line_number
    `)
    ).rows;
    await assertLifecyclePostingPolicy(
      tx,
      orgId,
      source,
      sourceLines.map((line) => ({
        accountId: line.account_id,
        amount: line.amount,
      })),
    );

    // The reversal posts into the reversal date's period: judge every leg the
    // je_guard trigger would judge (header plus mirrored line subsidiaries).
    await assertAssetPeriodOpen(tx, {
      orgId,
      periodId: period.rows[0].id,
      bookId: source.book_id,
      subsidiaryIds: [
        ...new Set([
          source.subsidiary_id,
          ...sourceLines.map((line) => line.subsidiary_id),
        ]),
      ],
    });

    const reversalEntry = await tx.execute<{ id: string }>(sql`
      insert into journal_entries
        (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
         memo, status, origin, reverses_entry_id, created_by, updated_by)
      values
        (${orgId}, ${source.book_id}, ${source.subsidiary_id},
         ${`${source.entry_number}-REV`}, ${opts.date}, ${period.rows[0].id},
         ${`Reversal — ${reason}`}, 'draft', ${source.origin},
         ${source.journal_entry_id}, ${opts.actorId}, ${opts.actorId})
      returning id
    `);
    const reversalEntryId = reversalEntry.rows[0]!.id;
    await tx.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount,
         currency, txn_amount, fx_rate, memo, party_id, department_id,
         project_id, location_id, class_id, equipment_unit_id, payment_card_id,
           extra_dims, tax_code_id, quantity, unit, due_date, is_open_item,
           custom)
      select org_id, ${reversalEntryId}, line_number, account_id, subsidiary_id,
             -amount, currency, -txn_amount, fx_rate,
             ${`Reversal — ${reason}`}, party_id, department_id, project_id,
             location_id, class_id, equipment_unit_id, payment_card_id,
             extra_dims, tax_code_id,
             case when quantity is null then null else -quantity end,
             unit, null, false, custom
        from journal_lines
       where entry_id = ${source.journal_entry_id} and org_id = ${orgId}
       order by line_number
    `);
    await tx.execute(sql`
      update journal_entries
         set status = 'posted', posted_at = now(), posted_by = ${opts.actorId},
             updated_at = now(), updated_by = ${opts.actorId}
       where id = ${reversalEntryId} and org_id = ${orgId}
    `);
    await tx.execute(sql`
      update journal_entries
         set status = 'reversed', updated_at = now(), updated_by = ${opts.actorId}
       where id = ${source.journal_entry_id} and org_id = ${orgId}
    `);

    let restoredStatus: "in_service" | "fully_depreciated" | null = null;
    if (source.kind === "disposed" || source.kind === "written_off") {
      // Continue-from-accumulated (migration 0156): the restore threshold
      // compares TOTAL recognised depreciation — posted plus the pre-cutover
      // opening figure — against the depreciable basis.
      const depreciation = await tx.execute<{
        accumulated: string;
        opening: string;
      }>(sql`
        select coalesce(sum(line.posted_amount), 0)::text as accumulated,
               coalesce((select asset.opening_accumulated_depreciation
                           from fixed_assets asset
                          where asset.id = ${source.asset_id} and asset.org_id = ${orgId}), 0)::text as opening
          from depreciation_schedule_lines line
          join depreciation_schedules schedule
            on schedule.id = line.schedule_id and schedule.org_id = line.org_id
         where schedule.org_id = ${orgId}
           and schedule.asset_id = ${source.asset_id}
           and schedule.book_id = ${source.book_id}
      `);
      restoredStatus =
        toUnits(depreciation.rows[0]?.accumulated ?? "0") +
          toUnits(depreciation.rows[0]?.opening ?? "0") >=
        toUnits(source.acquisition_cost) - toUnits(source.salvage_value)
          ? "fully_depreciated"
          : "in_service";
      await tx.execute(sql`
        update fixed_assets
           set status = ${restoredStatus}, updated_at = now(),
               updated_by = ${opts.actorId}
         where id = ${source.asset_id} and org_id = ${orgId}
      `);
    }

    const reversalEvent = await tx.execute<{ id: string }>(sql`
      insert into asset_events
        (org_id, asset_id, kind, occurred_on, amount, journal_entry_id,
         reverses_event_id, reversal_reason, memo, created_by, updated_by, created_at)
      values
        (${orgId}, ${source.asset_id}, 'reversed', ${opts.date}, null,
         ${reversalEntryId}, ${source.id}, ${reason},
         ${`Reversal of ${source.kind} for ${source.asset_number}`},
         ${opts.actorId}, ${opts.actorId}, clock_timestamp())
      returning id
    `);

    if (source.kind === "revalued" || source.kind === "impaired") {
      await buildScheduleWithRunner(
        tx,
        source.asset_id,
        orgId,
        opts.actorId,
        source.book_id,
      );
    }
    await reconcileAssetDepreciationStatusWithRunner(
      tx,
      orgId,
      opts.actorId,
      source.asset_id,
    );
    if (restoredStatus !== null) {
      restoredStatus = (
        await tx.execute<{ status: "in_service" | "fully_depreciated" }>(sql`
        select status from fixed_assets where org_id = ${orgId} and id = ${source.asset_id}`)
      ).rows[0]!.status;
    }
    return {
      assetId: source.asset_id,
      sourceEventId: source.id,
      reversalEventId: reversalEvent.rows[0]!.id,
      reversalEntryId,
      restoredStatus,
      created: true,
    };
  });
}

/**
 * Revalue (write-up) or impair (write-down) an asset to a new carrying value:
 * post the adjustment through the kernel (origin='revaluation'), record the
 * event, and rebuild the remaining unposted schedule IN THE SAME TRANSACTION so
 * future depreciation runs off the new basis (straight-line over the remaining
 * periods) rather than double-counting the adjustment. A failure anywhere rolls
 * the journal, the event, and every rebuilt line back together — a posted
 * remeasurement can never sit on an old or partially rebuilt schedule.
 */
export async function remeasureAsset(
  orgId: string,
  assetId: string,
  opts: {
    newCarryingValue: string;
    date: string;
    actorId: string | null;
    allowedSubsidiaryIds?: readonly string[] | null;
  },
): Promise<RemeasureResult> {
  assertLifecycleDate(opts.date);
  // A recoverable amount is never negative — fail closed before touching the
  // database rather than posting an impairment that drives NBV below zero.
  // Junk would otherwise die inside the money module with a raw Error, and a
  // pasted 20-digit value would die at the journal insert with a storage
  // overflow; both refuse here as the domain error.
  if (canonicalDecimal(opts.newCarryingValue, 4) === null) {
    throw new AssetLifecycleError(
      "new carrying value must be an exact decimal",
    );
  }
  if (cmp(add(opts.newCarryingValue, "0"), "0") < 0) {
    throw new AssetLifecycleError(
      "new carrying value must be a non-negative amount",
    );
  }
  assertLedgerMagnitude(add(opts.newCarryingValue, "0"), "new carrying value");
  return db.transaction(async (tx) => {
    // Lock before reading any carrying-value input. A concurrent
    // remeasurement waits here, then its following SELECT sees the committed
    // event and schedule state from the transaction ahead of it.
    await lockAssetRow(tx, orgId, assetId, opts.allowedSubsidiaryIds);
    const bookId = await primaryBookId(orgId, tx);
    await tx.execute(
      sql`select id from subsidiaries where org_id=${orgId} order by id for share`,
    );
    await assertAssetPostingDate(tx, orgId, assetId, bookId, opts.date);

    const res = await tx.execute<
      AssetAccountRow & {
        asset_number: string;
        status: string;
        subsidiary_id: string;
        acquisition_cost: string;
        salvage_value: string;
        department_id: string | null;
        project_id: string | null;
        location_id: string | null;
        base_currency: string;
        accumulated_depreciation_account_id: string;
        gain_loss_account_id: string | null;
        accumulated: string;
        opening_accumulated_depreciation: string | null;
      }
    >(sql`
      select a.asset_number, a.status, a.subsidiary_id, a.acquisition_cost, a.salvage_value,
             a.department_id, a.project_id, a.location_id, sub.base_currency,
             a.asset_account_id as native_asset_account_id,
             a.accumulated_depreciation_account_id as native_accumulated_account_id,
             a.depreciation_expense_account_id as native_expense_account_id,
             a.opening_accumulated_depreciation::text as opening_accumulated_depreciation,
             c.asset_account_id, c.accumulated_depreciation_account_id,
             c.depreciation_expense_account_id, c.gain_loss_account_id,
             coalesce((select sum(l.posted_amount) from depreciation_schedule_lines l
                         join depreciation_schedules s on s.id = l.schedule_id and s.org_id = l.org_id and s.book_id = ${bookId}
                        where l.org_id = a.org_id and s.asset_id = a.id and l.posted_amount is not null), 0)::text as accumulated
        from fixed_assets a
        join subsidiaries sub on sub.id = a.subsidiary_id and sub.org_id = a.org_id
        join asset_categories c on c.id = a.category_id and c.org_id = a.org_id
       where a.org_id = ${orgId} and a.id = ${assetId}`);
    const asset = res.rows[0];
    if (!asset) throw new AssetLifecycleError("asset not found");
    if (asset.status === "disposed" || asset.status === "written_off") {
      throw new AssetLifecycleError(
        `asset ${asset.asset_number} is ${asset.status}`,
      );
    }
    if (!asset.gain_loss_account_id) {
      throw new AssetLifecycleError(
        "configure a gain/loss (adjustment) account on the asset category first",
      );
    }
    const basisChange = await assetBasisDelta(tx, orgId, assetId, bookId);
    asset.acquisition_cost = add(asset.acquisition_cost, basisChange.cost);
    asset.accumulated = add(asset.accumulated, basisChange.accumulated);
    const resolvedAccounts = lifecycleAccounts(asset);
    // Fold prior remeasurement events into the carrying amount: they credit
    // accumulated depreciation without schedule lines, so the schedule sum alone
    // overstates NBV the moment an asset has been impaired.
    // Continue-from-accumulated (migration 0156): same treatment for the
    // opening figure — an impairment must measure off the continued NBV.
    const remeasureDelta = await netRemeasurementDelta(
      orgId,
      assetId,
      bookId,
      tx,
    );
    const effectiveAccumulated = sub(
      add(asset.accumulated, asset.opening_accumulated_depreciation ?? "0"),
      remeasureDelta,
    );
    const { delta, lines } = computeRemeasurement({
      cost: asset.acquisition_cost,
      accumulated: effectiveAccumulated,
      newCarryingValue: opts.newCarryingValue,
      accumulatedDepreciationAccountId:
        resolvedAccounts.accumulatedDepreciationAccountId,
      adjustmentAccountId: asset.gain_loss_account_id,
    });
    if (isZero(delta))
      throw new AssetLifecycleError(
        "new carrying value equals current net book value",
      );

    // Framework gate: restoration of an impairment is prohibited under US GAAP
    // and capped under IAS 36. The rule reads the org's configured framework.
    const netImpairment = add(
      neg(remeasureDelta),
      neg(basisChange.impairmentReleased),
    );
    const unreversedImpairment =
      cmp(netImpairment, "0") > 0 ? netImpairment : "0";
    const framework = await orgReportingFramework(orgId);
    const policy = remeasurementPolicy({
      framework,
      delta,
      unreversedImpairment,
    });
    if (!policy.allowed) throw new AssetLifecycleError(policy.reason!);
    if (
      framework === "ifrs" &&
      cmp(delta, "0") > 0 &&
      cmp(unreversedImpairment, "0") > 0
    ) {
      const ceiling = await unimpairedAssetCarryingValue(
        tx,
        assetId,
        orgId,
        bookId,
        opts.date,
      );
      if (cmp(opts.newCarryingValue, ceiling) > 0) {
        throw new AssetLifecycleError(
          `IAS 36 caps an impairment reversal at the carrying amount without impairment, net of depreciation (${ceiling} as of ${opts.date})`,
        );
      }
    }

    await assertLifecyclePostingPolicy(tx, orgId, asset, lines);
    // Same companion as disposals: a remeasurement dated into a GL-closed
    // period refuses here, and a dateless insert becomes a named error.
    const remeasurePeriod = await tx.execute<{ id: string }>(sql`
      select id from accounting_periods where org_id = ${orgId} and not is_adjustment
       and starts_on <= ${opts.date} and ends_on >= ${opts.date} limit 1`);
    if (!remeasurePeriod.rows[0])
      throw new AssetLifecycleError(`no accounting period covers ${opts.date}`);
    await assertAssetPeriodOpen(tx, {
      orgId,
      periodId: remeasurePeriod.rows[0].id,
      bookId,
      subsidiaryIds: [asset.subsidiary_id],
    });
    const kind: "revalued" | "impaired" =
      cmp(delta, "0") < 0 ? "impaired" : "revalued";

    // An asset can be remeasured repeatedly; the entry number must be unique
    // per physical journal under journal_entries_org_number.
    const entryNumber = `${kind === "impaired" ? "IMPR" : "REVAL"}-${asset.asset_number}-${randomUUID().slice(0, 8)}`;
    const entryRes = await tx.execute<{ id: string }>(sql`
      insert into journal_entries
        (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
      values (${orgId}, ${bookId}, ${asset.subsidiary_id}, ${entryNumber},
              ${opts.date},
              (select id from accounting_periods where org_id = ${orgId} and not is_adjustment
                 and starts_on <= ${opts.date} and ends_on >= ${opts.date} limit 1),
              ${`${kind === "impaired" ? "Impairment" : "Revaluation"} — ${asset.asset_number}`},
              'draft', 'revaluation', ${opts.actorId}, ${opts.actorId})
      returning id`);
    const eid = entryRes.rows[0]!.id;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
           department_id, project_id, location_id, memo)
        values (${orgId}, ${eid}, ${i + 1}, ${l.accountId}, ${asset.subsidiary_id}, ${l.amount},
                ${asset.base_currency}, ${l.amount}, 1, ${asset.department_id}, ${asset.project_id},
                ${asset.location_id}, ${`${kind} ${asset.asset_number}`})`);
    }
    await tx.execute(
      sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${opts.actorId} where id = ${eid} and org_id = ${orgId}`,
    );
    await tx.execute(sql`
      insert into asset_events (org_id, asset_id, kind, occurred_on, amount, journal_entry_id, created_by, created_at)
      values (${orgId}, ${assetId}, ${kind}, ${opts.date}, ${delta}, ${eid}, ${opts.actorId}, clock_timestamp())`);

    // Use the same full-lifetime, effective-date plan as explicit rebuilds and
    // reversals, inside this journal/event transaction. Manual and usage input
    // evidence remains unchanged; only formula projections are recalculated.
    const rebuilt = await buildScheduleWithRunner(
      tx,
      assetId,
      orgId,
      opts.actorId,
      bookId,
    );
    await reconcileAssetDepreciationStatusWithRunner(
      tx,
      orgId,
      opts.actorId,
      assetId,
    );
    return {
      assetId,
      entryId: eid,
      delta,
      kind,
      rebuiltLines: rebuilt.lineCount,
    };
  });
}

/** One controlled kernel entry for an approved asset change. The caller owns
 * the asset/category locks and savepoint covering both entities and all books. */
export async function postAssetLifecycleEntry(
  tx: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    bookId: string;
    calendarId?: string;
    periodId?: string;
    date: string;
    number: string;
    memo: string;
    asset: {
      subsidiary_id: string;
      department_id: string | null;
      project_id: string | null;
      location_id: string | null;
    };
    currency: string;
    lines: DisposalLine[];
    origin?: "disposal" | "depreciation" | "intercompany" | "revaluation";
    reversesEntryId?: string;
  },
): Promise<string | null> {
  const lines = args.lines.filter((l) => !isZero(l.amount));
  if (!lines.length) return null;
  if (!isZero(lines.reduce((a, l) => add(a, l.amount), "0")))
    throw new AssetLifecycleError("asset change journal is unbalanced");
  await assertLifecyclePostingPolicy(tx, args.orgId, args.asset, lines);
  const periods = (
    await tx.execute<{ id: string }>(
      sql`select p.id from accounting_periods p join fiscal_calendars c on c.org_id=p.org_id and c.id=p.fiscal_calendar_id where p.org_id=${args.orgId} and c.is_active ${args.periodId ? sql`and p.id=${args.periodId}` : args.calendarId ? sql`and c.id=${args.calendarId}` : sql`and c.is_default`} and not p.is_adjustment and p.starts_on<=${args.date} and p.ends_on>=${args.date} for share of p,c`,
    )
  ).rows;
  if (periods.length !== 1)
    throw new AssetLifecycleError(
      `configure one accounting period in the asset book calendar covering ${args.date}`,
    );
  await assertAssetPeriodOpen(tx, {
    orgId: args.orgId,
    bookId: args.bookId,
    periodId: periods[0]!.id,
    subsidiaryIds: [args.asset.subsidiary_id],
  });
  const inserted = await tx.execute<{ id: string }>(
    sql`insert into journal_entries(org_id,book_id,subsidiary_id,entry_number,posting_date,period_id,memo,status,origin,reverses_entry_id,created_by,updated_by) values(${args.orgId},${args.bookId},${args.asset.subsidiary_id},${args.number},${args.date},${periods[0]!.id},${args.memo},'draft',${args.origin ?? "disposal"},${args.reversesEntryId ?? null},${args.actorId},${args.actorId}) returning id`,
  );
  if (inserted.rows.length !== 1)
    throw new AssetLifecycleError("asset change journal was not created");
  const id = inserted.rows[0]!.id;
  for (const [i, line] of lines.entries())
    await tx.execute(
      sql`insert into journal_lines(org_id,entry_id,line_number,account_id,subsidiary_id,amount,currency,txn_amount,fx_rate,department_id,project_id,location_id,memo) values(${args.orgId},${id},${i + 1},${line.accountId},${args.asset.subsidiary_id},${line.amount},${line.currency ?? args.currency},${line.txnAmount ?? line.amount},${line.fxRate ?? "1"},${args.asset.department_id},${args.asset.project_id},${args.asset.location_id},${args.memo})`,
    );
  const posted = await tx.execute(
    sql`update journal_entries set status='posted',posted_at=now(),posted_by=${args.actorId},updated_by=${args.actorId},updated_at=now() where org_id=${args.orgId} and id=${id} and status='draft' returning id`,
  );
  if (posted.rows.length !== 1)
    throw new AssetLifecycleError("asset change journal was not posted");
  return id;
}
