import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, fromUnits, isZero, neg, toUnits } from "./money.ts";

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
}

const sub = (a: string, b: string) => add(a, neg(b));

/**
 * Pure disposal arithmetic. NBV = cost − accumulated; gain/loss = proceeds − NBV
 * (positive = gain). Returns the balanced GL lines (zeros dropped). Pure, so the
 * accounting is unit-tested without a database.
 */
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

async function primaryBookId(orgId: string): Promise<string> {
  const r = (await db.execute(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary = true limit 1`)) as unknown as {
    rows: { id: string }[];
  };
  if (!r.rows[0]) throw new AssetLifecycleError("no primary accounting book");
  return r.rows[0].id;
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
  opts: { proceeds?: string; proceedsAccountId?: string | null; date: string; actorId: string | null; writeOff?: boolean },
): Promise<DisposeResult> {
  const bookId = await primaryBookId(orgId);
  const proceeds = opts.writeOff ? "0" : opts.proceeds ?? "0";

  const assetRes = (await db.execute(sql`
    select a.id, a.asset_number, a.status, a.subsidiary_id, a.acquisition_cost, a.custom,
           a.department_id, a.project_id, a.location_id, sub.base_currency,
           c.asset_account_id, c.accumulated_depreciation_account_id, c.gain_loss_account_id,
           coalesce((select sum(l.posted_amount) from depreciation_schedule_lines l
                       join depreciation_schedules s on s.id = l.schedule_id and s.book_id = ${bookId}
                      where s.asset_id = a.id and l.journal_entry_id is not null), 0)::text as accumulated
      from fixed_assets a
      join subsidiaries sub on sub.id = a.subsidiary_id
      join asset_categories c on c.id = a.category_id
     where a.org_id = ${orgId} and a.id = ${assetId}`)) as unknown as {
    rows: {
      id: string; asset_number: string; status: string; subsidiary_id: string; acquisition_cost: string;
      custom: Record<string, unknown> | null; department_id: string | null; project_id: string | null;
      location_id: string | null; base_currency: string; asset_account_id: string;
      accumulated_depreciation_account_id: string; gain_loss_account_id: string | null; accumulated: string;
    }[];
  };
  const asset = assetRes.rows[0];
  if (!asset) throw new AssetLifecycleError("asset not found");
  if (asset.status === "disposed" || asset.status === "written_off") {
    throw new AssetLifecycleError(`asset ${asset.asset_number} is already ${asset.status}`);
  }
  if (!asset.gain_loss_account_id) {
    throw new AssetLifecycleError("configure a gain/loss on disposal account on the asset category first");
  }

  const custom = (asset.custom?.accounts ?? {}) as Record<string, string | undefined>;
  const accounts: DisposalAccounts = {
    assetAccountId: custom.asset || asset.asset_account_id,
    accumulatedDepreciationAccountId: custom.accumulated || asset.accumulated_depreciation_account_id,
    gainLossAccountId: custom.gainLoss || asset.gain_loss_account_id,
    proceedsAccountId: opts.proceedsAccountId,
  };
  const { nbv, gainLoss, lines } = computeDisposal({
    cost: asset.acquisition_cost, accumulated: asset.accumulated, proceeds, accounts,
  });

  const status: "disposed" | "written_off" = opts.writeOff || isZero(proceeds) ? "written_off" : "disposed";

  const entryId = await db.transaction(async (tx) => {
    const entryRes = (await tx.execute(sql`
      insert into journal_entries
        (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
      values (${orgId}, ${bookId}, ${asset.subsidiary_id}, ${`DISP-${asset.asset_number}`}, ${opts.date},
              (select id from accounting_periods where org_id = ${orgId} and not is_adjustment
                 and starts_on <= ${opts.date} and ends_on >= ${opts.date} limit 1),
              ${`${status === "written_off" ? "Write-off" : "Disposal"} — ${asset.asset_number}`},
              'draft', 'disposal', ${opts.actorId}, ${opts.actorId})
      returning id`)) as unknown as { rows: { id: string }[] };
    const eid = entryRes.rows[0].id;
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
    await tx.execute(sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${opts.actorId} where id = ${eid}`);
    await tx.execute(sql`update fixed_assets set status = ${status}, updated_at = now(), updated_by = ${opts.actorId} where id = ${assetId}`);
    await tx.execute(sql`
      insert into asset_events (org_id, asset_id, kind, event_date, amount, journal_entry_id, created_by)
      values (${orgId}, ${assetId}, ${status === "written_off" ? "written_off" : "disposed"}, ${opts.date}, ${proceeds}, ${eid}, ${opts.actorId})`);
    return eid;
  });

  return { assetId, entryId, nbv, gainLoss, status };
}

export interface RemeasureResult {
  assetId: string;
  entryId: string;
  delta: string;
  kind: "revalued" | "impaired";
  rebuiltLines: number;
}

/**
 * Revalue (write-up) or impair (write-down) an asset to a new carrying value:
 * post the adjustment through the kernel (origin='revaluation'), record the
 * event, and rebuild the remaining unposted schedule so future depreciation runs
 * off the new basis (straight-line over the remaining periods) rather than
 * double-counting the adjustment.
 */
