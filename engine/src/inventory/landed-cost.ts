import { reverseInventoryJournal } from "./reversal.ts";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp, fromUnits, isZero, neg, sum, toUnits } from "../money/money.ts";
import { extendCost } from "./costing.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import { InventoryError, type InventoryProfile } from "./contracts.ts";
import { assertStockLocationAdmitsSubsidiary, resolveProfile, assertMovementOwner, assertInventoryFeature } from "./profile-policy.ts";
import { stockLocationDim, postInventoryEntry, inventoryOffsetAccountProblem, type JournalLineInput } from "./journal.ts";
import { primaryBookId, periodForDate, subsidiaryCurrency, lockInventoryPosition, persistReceiptMoney, assertInventoryDate } from "./position.ts";
import { revalueLayerExactly, devalueLayerExactly, apportionUnits, type RevaluableLayer } from "./revaluation.ts";
import { nextSequenceNumber } from "./document-numbering.ts";

// ---------------------------------------------------------------------------
// Landed cost vouchers — one freight/duty amount spread across many targets
// ---------------------------------------------------------------------------

export interface LandedCostVoucherTargetInput {
  itemId: string;
  stockLocationId: string;
  /** basis 'manual': the exact amount this target receives. */
  manualAmount?: string | null;
}

export interface PostLandedCostVoucherInput {
  amount: string;
  basis: "value" | "quantity" | "weight" | "manual";
  freightAccountId: string;
  subsidiaryId: string;
  voucherDate: string;
  sourceDocumentLineId?: string | null;
  memo?: string | null;
  targets: LandedCostVoucherTargetInput[];
}
type OpenLayer = RevaluableLayer;

/** The apportionment weight of one target's on-hand layers under a basis. */
function layerWeights(
  layers: OpenLayer[],
  basis: "value" | "quantity" | "weight",
  weightsByLayer?: Map<string, string>,
): string[] {
  return layers.map((l) => {
    if (basis === "quantity") return l.remaining_quantity;
    if (basis === "weight") {
      // Fail closed: a missing weight row must never price as zero. Callers
      // refuse with item/location/layer identifiers before reaching here.
      const w = weightsByLayer?.get(l.id);
      if (w === undefined)
        throw new InventoryError(
          `weight-basis landed cost refused: layer ${l.id} has no weight row — choose a value, quantity, or manual basis instead`,
        );
      return extendCost(l.remaining_quantity, w);
    }
    return extendCost(l.remaining_quantity, l.unit_cost);
  });
}

/**
 * Capitalize one freight/duty amount across several item+location targets.
 * Shares are apportioned by the basis (value, quantity, layer weight, or
 * explicit manual amounts that must sum to the total); each target's share
 * bumps its open cost layers — or, under standard costing, books to the
 * item's variance account leaving its standard layers untouched — and ONE
 * balanced entry posts DR each target's inventory (or variance) / CR the
 * freight account.
 */
