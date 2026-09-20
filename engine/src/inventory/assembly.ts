import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { add, cmp, isZero, neg, normalizeMoney } from "../money/money.ts";
import { extendCost, unitCostPerQuantity } from "./costing.ts";
import { loadSubsidiaryContext } from "../organization/subsidiaries.ts";
import type { AssemblyBomRevisionEvidence } from "@openbooks/schema";
import { InventoryError, type InventoryProfile } from "./contracts.ts";
import { inventoryRequestHash } from "./action-idempotency.ts";
import { assertStockLocationAdmitsSubsidiary, assertNoForeignOnHand, resolveProfile, assertMovementOwner, assertInventoryFeature } from "./profile-policy.ts";
import { stockLocationDim, postInventoryEntry, inventoryOffsetAccountProblem, type JournalLineInput } from "./journal.ts";
import { primaryBookId, periodForDate, subsidiaryCurrency, getOnHandWith, lockInventoryPosition, persistReceiptMoney, assertInventoryDate } from "./position.ts";
import { consumeLayers, recordConsumptions, addLayerAtCost, type Consumption } from "./cost-layers.ts";
import { type MovementResult } from "./movements.ts";
import { type ReverseInventoryInput, type ReverseInventoryResult, type ReversibleMovement, removeInboundLayer, restoreIssueLayers, reverseInventoryJournal } from "./reversal.ts";

// ---------------------------------------------------------------------------
// Assembly build (light manufacturing / kits)
// ---------------------------------------------------------------------------

export interface BuildInput {
  assemblyItemId: string;
  /** number of assemblies to build (> 0). */
  quantity: string;
  stockLocationId: string;
  subsidiaryId: string;
  date: string;
  memo?: string | null;
}

export interface AssemblyBuildResult extends MovementResult {
  /** Content address of the exact BOM snapshot consumed by this build. */
  bomRevision: `sha256:${string}`;
}

/**
 * Build assemblies from their bill of materials: consume each component (by its
 * costing method) and produce the finished good at the summed component cost —
 * or, under standard costing, at the finished good's own standard with the
 * difference booked as a build variance. Posts DR finished-good inventory /
 * CR each component's inventory account (+ a variance leg under standard
 * costing). Requires a BOM (bom_components) and inventory profiles on the
 * assembly and every component; blocks a build short of any component.
 */