export async function remeasureAsset(
  orgId: string,
  assetId: string,
  opts: { newCarryingValue: string; date: string; actorId: string | null },
): Promise<RemeasureResult> {
  const bookId = await primaryBookId(orgId);
  const res = (await db.execute(sql`
    select a.asset_number, a.status, a.subsidiary_id, a.acquisition_cost, a.salvage_value, a.custom,
           a.department_id, a.project_id, a.location_id, sub.base_currency,
           c.accumulated_depreciation_account_id, c.gain_loss_account_id,
           coalesce((select sum(l.posted_amount) from depreciation_schedule_lines l
                       join depreciation_schedules s on s.id = l.schedule_id and s.book_id = ${bookId}
                      where s.asset_id = a.id and l.journal_entry_id is not null), 0)::text as accumulated
      from fixed_assets a
      join subsidiaries sub on sub.id = a.subsidiary_id
      join asset_categories c on c.id = a.category_id
     where a.org_id = ${orgId} and a.id = ${assetId}`)) as unknown as {
    rows: {
      asset_number: string; status: string; subsidiary_id: string; acquisition_cost: string; salvage_value: string;
      custom: Record<string, unknown> | null; department_id: string | null; project_id: string | null;
      location_id: string | null; base_currency: string; accumulated_depreciation_account_id: string;
      gain_loss_account_id: string | null; accumulated: string;
    }[];
  };
  const asset = res.rows[0];
  if (!asset) throw new AssetLifecycleError("asset not found");
  if (asset.status === "disposed" || asset.status === "written_off") {
    throw new AssetLifecycleError(`asset ${asset.asset_number} is ${asset.status}`);
  }
  if (!asset.gain_loss_account_id) {
    throw new AssetLifecycleError("configure a gain/loss (adjustment) account on the asset category first");
  }
  const custom = (asset.custom?.accounts ?? {}) as Record<string, string | undefined>;
  const { delta, lines } = computeRemeasurement({
    cost: asset.acquisition_cost,
    accumulated: asset.accumulated,
    newCarryingValue: opts.newCarryingValue,
    accumulatedDepreciationAccountId: custom.accumulated || asset.accumulated_depreciation_account_id,
    adjustmentAccountId: custom.gainLoss || asset.gain_loss_account_id,
  });
  if (isZero(delta)) throw new AssetLifecycleError("new carrying value equals current net book value");
  const kind: "revalued" | "impaired" = cmp(delta, "0") < 0 ? "impaired" : "revalued";

  const entryId = await db.transaction(async (tx) => {
    const entryRes = (await tx.execute(sql`
      insert into journal_entries
        (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
      values (${orgId}, ${bookId}, ${asset.subsidiary_id}, ${`${kind === "impaired" ? "IMPR" : "REVAL"}-${asset.asset_number}`},
              ${opts.date},
              (select id from accounting_periods where org_id = ${orgId} and not is_adjustment
                 and starts_on <= ${opts.date} and ends_on >= ${opts.date} limit 1),
              ${`${kind === "impaired" ? "Impairment" : "Revaluation"} — ${asset.asset_number}`},
              'draft', 'revaluation', ${opts.actorId}, ${opts.actorId})
      returning id`)) as unknown as { rows: { id: string }[] };
    const eid = entryRes.rows[0].id;
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
    await tx.execute(sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${opts.actorId} where id = ${eid}`);
    await tx.execute(sql`
      insert into asset_events (org_id, asset_id, kind, event_date, amount, journal_entry_id, created_by)
      values (${orgId}, ${assetId}, ${kind}, ${opts.date}, ${delta}, ${eid}, ${opts.actorId})`);
    return eid;
  });

  // Rebuild remaining unposted lines: straight-line (newCV − salvage) over them.
  const remaining = (await db.execute(sql`
    select l.id from depreciation_schedule_lines l
      join depreciation_schedules s on s.id = l.schedule_id and s.book_id = ${bookId}
     where l.org_id = ${orgId} and s.asset_id = ${assetId} and l.journal_entry_id is null
     order by l.sequence`)) as unknown as { rows: { id: string }[] };
  const count = remaining.rows.length;
  let rebuilt = 0;
  if (count > 0) {
    const depreciable = toUnits(add(opts.newCarryingValue, neg(asset.salvage_value)));
    const per = depreciable > 0n ? depreciable / BigInt(count) : 0n;
    let allocated = 0n;
    for (let i = 0; i < count; i++) {
      const amt = i === count - 1 ? depreciable - allocated : per;
      allocated += amt;
      await db.execute(sql`update depreciation_schedule_lines set planned_amount = ${fromUnits(amt < 0n ? 0n : amt)}, updated_at = now(), updated_by = ${opts.actorId} where id = ${remaining.rows[i]!.id}`);
      rebuilt++;
    }
  }

  return { assetId, entryId, delta, kind, rebuiltLines: rebuilt };
}