export async function postLandedCostVoucher(
  orgId: string,
  actorId: string | null,
  input: PostLandedCostVoucherInput,
): Promise<{ id: string; documentNumber: string; entryId: string }> {
  if (cmp(input.amount, "0") <= 0)
    throw new InventoryError("landed cost amount must be positive");
  if (!input.targets?.length)
    throw new InventoryError("landed cost voucher needs at least one target");
  const periodId = await periodForDate(orgId, input.voucherDate);
  if (!periodId)
    throw new InventoryError(`no accounting period for ${input.voucherDate}`);
  const ctx = await loadSubsidiaryContext(db, orgId);
  assertMovementOwner(ctx, input.subsidiaryId);

  const targetKeys = input.targets.map(
    (target) => `${target.itemId}:${target.stockLocationId}`,
  );
  if (new Set(targetKeys).size !== targetKeys.length) {
    throw new InventoryError(
      "landed cost voucher targets must be unique by item and stock location",
    );
  }

  return db.transaction(async (tx) => {
    await assertInventoryFeature(tx, orgId);
    for (const key of [...targetKeys].sort()) {
      const separator = key.indexOf(":");
      await lockInventoryPosition(
        tx,
        key.slice(0, separator),
        key.slice(separator + 1),
      );
    }

    // Resolve and lock layers only after every target position is serialized,
    // so allocation weights and the revaluation commit from one snapshot.
    const resolved: {
      target: LandedCostVoucherTargetInput;
      profile: InventoryProfile;
      layers: OpenLayer[];
      shareWeight: string;
      manualAmount: string | null;
      weightsByLayer: Map<string, string> | undefined;
    }[] = [];
    for (const target of input.targets) {
      const profile = await resolveProfile(orgId, target.itemId, tx, true);
      await assertStockLocationAdmitsSubsidiary(
        tx,
        orgId,
        ctx,
        target.stockLocationId,
        input.subsidiaryId,
      );
      // Capitalize only onto the voucher entity's own layers — freight on
      // another legal entity's stock is another form of taking its value.
      const layers = (
        (await tx.execute<OpenLayer>(sql`
        select id, subsidiary_id, source_movement_id, received_at::text, original_quantity,
               remaining_quantity, unit_cost, remaining_original_cost
          from cost_layers
         where org_id = ${orgId} and item_id = ${target.itemId}
           and stock_location_id = ${target.stockLocationId}
           and subsidiary_id = ${input.subsidiaryId}
           and remaining_quantity > 0
         order by received_at, id
         for update`))
      ).rows;
    if (layers.length === 0) {
      throw new InventoryError(
        `no on-hand layers for item ${target.itemId} at location ${target.stockLocationId}`,
      );
    }
    const manualAmount = target.manualAmount ?? null;
    let shareWeight = "0";
    let weightsByLayer: Map<string, string> | undefined;
    if (input.basis === "manual") {
      if (!manualAmount || cmp(manualAmount, "0") <= 0) {
        throw new InventoryError(
          "manual-basis vouchers require a positive manual amount per target",
        );
      }
    } else {
      // Weight evidence is loaded once per target, inside this transaction
      // after the layer locks, and the same map serves both the target share
      // and the later per-layer sub-apportionment — one read per financial
      // decision, no second query after mutations begin.
      if (input.basis === "weight") {
        weightsByLayer = new Map();
        const w = (await tx.execute<{ cost_layer_id: string; weight: string }>(sql`
          select cost_layer_id, weight from cost_layer_weights
           where org_id = ${orgId} and cost_layer_id in (${joinIds(layers.map((l) => l.id))})`));
        for (const row of w.rows)
          weightsByLayer.set(row.cost_layer_id, row.weight);
        // Narrow once for the closure below: the map is fully loaded here.
        const loadedWeights = weightsByLayer;
        // An absent weight row is unconfigured input, not zero: refusing by
        // name beats accruing zero. An explicit zero row (weight '0') is a
        // configured value and keeps its existing meaning — it contributes
        // no share, and an all-zero target still hits the no-basis refusal
        // below. There is no supported production writer for weight rows,
        // so the remedy names the bases the operator can choose instead.
        const missing = layers
          .filter((l) => !loadedWeights.has(l.id))
          .map((l) => l.id);
        if (missing.length > 0) {
          throw new InventoryError(
            `weight-basis landed cost refused: item ${target.itemId} at location ${target.stockLocationId} has ${missing.length} on-hand layer(s) without a weight (layer ${missing.join(", ")}) — choose a value, quantity, or manual basis instead`,
          );
        }
      }
      const weights = layerWeights(layers, input.basis, weightsByLayer);
      shareWeight = sum(weights);
      if (isZero(shareWeight)) {
        throw new InventoryError(
          `target item ${target.itemId} has no ${input.basis} basis to apportion on`,
        );
      }
    }
    resolved.push({ target, profile, layers, shareWeight, manualAmount, weightsByLayer });
    }

    const shares =
      input.basis === "manual"
        ? resolved.map((r) => toUnits(r.manualAmount!))
        : apportionUnits(
            toUnits(input.amount),
            resolved.map((r) => r.shareWeight),
          );
    const shareTotal = fromUnits(shares.reduce((a, b) => a + b, 0n));
    if (cmp(shareTotal, input.amount) !== 0) {
      throw new InventoryError(
        input.basis === "manual"
          ? `manual target amounts (${shareTotal}) must sum to the voucher amount (${input.amount})`
          : "apportionment failed",
      );
    }
    // A standard-cost target books its share as a variance; with no variance
    // account configured the share would land on the asset account itself,
    // quietly absorbing freight into inventory and breaking GL = layers.
    // Refuse before any layer, voucher, or journal mutation.
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i]!;
      if (shares[i] !== 0n) {
        const accountProblem = inventoryOffsetAccountProblem(r.profile.assetAccountId, input.freightAccountId, "freight offset")
          ?? (r.profile.costingMethod === "standard"
            ? inventoryOffsetAccountProblem(r.profile.assetAccountId, r.profile.varianceAccountId, "variance") : null);
        if (accountProblem) throw new InventoryError(accountProblem);
      }
      if (
        shares[i] !== 0n &&
        r.profile.costingMethod === "standard" &&
        !r.profile.varianceAccountId
      ) {
        throw new InventoryError(
          `landed cost on standard-cost item ${r.target.itemId} requires a variance account to book the variance — configure one; booking it on the asset account itself would post a self-cancelling entry and break GL = cost layers`,
        );
      }
    }

    const documentNumber = await nextSequenceNumber(
      orgId,
      "landed_cost_voucher",
      "LCV-",
      tx,
    );
    const bookId = await primaryBookId(orgId, tx);
    const currency = await subsidiaryCurrency(
      orgId,
      input.subsidiaryId,
      tx,
    );
    const voucherAmount = persistReceiptMoney(input.amount, "landed cost amount");
    const voucher = (await tx.execute<{ id: string }>(sql`
      insert into landed_cost_vouchers
        (org_id, document_number, status, amount, basis, freight_account_id, source_document_line_id,
         subsidiary_id, voucher_date, memo, created_by, updated_by)
      values (${orgId}, ${documentNumber}, 'draft', ${voucherAmount}, ${input.basis}, ${input.freightAccountId},
              ${input.sourceDocumentLineId ?? null}, ${input.subsidiaryId}, ${input.voucherDate},
              ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`));
    const voucherId = voucher.rows[0]!.id;

    const entryLines: JournalLineInput[] = [];
    const allocationIds: string[] = [];
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i]!;
      const share = shares[i]!;
      const shareAmount = fromUnits(share);
      const manualAmount =
        r.manualAmount == null ? null : persistReceiptMoney(r.manualAmount, "landed cost target amount");
      await tx.execute(sql`
        insert into landed_cost_voucher_targets
          (org_id, voucher_id, item_id, stock_location_id, manual_amount, allocated_amount, created_by, updated_by)
        values (${orgId}, ${voucherId}, ${r.target.itemId}, ${r.target.stockLocationId},
                ${manualAmount}, ${shareAmount}, ${actorId}, ${actorId})`);
      if (share === 0n) continue;

      if (r.profile.costingMethod === "standard") {
        // Landed cost on a standard-cost item is a variance against the policy
        // that governs its layers — never a silent layer revaluation. Layers
        // must keep carrying exactly the item's standard so a later issue
        // relieves them to zero instead of stranding residual inventory value
        // in the GL. The allocation anchors to an open layer as evidence only;
        // `basis = 'standard_variance'` marks that no layer value moved, so a
        // reversal mirrors the journal without devaluing anything.
        const allocationId = randomUUID();
        allocationIds.push(allocationId);
        await tx.execute(sql`
          insert into landed_cost_allocations
            (id, org_id, voucher_id, source_document_line_id, target_cost_layer_id,
             basis, amount, journal_entry_id, created_by, updated_by)
          values
            (${allocationId}, ${orgId}, ${voucherId}, ${input.sourceDocumentLineId ?? null},
             ${r.layers[0]!.id}, 'standard_variance', ${shareAmount}, null,
             ${actorId}, ${actorId})`);
      } else {
        // Sub-apportion the share across the target's own layers on the same
        // basis, reusing the weight evidence loaded before any mutation —
        // the decision and its execution read the same snapshot.
        const weightsByLayer = r.weightsByLayer;
        // A manual share is the operator's explicit amount for this target;
        // it spreads across the target's layers pro rata to carrying value.
        // Layers received free of charge carry none, so a target that is
        // entirely zero-value spreads its share pro rata to quantity instead
        // (exactly what the quantity basis does for the same stock). Value
        // apportionment onto a valueless target would allocate nothing and
        // leave the asset debit with no layer behind it.
        let subWeights = layerWeights(
          r.layers,
          input.basis === "manual" ? "value" : input.basis,
          weightsByLayer,
        );
        if (input.basis === "manual" && isZero(sum(subWeights))) {
          subWeights = layerWeights(r.layers, "quantity");
        }
        const subShares = apportionUnits(share, subWeights);
        // Every unit of the target's share must land on a layer before the
        // matching asset debit is written: GL = Σ layers is the invariant
        // the voucher exists to keep, and the reversal needs the evidence.
        if (subShares.reduce((a, b) => a + b, 0n) !== share) {
          throw new InventoryError(
            `landed cost share ${shareAmount} for item ${r.target.itemId} at location ${r.target.stockLocationId} cannot be apportioned across its on-hand layers on the ${input.basis} basis`,
          );
        }
        for (let j = 0; j < r.layers.length; j++) {
          const layerShare = subShares[j]!;
          if (layerShare === 0n) continue;
          const fragments = await revalueLayerExactly(
            tx,
            orgId,
            r.layers[j]!,
            layerShare,
            actorId,
            r.profile.costingMethod !== "moving_average",
          );
          for (const fragment of fragments) {
            const allocationId = randomUUID();
            allocationIds.push(allocationId);
            await tx.execute(sql`
              insert into landed_cost_allocations
                (id, org_id, voucher_id, source_document_line_id, target_cost_layer_id,
                 basis, amount, journal_entry_id, created_by, updated_by)
              values
                (${allocationId}, ${orgId}, ${voucherId}, ${input.sourceDocumentLineId ?? null},
                 ${fragment.layerId}, ${input.basis}, ${fragment.amount}, null,
                 ${actorId}, ${actorId})`);
          }
        }
      }
      // Each target capitalizes at its own stock location, so each leg carries
      // that stock location's business location — otherwise location-sliced
      // statements could not tie a location's inventory GL to its layers.
      const targetLocationId = await stockLocationDim(tx, orgId, r.target.stockLocationId, null);
      entryLines.push({
        accountId:
          r.profile.costingMethod === "standard"
            ? r.profile.varianceAccountId!
            : r.profile.assetAccountId,
        amount: shareAmount,
        locationId: targetLocationId,
        memo: input.memo ?? `Landed cost ${documentNumber}`,
      });
      // The freight offset splits across the same targets, so every leg of
      // the entry stays location-stamped even for multi-location vouchers.
      // Target shares apportion the voucher amount exactly, hence so do these.
      entryLines.push({
        accountId: input.freightAccountId,
        amount: neg(shareAmount),
        locationId: targetLocationId,
        memo: input.memo ?? `Landed cost ${documentNumber}`,
      });
    }

    const entryId = await postInventoryEntry(tx, {
      orgId,
      bookId,
      subsidiaryId: input.subsidiaryId,
      actorId,
      currency,
      periodId,
      date: input.voucherDate,
      entryNumber: `INV-LCV-${documentNumber}`,
      memo: input.memo ?? `Landed cost voucher ${documentNumber}`,
      lines: entryLines,
    });
    await tx.execute(sql`
      update landed_cost_allocations set journal_entry_id = ${entryId}
       where org_id = ${orgId}
         and id in (${joinIds(allocationIds)})`);
    await tx.execute(sql`
      update landed_cost_vouchers set status = 'posted', journal_entry_id = ${entryId}, updated_at = now(), updated_by = ${actorId}
       where id = ${voucherId} and org_id = ${orgId}`);
    return { id: voucherId, documentNumber, entryId };
  });
}

