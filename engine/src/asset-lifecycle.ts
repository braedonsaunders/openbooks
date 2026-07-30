import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { buildScheduleWithRunner } from "./depreciation.ts";
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
                      where s.asset_id = a.id and l.posted_amount is not null), 0)::text as accumulated
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
      insert into asset_events (org_id, asset_id, kind, occurred_on, amount, journal_entry_id, created_by)
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) {
    throw new AssetLifecycleError("reversal date must be YYYY-MM-DD");
  }
  if (!opts.actorId) {
    throw new AssetLifecycleError("an attributable reversal actor is required");
  }

  return db.transaction(async (tx) => {
    const sourceResult = (await tx.execute(sql`
      select event.id, event.asset_id, event.kind, event.journal_entry_id,
             event.created_at, asset.asset_number, asset.status,
             asset.subsidiary_id, asset.acquisition_cost, asset.salvage_value,
             entry.book_id, entry.entry_number, entry.origin, entry.status as entry_status
        from asset_events event
        join fixed_assets asset
          on asset.id = event.asset_id and asset.org_id = event.org_id
        join journal_entries entry
          on entry.id = event.journal_entry_id and entry.org_id = event.org_id
       where event.id = ${eventId} and event.org_id = ${orgId}
       for update of event, asset, entry
    `)) as unknown as {
      rows: Array<{
        id: string;
        asset_id: string;
        kind: string;
        journal_entry_id: string;
        created_at: string;
        asset_number: string;
        status: string;
        subsidiary_id: string;
        acquisition_cost: string;
        salvage_value: string;
        book_id: string;
        entry_number: string;
        origin: "disposal" | "revaluation";
        entry_status: string;
      }>;
    };
    const source = sourceResult.rows[0];
    if (!source) throw new AssetLifecycleError("asset lifecycle event not found");

    const prior = (await tx.execute(sql`
      select event.id, event.journal_entry_id,
             case
               when asset.status = 'fully_depreciated' then 'fully_depreciated'
               when asset.status = 'in_service' then 'in_service'
               else null
             end as restored_status
        from asset_events event
        join fixed_assets asset on asset.id = event.asset_id
       where event.org_id = ${orgId}
         and event.reverses_event_id = ${source.id}
       limit 1
    `)) as unknown as {
      rows: Array<{
        id: string;
        journal_entry_id: string;
        restored_status: "in_service" | "fully_depreciated" | null;
      }>;
    };
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
      !["revalued", "impaired", "disposed", "written_off"].includes(
        source.kind,
      )
    ) {
      throw new AssetLifecycleError(
        `${source.kind} asset events do not have a financial reversal workflow`,
      );
    }
    if (source.entry_status !== "posted") {
      throw new AssetLifecycleError(
        "the source asset journal is not an unreversed posted entry",
      );
    }
    const later = (await tx.execute(sql`
      select kind
        from asset_events
       where org_id = ${orgId}
         and asset_id = ${source.asset_id}
         and id <> ${source.id}
         and reverses_event_id is null
         and created_at > ${source.created_at}
       order by created_at
       limit 1
    `)) as unknown as { rows: { kind: string }[] };
    if (later.rows[0]) {
      throw new AssetLifecycleError(
        `reverse the later ${later.rows[0].kind} asset event first`,
      );
    }
    const period = (await tx.execute(sql`
      select id from accounting_periods
       where org_id = ${orgId} and not is_adjustment
         and starts_on <= ${opts.date} and ends_on >= ${opts.date}
       limit 1
    `)) as unknown as { rows: { id: string }[] };
    if (!period.rows[0]) {
      throw new AssetLifecycleError(
        `no accounting period covers ${opts.date}`,
      );
    }

    const reversalEntry = (await tx.execute(sql`
      insert into journal_entries
        (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
         memo, status, origin, reverses_entry_id, created_by, updated_by)
      values
        (${orgId}, ${source.book_id}, ${source.subsidiary_id},
         ${`${source.entry_number}-REV`}, ${opts.date}, ${period.rows[0].id},
         ${`Reversal — ${reason}`}, 'draft', ${source.origin},
         ${source.journal_entry_id}, ${opts.actorId}, ${opts.actorId})
      returning id
    `)) as unknown as { rows: { id: string }[] };
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
       where entry_id = ${source.journal_entry_id}
       order by line_number
    `);
    await tx.execute(sql`
      update journal_entries
         set status = 'posted', posted_at = now(), posted_by = ${opts.actorId},
             updated_at = now(), updated_by = ${opts.actorId}
       where id = ${reversalEntryId}
    `);
    await tx.execute(sql`
      update journal_entries
         set status = 'reversed', updated_at = now(), updated_by = ${opts.actorId}
       where id = ${source.journal_entry_id}
    `);

    let restoredStatus: "in_service" | "fully_depreciated" | null = null;
    if (source.kind === "disposed" || source.kind === "written_off") {
      const depreciation = (await tx.execute(sql`
        select coalesce(sum(line.posted_amount), 0)::text as accumulated
          from depreciation_schedule_lines line
          join depreciation_schedules schedule
            on schedule.id = line.schedule_id
         where schedule.asset_id = ${source.asset_id}
           and schedule.book_id = ${source.book_id}
      `)) as unknown as { rows: { accumulated: string }[] };
      restoredStatus =
        toUnits(depreciation.rows[0]?.accumulated ?? "0") >=
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

    const reversalEvent = (await tx.execute(sql`
      insert into asset_events
        (org_id, asset_id, kind, occurred_on, amount, journal_entry_id,
         reverses_event_id, reversal_reason, memo, created_by, updated_by)
      values
        (${orgId}, ${source.asset_id}, 'reversed', ${opts.date}, null,
         ${reversalEntryId}, ${source.id}, ${reason},
         ${`Reversal of ${source.kind} for ${source.asset_number}`},
         ${opts.actorId}, ${opts.actorId})
      returning id
    `)) as unknown as { rows: { id: string }[] };

    if (source.kind === "revalued" || source.kind === "impaired") {
      await buildScheduleWithRunner(
        tx,
        source.asset_id,
        orgId,
        opts.actorId,
        source.book_id,
      );
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
                      where s.asset_id = a.id and l.posted_amount is not null), 0)::text as accumulated
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
      insert into asset_events (org_id, asset_id, kind, occurred_on, amount, journal_entry_id, created_by)
      values (${orgId}, ${assetId}, ${kind}, ${opts.date}, ${delta}, ${eid}, ${opts.actorId})`);
    return eid;
  });

  // Rebuild remaining unposted lines: straight-line (newCV − salvage) over them.
  const remaining = (await db.execute(sql`
    select l.id from depreciation_schedule_lines l
      join depreciation_schedules s on s.id = l.schedule_id and s.book_id = ${bookId}
     where l.org_id = ${orgId} and s.asset_id = ${assetId} and l.posted_amount is null
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