export async function buildAssembly(
  orgId: string,
  actorId: string | null,
  input: BuildInput,
): Promise<AssemblyBuildResult> {
  // Same early gate as receipts: junk must name InventoryError (not a bare
  // Error) and oversized figures must refuse before any journal math.
  const quantity = persistReceiptMoney(input.quantity, "assembly build quantity");
  if (cmp(quantity, "0") <= 0)
    throw new InventoryError("build quantity must be positive");
  const period = await periodForDate(orgId, input.date);
  if (!period)
    throw new InventoryError(`no accounting period for ${input.date}`);
  const currency = await subsidiaryCurrency(orgId, input.subsidiaryId);
  const ctx = await loadSubsidiaryContext(db, orgId);
  assertMovementOwner(ctx, input.subsidiaryId);

  return await db.transaction(async (tx) => {
    await assertInventoryFeature(tx, orgId);
    const bookId = await primaryBookId(orgId, tx);
    // There is no separately lockable BOM header. A SHARE table lock is the
    // narrowest PostgreSQL primitive that excludes every INSERT/UPDATE/DELETE,
    // including insertion of a new component for this assembly. It therefore
    // gives the build one policy: a writer already in flight commits first and
    // is re-read; a writer arriving later waits for this build to finish.
    await tx.execute(sql`lock table bom_components in share mode`);
    const bom = (await tx.execute<{
      component_item_id: string;
      quantity_per: string;
      sort_order: number;
    }>(sql`
      select component_item_id, quantity_per, sort_order
        from bom_components
       where org_id = ${orgId} and assembly_item_id = ${input.assemblyItemId}
       order by sort_order, component_item_id
    `));
    if (bom.rows.length === 0) {
      throw new InventoryError("assembly has no bill of materials");
    }

    const bomSnapshot = {
      format: "openbooks.inventory-bom.v1" as const,
      assemblyItemId: input.assemblyItemId,
      components: bom.rows.map((component) => ({
        componentItemId: component.component_item_id,
        quantityPer: normalizeMoney(component.quantity_per),
        sortOrder: component.sort_order,
      })),
    };
    const bomRevision: `sha256:${string}` =
      `sha256:${inventoryRequestHash(bomSnapshot)}`;
    const bomEvidence: AssemblyBomRevisionEvidence = {
      ...bomSnapshot,
      revision: bomRevision,
    };

    // Lock every costing profile in UUID order before using any of them. A
    // build can then never combine a BOM snapshot with a pre-transaction or
    // concurrently revised costing policy.
    const profileByItemId = new Map<string, InventoryProfile>();
    const profileItemIds = [
      input.assemblyItemId,
      ...bom.rows.map((component) => component.component_item_id),
    ]
      .filter((itemId, index, all) => all.indexOf(itemId) === index)
      .sort();
    for (const itemId of profileItemIds) {
      profileByItemId.set(itemId, await resolveProfile(orgId, itemId, tx, true));
    }
    const assembly = profileByItemId.get(input.assemblyItemId)!;
    if (assembly.tracking !== "none") {
      throw new InventoryError(
        "tracked assemblies require serial/lot build allocation evidence, which this operation does not accept",
      );
    }

    // Resolve each component from the locked BOM and costing-profile snapshot.
    const components: {
      itemId: string;
      profile: InventoryProfile;
      reqQty: string;
      onHand?: { quantity: string; value: string; unitCost: string };
    }[] = [];
    for (const component of bom.rows) {
      const profile = profileByItemId.get(component.component_item_id)!;
      if (profile.tracking !== "none") {
        throw new InventoryError(
          `tracked component ${component.component_item_id} requires explicit serial/lot consumption evidence`,
        );
      }
      components.push({
        itemId: component.component_item_id,
        profile,
        reqQty: extendCost(input.quantity, component.quantity_per),
      });
    }

    if (assembly.costingMethod === "standard") {
      for (const profile of [assembly, ...components.map((component) => component.profile)]) {
        const accountProblem = inventoryOffsetAccountProblem(profile.assetAccountId, assembly.varianceAccountId, "variance");
        if (accountProblem) throw new InventoryError(accountProblem);
      }
    }
    // A build touches every component plus the finished-good position.
    // Deterministic advisory locks make the availability check and all layer
    // updates one serializable operation without deadlocks between BOMs.
    const positionItemIds = [
      input.assemblyItemId,
      ...components.map((component) => component.itemId),
    ]
      .filter((itemId, index, all) => all.indexOf(itemId) === index)
      .sort();
    for (const itemId of positionItemIds) {
      await lockInventoryPosition(tx, itemId, input.stockLocationId);
    }
    await assertStockLocationAdmitsSubsidiary(
      tx,
      orgId,
      ctx,
      input.stockLocationId,
      input.subsidiaryId,
    );
    for (const component of components) {
      component.onHand = await getOnHandWith(
        tx,
        orgId,
        component.itemId,
        input.stockLocationId,
        { subsidiaryId: input.subsidiaryId },
      );
      if (cmp(component.reqQty, component.onHand.quantity) > 0) {
        // Components owned by another entity in the shared position are not
        // raw material for this build — refuse as a cross-entity attempt.
        await assertNoForeignOnHand(
          tx,
          orgId,
          component.itemId,
          input.stockLocationId,
          input.subsidiaryId,
        );
        throw new InventoryError(
          `insufficient component ${component.itemId}: need ${component.reqQty}, on hand ${component.onHand.quantity}`,
        );
      }
    }

    const consumeLines: JournalLineInput[] = [];
    const perComponent: {
      itemId: string;
      cost: string;
      consumptions: Consumption[];
    }[] = [];
    let totalCost = "0";
    for (const c of components) {
      const { cost, consumptions } = await consumeLayers(
        tx,
        orgId,
        c.profile,
        c.itemId,
        input.stockLocationId,
        c.reqQty,
        c.onHand!,
        undefined,
        {},
        input.subsidiaryId,
        actorId,
      );
      totalCost = add(totalCost, cost);
      consumeLines.push({
        accountId: c.profile.assetAccountId,
        amount: neg(cost),
        // Stamp the build's business location below (see buildLocationId).
        memo: "Assembly component",
      });
      perComponent.push({ itemId: c.itemId, cost, consumptions });
    }
    // Builds name no explicit dims; the stock location's business location is
    // the only honest attribution, matching receipts, issues and transfers.
    const buildLocationId = await stockLocationDim(tx, orgId, input.stockLocationId, null);
    for (const consumeLine of consumeLines) consumeLine.locationId = buildLocationId;

    // Standard costing values the finished good at ITS standard; the
    // difference to the consumed components' carried cost is a production
    // variance on the variance account — never a mis-valued finished layer
    // (which would strand residual inventory value after a full issue).
    const consumedTotal = totalCost;
    let fgValue = consumedTotal;
    let fgUnitCost = isZero(input.quantity)
      ? "0"
      : unitCostPerQuantity(consumedTotal, input.quantity)!;
    if (assembly.costingMethod === "standard") {
      fgUnitCost = assembly.standardCost ?? fgUnitCost;
      fgValue = extendCost(input.quantity, fgUnitCost);
    }
    const lines: JournalLineInput[] = [
      {
        accountId: assembly.assetAccountId,
        amount: fgValue,
        locationId: buildLocationId,
        memo: input.memo ?? "Assembly build",
      },
      ...consumeLines,
    ];
    const buildVariance = add(consumedTotal, neg(fgValue));
    if (!isZero(buildVariance)) {
      if (!assembly.varianceAccountId) {
        throw new InventoryError(
          "this assembly build carries a production variance under standard costing but the assembly has no variance account — configure one; booking the variance on the asset account itself would post a self-cancelling entry and break GL = cost layers",
        );
      }
      lines.push({
        accountId: assembly.varianceAccountId,
        amount: buildVariance,
        locationId: buildLocationId,
        memo: "Build variance",
      });
    }
    const entryId = await postInventoryEntry(tx, {
      orgId,
      bookId,
      subsidiaryId: input.subsidiaryId,
      actorId,
      currency,
      periodId: period,
      date: input.date,
      entryNumber: `INV-BUILD-${input.date}-${input.assemblyItemId.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
      memo: input.memo ?? "Assembly build",
      lines,
      custom: { assemblyBuild: bomEvidence },
    });

    // Component consume movements + layer draw-downs.
    for (let i = 0; i < components.length; i++) {
      const c = components[i]!;
      const pc = perComponent[i]!;
      const mv = (await tx.execute<{ id: string }>(sql`
        insert into inventory_movements
          (org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, quantity, unit_cost, total_value, journal_entry_id, status, memo, created_by, updated_by)
        values (${orgId}, ${input.subsidiaryId}, ${c.itemId}, 'assembly_consume', ${input.date}, ${input.stockLocationId},
                ${neg(c.reqQty)}, ${isZero(c.reqQty) ? "0" : unitCostPerQuantity(pc.cost, c.reqQty)!},
                ${neg(pc.cost)}, ${entryId}, 'posted', ${input.memo ?? null}, ${actorId}, ${actorId})
        returning id`));
      await recordConsumptions(
        tx,
        orgId,
        input.subsidiaryId,
        pc.consumptions,
        mv.rows[0]!.id,
        actorId,
      );
    }

    // Finished-good build movement + layer (at the finished good's own value).
    const buildQuantity = persistReceiptMoney(input.quantity, "assembly build quantity");
    const buildMv = (await tx.execute<{ id: string }>(sql`
      insert into inventory_movements
        (org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, quantity, unit_cost, total_value, journal_entry_id, status, memo, created_by, updated_by)
      values (${orgId}, ${input.subsidiaryId}, ${input.assemblyItemId}, 'assembly_build', ${input.date}, ${input.stockLocationId},
              ${buildQuantity}, ${fgUnitCost}, ${fgValue}, ${entryId}, 'posted', ${input.memo ?? null}, ${actorId}, ${actorId})
      returning id`));
    await addLayerAtCost(
      tx,
      orgId,
      input.subsidiaryId,
      input.assemblyItemId,
      input.stockLocationId,
      input.quantity,
      fgValue,
      assembly.costingMethod,
      buildMv.rows[0]!.id,
      input.date,
      actorId,
      fgUnitCost,
    );

    return {
      movementId: buildMv.rows[0]!.id,
      entryId,
      value: fgValue,
      bomRevision,
    };
  });
}

/**
 * Reverse one complete assembly operation. Component consumptions and the
 * finished-good layer share one journal entry, so they must be restored as a
 * single locked unit; reversing only one movement would corrupt both quantity
 * and valuation provenance.
 */
export async function reverseAssemblyBuild(
  orgId: string,
  actorId: string,
  input: ReverseInventoryInput,
): Promise<ReverseInventoryResult> {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new InventoryError(
      "reversal reason must be between 5 and 500 characters",
    );
  }
  assertInventoryDate(input.reversalDate, "reversal date");

  return db.transaction(async (tx) => {
    const requested = (await tx.execute<ReversibleMovement>(sql`
      select id, org_id, subsidiary_id, item_id, kind, moved_at::text, stock_location_id, lot_id,
             serial_id, quantity, unit_cost, total_value, journal_entry_id,
             paired_movement_id, status
        from inventory_movements
       where org_id = ${orgId} and id = ${input.movementId}
       for update
    `));
    const build = requested.rows[0];
    if (!build || build.kind !== "assembly_build") {
      throw new InventoryError("assembly build movement not found");
    }
    if (!build.journal_entry_id) {
      throw new InventoryError("assembly build is missing its source journal");
    }

    const sources = (await tx.execute<ReversibleMovement>(sql`
      select id, org_id, subsidiary_id, item_id, kind, moved_at::text, stock_location_id, lot_id,
             serial_id, quantity, unit_cost, total_value, journal_entry_id,
             paired_movement_id, status
        from inventory_movements
       where org_id = ${orgId}
         and journal_entry_id = ${build.journal_entry_id}
       order by case when kind = 'assembly_build' then 0 else 1 end, id
       for update
    `));
    if (
      sources.rows.filter((row) => row.kind === "assembly_build").length !== 1 ||
      sources.rows.filter((row) => row.kind === "assembly_consume").length === 0 ||
      sources.rows.some(
        (row) =>
          !["assembly_build", "assembly_consume"].includes(row.kind) ||
          row.status !== "posted",
      )
    ) {
      throw new InventoryError(
        "the assembly journal does not contain one complete posted build operation",
      );
    }

    if (sources.rows.some((source) => input.reversalDate < source.moved_at.slice(0, 10))) {
      throw new InventoryError("reversal date cannot precede the source assembly movement");
    }

    const sourceIds = sources.rows.map((row) => row.id);
    const prior = (await tx.execute<{ id: string; journal_entry_id: string | null }>(sql`
      select id, journal_entry_id
        from inventory_movements
       where org_id = ${orgId}
         and reverses_movement_id in (${sql.join(
           sourceIds.map((id) => sql`${id}`),
           sql`, `,
         )})
       order by id
    `));
    if (prior.rows.length) {
      if (prior.rows.length !== sources.rows.length) {
        throw new InventoryError(
          "assembly reversal evidence is incomplete",
        );
      }
      return {
        movementIds: prior.rows.map((row) => row.id).sort(),
        entryId: prior.rows[0]!.journal_entry_id,
        alreadyReversed: true,
      };
    }

    for (const key of [
      ...new Set(
        sources.rows.map(
          (row) => `${row.item_id}:${row.stock_location_id}`,
        ),
      ),
    ].sort()) {
      const separator = key.indexOf(":");
      await lockInventoryPosition(
        tx,
        key.slice(0, separator),
        key.slice(separator + 1),
      );
    }

    const finished = sources.rows.find(
      (row) => row.kind === "assembly_build",
    )!;
    await removeInboundLayer(tx, orgId, finished, actorId);
    for (const component of sources.rows.filter(
      (row) => row.kind === "assembly_consume",
    )) {
      await restoreIssueLayers(tx, orgId, component, actorId);
    }

    const reversalEntryId = await reverseInventoryJournal(
      tx,
      orgId,
      actorId,
      build.journal_entry_id,
      input.reversalDate,
      reason,
    );
    const reversalIds: string[] = [];
    for (const source of sources.rows) {
      const reversalId = randomUUID();
      reversalIds.push(reversalId);
      await tx.execute(sql`
        insert into inventory_movements
          (id, org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, lot_id,
           serial_id, quantity, unit_cost, total_value, journal_entry_id,
           reverses_movement_id, reversal_reason, status, memo,
           created_by, updated_by)
        values
          (${reversalId}, ${orgId}, ${source.subsidiary_id}, ${source.item_id}, 'return',
           ${input.reversalDate}, ${source.stock_location_id}, ${source.lot_id},
           ${source.serial_id}, ${neg(source.quantity)}, ${source.unit_cost},
           ${source.total_value == null ? null : neg(source.total_value)},
           ${reversalEntryId}, ${source.id}, ${reason}, 'posted',
           ${`Reversal of assembly movement ${source.id}: ${reason}`},
           ${actorId}, ${actorId})
      `);
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id)
        values
          (${orgId}, 'inventory_movements', ${source.id}, 'void',
           ${JSON.stringify({
             reason,
             reversalDate: input.reversalDate,
             reversalMovementId: reversalId,
             reversalEntryId,
             operation: "assembly_build",
           })}::jsonb,
           ${actorId})
      `);
    }
    return {
      movementIds: reversalIds.sort(),
      entryId: reversalEntryId,
      alreadyReversed: false,
    };
  });
}