export interface ReverseLandedCostVoucherInput {
  voucherId: string;
  reversalDate: string;
  reason: string;
}

export interface ReverseLandedCostVoucherResult {
  voucherId: string;
  entryId: string;
  alreadyReversed: boolean;
  reversedAllocations: number;
}

/**
 * Cancel a posted landed-cost voucher by removing each exact allocation from
 * untouched layers, appending negative allocation evidence, and mirroring the
 * source journal. The original voucher, allocations, and journal stay intact.
 */
export async function reverseLandedCostVoucher(
  orgId: string,
  actorId: string,
  input: ReverseLandedCostVoucherInput,
): Promise<ReverseLandedCostVoucherResult> {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new InventoryError(
      "reversal reason must be between 5 and 500 characters",
    );
  }
  assertInventoryDate(input.reversalDate, "reversal date");

  return db.transaction(async (tx) => {
    const voucherResult = (await tx.execute<{
        id: string;
        status: string;
        amount: string;
        journal_entry_id: string | null;
        reversal_journal_entry_id: string | null;
      }>(sql`
      select id, status, amount, journal_entry_id, reversal_journal_entry_id
        from landed_cost_vouchers
       where id = ${input.voucherId} and org_id = ${orgId}
       for update
    `));
    const voucher = voucherResult.rows[0];
    if (!voucher) throw new InventoryError("landed-cost voucher not found");
    if (voucher.status === "void") {
      if (!voucher.reversal_journal_entry_id) {
        throw new InventoryError(
          "void landed-cost voucher is missing reversal evidence",
        );
      }
      const count = (await tx.execute<{ count: number }>(sql`
        select count(*)::int as count
          from landed_cost_allocations
         where org_id = ${orgId} and voucher_id = ${voucher.id}
           and reverses_allocation_id is not null
      `));
      return {
        voucherId: voucher.id,
        entryId: voucher.reversal_journal_entry_id,
        alreadyReversed: true,
        reversedAllocations: count.rows[0]!.count,
      };
    }
    if (voucher.status !== "posted" || !voucher.journal_entry_id) {
      throw new InventoryError(
        "only a posted landed-cost voucher can be reversed",
      );
    }

    const targets = (await tx.execute<{ item_id: string; stock_location_id: string }>(sql`
      select item_id, stock_location_id
        from landed_cost_voucher_targets
       where voucher_id = ${voucher.id} and org_id = ${orgId}
       order by item_id, stock_location_id
    `));
    if (!targets.rows.length) {
      throw new InventoryError("landed-cost voucher has no target evidence");
    }
    for (const target of targets.rows) {
      await lockInventoryPosition(
        tx,
        target.item_id,
        target.stock_location_id,
      );
    }

    const allocations = (await tx.execute<{
        id: string;
        target_cost_layer_id: string;
        basis: "value" | "quantity" | "weight" | "manual" | "standard_variance";
        amount: string;
        source_document_line_id: string | null;
        subsidiary_id: string;
        source_movement_id: string;
        received_at: string;
        original_quantity: string;
        remaining_quantity: string;
        unit_cost: string;
        remaining_original_cost: string | null;
      }>(sql`
      select allocation.id, allocation.target_cost_layer_id, allocation.basis,
             allocation.amount::text, allocation.source_document_line_id,
             layer.subsidiary_id, layer.source_movement_id, layer.received_at::text,
             layer.original_quantity::text, layer.remaining_quantity::text,
             layer.unit_cost::text, layer.remaining_original_cost::text
        from landed_cost_allocations allocation
        join cost_layers layer
          on layer.id = allocation.target_cost_layer_id
         and layer.org_id = allocation.org_id
       where allocation.org_id = ${orgId}
         and allocation.voucher_id = ${voucher.id}
         and allocation.reverses_allocation_id is null
       order by allocation.created_at desc, allocation.id desc
       for update of layer
    `));
    if (!allocations.rows.length) {
      throw new InventoryError(
        "landed-cost voucher has no linked allocation evidence",
      );
    }
    const allocated = sum(allocations.rows.map((row) => row.amount));
    if (cmp(allocated, voucher.amount) !== 0) {
      throw new InventoryError(
        "landed-cost voucher allocation evidence does not equal its amount",
      );
    }
    const prior = (await tx.execute(sql`
      select reverses_allocation_id
        from landed_cost_allocations
       where org_id = ${orgId}
         and reverses_allocation_id in (${joinIds(
           allocations.rows.map((row) => row.id),
         )})
       limit 1
    `));
    if (prior.rows.length) {
      throw new InventoryError(
        "landed-cost voucher has partial reversal evidence",
      );
    }

    for (const allocation of allocations.rows) {
      if (allocation.basis === "standard_variance") {
        // The voucher never embedded value in the layer (booked to variance
        // under standard costing), so there is no subledger value to remove:
        // the mirrored journal below alone unwinds the GL.
        continue;
      }
      await devalueLayerExactly(
        tx,
        orgId,
        {
          id: allocation.target_cost_layer_id,
          subsidiary_id: allocation.subsidiary_id,
          source_movement_id: allocation.source_movement_id,
          received_at: allocation.received_at,
          original_quantity: allocation.original_quantity,
          remaining_quantity: allocation.remaining_quantity,
          unit_cost: allocation.unit_cost,
          remaining_original_cost: allocation.remaining_original_cost,
        },
        toUnits(allocation.amount),
        actorId,
      );
    }

    const reversalEntryId = await reverseInventoryJournal(
      tx,
      orgId,
      actorId,
      voucher.journal_entry_id,
      input.reversalDate,
      reason,
    );
    for (const allocation of allocations.rows) {
      await tx.execute(sql`
        insert into landed_cost_allocations
          (org_id, voucher_id, source_document_line_id, target_cost_layer_id,
           basis, amount, journal_entry_id, reverses_allocation_id,
           reversal_reason, created_by, updated_by)
        values
          (${orgId}, ${voucher.id}, ${allocation.source_document_line_id},
           ${allocation.target_cost_layer_id}, ${allocation.basis},
           ${neg(allocation.amount)}, ${reversalEntryId}, ${allocation.id},
           ${reason}, ${actorId}, ${actorId})
      `);
    }
    await tx.execute(sql`
      update landed_cost_vouchers
         set status = 'void',
             reversal_journal_entry_id = ${reversalEntryId},
             voided_at = now(),
             voided_by = ${actorId},
             void_reason = ${reason},
             updated_at = now(),
             updated_by = ${actorId}
       where id = ${voucher.id} and org_id = ${orgId}
    `);
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${orgId}, 'landed_cost_vouchers', ${voucher.id}, 'void',
         ${JSON.stringify({
           reason,
           reversalDate: input.reversalDate,
           reversalEntryId,
           reversedAllocations: allocations.rows.length,
         })}::jsonb,
         ${actorId})
    `);
    return {
      voucherId: voucher.id,
      entryId: reversalEntryId,
      alreadyReversed: false,
      reversedAllocations: allocations.rows.length,
    };
  });
}

/** SQL list literal for a non-empty uuid array. */
function joinIds(ids: string[]) {
  if (ids.length === 0) throw new InventoryError("internal: empty id list");
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}
