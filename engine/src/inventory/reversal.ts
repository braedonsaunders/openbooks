import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { add, cmp, fromUnits, neg, sum, toUnits } from "../money/money.ts";
import { extendCost } from "./costing.ts";
import { loadSubsidiaryContext, SubsidiaryError, uuidArray, validateSubsidiaryRestrictions } from "../organization/subsidiaries.ts";
import { assertPeriodModulesOpen, CloseError } from "../close/period-policy.ts";
import { InventoryError, type Runner } from "./contracts.ts";
import { assertInventoryAccountsPostable } from "./journal.ts";
import { lockInventoryPosition, assertInventoryDate } from "./position.ts";

// ---------------------------------------------------------------------------
// Controlled reversal
// ---------------------------------------------------------------------------

export interface ReverseInventoryInput {
  movementId: string;
  reversalDate: string;
  /** Immutable business reason retained on the reversal movement and audit log. */
  reason: string;
}

export interface ReverseInventoryResult {
  movementIds: string[];
  entryId: string | null;
  alreadyReversed: boolean;
}
export type ReversibleMovement = {
  id: string;
  org_id: string;
  subsidiary_id: string;
  item_id: string;
  kind: string;
  moved_at: string;
  stock_location_id: string;
  lot_id: string | null;
  serial_id: string | null;
  quantity: string;
  unit_cost: string | null;
  total_value: string | null;
  journal_entry_id: string | null;
  paired_movement_id: string | null;
  status: string;
};

export async function restoreIssueLayers(
  tx: Runner,
  orgId: string,
  movement: ReversibleMovement,
  actorId: string,
): Promise<void> {
  const provisional = (await tx.execute(sql`
    select 1
      from inventory_provisional_costs
     where org_id = ${orgId} and issue_movement_id = ${movement.id}
     limit 1
  `));
  if (provisional.rows.length) {
    throw new InventoryError(
      "a negative-stock issue must have its provisional-cost chain reversed before the issue",
    );
  }

  const consumed = (await tx.execute<{
      cost_layer_id: string;
      quantity: string;
      unit_cost: string;
      remaining_quantity: string;
      original_quantity: string;
      current_unit_cost: string;
      original_cost: string | null;
    }>(sql`
    select c.cost_layer_id, c.quantity, c.unit_cost, c.original_cost,
           l.remaining_quantity, l.original_quantity, l.unit_cost as current_unit_cost
      from cost_layer_consumptions c
      join cost_layers l
        on l.id = c.cost_layer_id
       and l.org_id = c.org_id
     where c.org_id = ${orgId} and c.issue_movement_id = ${movement.id}
     order by c.created_at, c.id
     for update of l
  `));
  const restoredQuantity = sum(consumed.rows.map((row) => row.quantity));
  if (cmp(restoredQuantity, fromUnits(-toUnits(movement.quantity))) !== 0) {
    throw new InventoryError(
      "the issue's exact layer provenance is incomplete; controlled reversal is unavailable",
    );
  }
  const restoredValue = sum(consumed.rows.map((row) => fromUnits(
    toUnits(extendCost(add(row.remaining_quantity, row.quantity), row.current_unit_cost)) -
    toUnits(extendCost(row.remaining_quantity, row.current_unit_cost)),
  )));
  if (movement.total_value == null || cmp(restoredValue, neg(movement.total_value)) !== 0) {
    throw new InventoryError("the source layers cannot restore the exact movement value; reverse later inventory activity first");
  }
  for (const row of consumed.rows) {
    if (cmp(row.current_unit_cost, row.unit_cost) !== 0) {
      throw new InventoryError(
        "a consumed cost layer was revalued after this issue; reverse the downstream landed-cost/revaluation first",
      );
    }
    if (
      cmp(add(row.remaining_quantity, row.quantity), row.original_quantity) > 0
    ) {
      throw new InventoryError(
        "restoring the issue would exceed its source layer's original quantity",
      );
    }
    await tx.execute(sql`
      update cost_layers
         set remaining_quantity = remaining_quantity + ${row.quantity},
             remaining_original_cost = remaining_original_cost + ${row.original_cost}::numeric, updated_at = now(), updated_by = ${actorId}
       where id = ${row.cost_layer_id} and org_id = ${orgId}
    `);
  }
}

export async function removeInboundLayer(
  tx: Runner,
  orgId: string,
  movement: ReversibleMovement,
  actorId: string,
): Promise<void> {
  const settlements = (await tx.execute(sql`
    select 1
      from inventory_provisional_settlements
     where org_id = ${orgId} and receipt_movement_id = ${movement.id}
     limit 1
  `));
  if (settlements.rows.length) {
    throw new InventoryError(
      "a receipt that settled negative stock must be reversed through its full provisional-cost chain",
    );
  }

  const layers = (await tx.execute<{
      id: string; original_quantity: string; remaining_quantity: string; unit_cost: string;
    }>(sql`
    select id, original_quantity, remaining_quantity, unit_cost
      from cost_layers
     where org_id = ${orgId} and source_movement_id = ${movement.id}
     order by id for update
  `)).rows;
  if (!layers.length) {
    throw new InventoryError(
      "the inbound movement was blended into another cost layer; exact receipt reversal is unavailable for blended provenance and requires a controlled inventory correction",
    );
  }
  const layerIds = uuidArray(layers.map((layer) => layer.id));
  const consumed = (await tx.execute(sql`
    select 1 from cost_layer_consumptions
     where org_id = ${orgId} and cost_layer_id = any(${layerIds}::uuid[])
       and not exists (
         select 1 from inventory_movements reversal
          where reversal.org_id = ${orgId}
            and reversal.reverses_movement_id = cost_layer_consumptions.issue_movement_id
       ) limit 1
  `));
  if (consumed.rows.length) {
    throw new InventoryError(
      "inventory from this movement has downstream consumption; reverse those issues/transfers first",
    );
  }
  const landed = (await tx.execute(sql`
    select 1 from landed_cost_allocations allocation
     where allocation.org_id = ${orgId}
       and allocation.target_cost_layer_id = any(${layerIds}::uuid[])
       and allocation.reverses_allocation_id is null
       and not exists (
         select 1 from landed_cost_allocations reversal
          where reversal.org_id = allocation.org_id
            and reversal.reverses_allocation_id = allocation.id
       ) limit 1
  `));
  if (landed.rows.length) {
    throw new InventoryError(
      "this movement has downstream landed-cost allocations; reverse them before the inventory movement",
    );
  }
  // A transfer can retain multiple FIFO strata or exact average-rate fragments.
  // Remove the whole intact inbound basis, never a slice of a blended pool or
  // a layer whose value has been changed by later valuation activity.
  if (cmp(movement.quantity, "0") <= 0 || movement.total_value == null ||
      cmp(sum(layers.map((layer) => layer.original_quantity)), movement.quantity) !== 0 ||
      cmp(sum(layers.map((layer) => layer.remaining_quantity)), movement.quantity) !== 0 ||
      cmp(sum(layers.map((layer) => extendCost(layer.remaining_quantity, layer.unit_cost))), movement.total_value) !== 0) {
    throw new InventoryError("the inbound movement cannot be removed from its cost layers exactly; reverse later inventory activity first");
  }
  await tx.execute(sql`update cost_layers set remaining_quantity='0', original_quantity='0', remaining_original_cost=case when remaining_original_cost is null then null else 0 end, updated_at=now(), updated_by=${actorId}
    where org_id=${orgId} and id=any(${layerIds}::uuid[])`);

}

export async function reverseInventoryJournal(
  tx: Runner,
  orgId: string,
  actorId: string,
  sourceEntryId: string,
  reversalDate: string,
  reason: string,
): Promise<string> {
  const head = (await tx.execute<{
      id: string;
      book_id: string;
      subsidiary_id: string;
      entry_number: string;
      origin: string;
      status: string;
      posting_date: string;
    }>(sql`
    select id, book_id, subsidiary_id, entry_number, origin, status, posting_date::text
      from journal_entries
     where id = ${sourceEntryId} and org_id = ${orgId}
     for update
  `));
  const source = head.rows[0];
  if (!source || source.origin !== "inventory" || source.status !== "posted") {
    throw new InventoryError(
      "the movement is not backed by a reversible posted inventory journal",
    );
  }
  if (reversalDate < source.posting_date) {
    throw new InventoryError("reversal date cannot precede the source inventory journal");
  }
  const book = (await tx.execute<{ id: string }>(sql`
    select id
      from accounting_books
     where org_id = ${orgId} and id = ${source.book_id}
       and is_active and posts_gl
     for share
  `)).rows[0];
  if (!book) {
    throw new InventoryError("the source inventory journal book is not active for posting");
  }
  const period = (await tx.execute<{ id: string }>(sql`
    select id
      from accounting_periods
     where org_id = ${orgId}
       and is_adjustment = false
       and starts_on <= ${reversalDate}
       and ends_on >= ${reversalDate}
     limit 1
  `));
  if (!period.rows[0])
    throw new InventoryError(`no accounting period for ${reversalDate}`);

  const lines = (await tx.execute<Record<string, unknown>>(sql`
    select line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
           memo, party_id, department_id, project_id, location_id, class_id,
           equipment_unit_id, payment_card_id, extra_dims, quantity, unit,
           tax_code_id, custom
      from journal_lines
     where org_id = ${orgId} and entry_id = ${sourceEntryId}
     order by line_number
  `));
  if (!lines.rows.length)
    throw new InventoryError("the source inventory journal has no lines");

  const accountIds = [...new Set(lines.rows.map((line) => String(line.account_id)))];
  await assertInventoryAccountsPostable(tx, orgId, accountIds);
  try {
    await validateSubsidiaryRestrictions(tx, {
      orgId,
      ctx: await loadSubsidiaryContext(tx, orgId),
      docSubsidiaryId: source.subsidiary_id,
      lines: lines.rows.map((line) => ({
        accountId: String(line.account_id),
        amount: String(line.amount),
        subsidiaryId: String(line.subsidiary_id),
        departmentId: line.department_id == null ? null : String(line.department_id),
        projectId: line.project_id == null ? null : String(line.project_id),
        locationId: line.location_id == null ? null : String(line.location_id),
        classId: line.class_id == null ? null : String(line.class_id),
      })),
    });
  } catch (error) {
    if (error instanceof SubsidiaryError) throw new InventoryError(error.message);
    throw error;
  }

  // Same companion gate as postInventoryEntry: the reversal posts into the
  // reversal date's period, so a GL-closed target must refuse here with a
  // named InventoryError, not at the posted flip with a raw driver error.
  // The mirrored lines keep their own subsidiaries, so judge every leg the
  // database guard would judge.
  try {
    await assertPeriodModulesOpen(tx, {
      orgId,
      periodId: period.rows[0].id,
      bookId: source.book_id,
      subsidiaryIds: [...new Set([source.subsidiary_id, ...lines.rows.map((line) => String(line.subsidiary_id))])],
      modules: [],
    });
  } catch (error) {
    if (error instanceof CloseError) throw new InventoryError(error.message);
    throw error;
  }

  const reversal = (await tx.execute<{ id: string }>(sql`
    insert into journal_entries
      (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
       memo, status, origin, reverses_entry_id, created_by, updated_by)
    values
      (${orgId}, ${source.book_id}, ${source.subsidiary_id},
       ${`${source.entry_number}-REV`}, ${reversalDate}, ${period.rows[0].id},
       ${`Inventory reversal: ${reason}`}, 'draft', 'inventory', ${sourceEntryId},
       ${actorId}, ${actorId})
    returning id
  `));
  const reversalEntryId = reversal.rows[0]!.id;
  for (const line of lines.rows) {
    await tx.execute(sql`
      insert into journal_lines
        (org_id, entry_id, line_number, account_id, subsidiary_id, amount,
         currency, txn_amount, fx_rate, memo, party_id, department_id,
         project_id, location_id, class_id, equipment_unit_id, payment_card_id,
         extra_dims, quantity, unit, tax_code_id, custom)
      values
        (${orgId}, ${reversalEntryId}, ${line.line_number}, ${line.account_id},
         ${line.subsidiary_id}, ${neg(String(line.amount))}, ${line.currency},
         ${neg(String(line.txn_amount))}, ${String(line.fx_rate)}, ${line.memo},
         ${line.party_id}, ${line.department_id}, ${line.project_id},
         ${line.location_id}, ${line.class_id}, ${line.equipment_unit_id},
         ${line.payment_card_id}, ${JSON.stringify(line.extra_dims ?? {})}::jsonb,
         ${line.quantity == null ? null : neg(String(line.quantity))}, ${line.unit},
         ${line.tax_code_id}, ${JSON.stringify(line.custom ?? {})}::jsonb)
    `);
  }
  await tx.execute(sql`
    update journal_entries
       set status = 'posted', posted_at = now(), posted_by = ${actorId},
           updated_at = now(), updated_by = ${actorId}
     where id = ${reversalEntryId} and org_id = ${orgId}
  `);
  await tx.execute(sql`
    update journal_entries
       set status = 'reversed', updated_at = now(), updated_by = ${actorId}
     where id = ${sourceEntryId} and org_id = ${orgId}
  `);
  return reversalEntryId;
}

/**
 * Append an exact, linked correction for a receipt, issue, or transfer.
 *
 * The source movement remains posted and immutable. The operation locks the
 * source, restores the precise cost-layer state, mirrors the original journal
 * in the requested open period, and appends one reversal movement per source
 * leg. It fails closed when later consumption, landed cost, negative-stock
 * settlement, blended moving-average provenance, or a compound operation means
 * the original state cannot be reconstructed exactly.
 */
export async function reverseInventoryMovement(
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
    const sourceResult = (await tx.execute<ReversibleMovement>(sql`
      select id, org_id, subsidiary_id, item_id, kind, moved_at::text, stock_location_id, lot_id,
             serial_id, quantity, unit_cost, total_value, journal_entry_id,
             paired_movement_id, status
        from inventory_movements
       where org_id = ${orgId} and id = ${input.movementId}
       for update
    `));
    const requested = sourceResult.rows[0];
    if (!requested) throw new InventoryError("inventory movement not found");
    if (requested.status !== "posted") {
      throw new InventoryError(
        "only posted inventory movements can be reversed",
      );
    }
    const existing = (await tx.execute<{
        id: string;
        journal_entry_id: string | null;
        paired_movement_id: string | null;
      }>(sql`
      select id, journal_entry_id, paired_movement_id
        from inventory_movements
       where org_id = ${orgId} and reverses_movement_id = ${requested.id}
       order by created_at, id
    `));
    if (existing.rows.length) {
      const first = existing.rows[0]!;
      const group = (await tx.execute<{ id: string }>(sql`
        select id
          from inventory_movements
         where org_id = ${orgId}
           and (
             id = ${first.id}
             or paired_movement_id = ${first.id}
             or id = ${first.paired_movement_id}
             or paired_movement_id = ${first.paired_movement_id}
           )
         order by id
      `));
      return {
        movementIds: group.rows.map((row) => row.id),
        entryId: first.journal_entry_id,
        alreadyReversed: true,
      };
    }

    let sources: ReversibleMovement[];
    if (requested.kind === "transfer_out" || requested.kind === "transfer_in") {
      const outId =
        requested.kind === "transfer_out"
          ? requested.id
          : requested.paired_movement_id;
      if (!outId)
        throw new InventoryError(
          "transfer movement is missing its paired source leg",
        );
      const pair = (await tx.execute<ReversibleMovement>(sql`
        select id, org_id, subsidiary_id, item_id, kind, moved_at::text, stock_location_id, lot_id,
               serial_id, quantity, unit_cost, total_value, journal_entry_id,
               paired_movement_id, status
          from inventory_movements
         where org_id = ${orgId}
           and (id = ${outId} or paired_movement_id = ${outId})
         order by case when kind = 'transfer_out' then 0 else 1 end
         for update
      `));
      if (
        pair.rows.length !== 2 ||
        pair.rows[0]!.kind !== "transfer_out" ||
        pair.rows[1]!.kind !== "transfer_in"
      ) {
        throw new InventoryError("transfer movement pair is incomplete");
      }
      sources = pair.rows;
    } else if (requested.kind === "receipt" || requested.kind === "issue") {
      sources = [requested];
    } else {
      throw new InventoryError(
        `${requested.kind} requires its operation-specific controlled reversal`,
      );
    }

    if (sources.some((source) => input.reversalDate < source.moved_at.slice(0, 10))) {
      throw new InventoryError("reversal date cannot precede the source inventory movement");
    }

    const sourceIds = sources.map((source) => source.id);
    const orderLine = (await tx.execute(sql`select id from transfer_order_lines
      where org_id=${orgId} and (ship_movement_id=any(${uuidArray(sourceIds)}::uuid[])
        or receive_movement_id=any(${uuidArray(sourceIds)}::uuid[])) limit 1`)).rows[0];
    if (orderLine) {
      throw new InventoryError("transfer-order movements require a controlled order reversal; individual movement reversal would leave shipment accounting outstanding");
    }
    const prior = (await tx.execute<{ reverses_movement_id: string }>(sql`
      select reverses_movement_id
        from inventory_movements
       where org_id = ${orgId}
         and reverses_movement_id in (${sql.join(
           sourceIds.map((id) => sql`${id}`),
           sql`, `,
         )})
       limit 1
    `));
    if (prior.rows.length) {
      throw new InventoryError(
        "one leg of this inventory operation is already reversed",
      );
    }

    const entryIds = [
      ...new Set(
        sources.map((source) => source.journal_entry_id).filter(Boolean),
      ),
    ] as string[];
    if (entryIds.length > 1)
      throw new InventoryError(
        "inventory operation spans multiple source journals",
      );
    const sourceEntryId = entryIds[0] ?? null;
    if (sourceEntryId) {
      const attached = (await tx.execute(sql`
        select id
          from inventory_movements
         where org_id = ${orgId} and journal_entry_id = ${sourceEntryId}
           and id not in (${sql.join(
             sourceIds.map((id) => sql`${id}`),
             sql`, `,
           )})
         limit 1
      `));
      if (attached.rows.length) {
        throw new InventoryError(
          "the source journal contains a compound inventory operation; use its operation-specific reversal",
        );
      }
    }

    // Every other multi-position path (transfers, builds, document applies,
    // landed-cost vouchers) takes these position locks in sorted key order.
    // A transfer reversal used to lock transfer-out before transfer-in, so a
    // reversal racing an opposite-direction transfer deadlocked (40P01).
    for (const key of [
      ...new Set(
        sources.map(
          (source) => `${source.item_id}:${source.stock_location_id}`,
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
    const serialId =
      sources.find((source) => source.serial_id)?.serial_id ?? null;
    if (serialId) {
      const serial = (await tx.execute<{
          status: string;
          current_stock_location_id: string | null;
        }>(sql`
        select status, current_stock_location_id
          from serials
         where id = ${serialId} and org_id = ${orgId}
         for update
      `));
      const current = serial.rows[0];
      if (!current) {
        throw new InventoryError(
          "serial evidence is missing for the inventory movement",
        );
      }
      const expectedLocation =
        sources.length === 2
          ? sources.find((source) => source.kind === "transfer_in")!
              .stock_location_id
          : sources[0]!.kind === "receipt"
            ? sources[0]!.stock_location_id
            : null;
      const expectedStatus =
        sources.length === 1 && sources[0]!.kind === "issue"
          ? "shipped"
          : "in_stock";
      if (
        current.status !== expectedStatus ||
        current.current_stock_location_id !== expectedLocation
      ) {
        throw new InventoryError(
          "serial lifecycle has downstream activity; reverse that activity first",
        );
      }
    }
    if (sources.length === 1) {
      if (sources[0]!.kind === "issue") {
        await restoreIssueLayers(tx, orgId, sources[0]!, actorId);
      } else {
        await removeInboundLayer(tx, orgId, sources[0]!, actorId);
      }
    } else {
      await restoreIssueLayers(tx, orgId, sources[0]!, actorId);
      await removeInboundLayer(tx, orgId, sources[1]!, actorId);
    }

    const reversalEntryId = sourceEntryId
      ? await reverseInventoryJournal(
          tx,
          orgId,
          actorId,
          sourceEntryId,
          input.reversalDate,
          reason,
        )
      : null;

    const reversalIds: string[] = [];
    let firstReversalId: string | null = null;
    for (const source of sources) {
      const reversalId = randomUUID();
      const pairedReversalId =
        sources.length === 2 && source === sources[1] ? firstReversalId : null;
      await tx.execute(sql`
        insert into inventory_movements
          (id, org_id, subsidiary_id, item_id, kind, moved_at, stock_location_id, lot_id,
           serial_id, quantity, unit_cost, total_value, journal_entry_id,
           paired_movement_id, reverses_movement_id, reversal_reason, status,
           memo, created_by, updated_by)
        values
          (${reversalId}, ${orgId}, ${source.subsidiary_id}, ${source.item_id}, 'return',
           ${input.reversalDate}, ${source.stock_location_id}, ${source.lot_id},
           ${source.serial_id}, ${neg(source.quantity)}, ${source.unit_cost},
           ${source.total_value == null ? null : neg(source.total_value)},
           ${reversalEntryId}, ${pairedReversalId}, ${source.id}, ${reason},
           'posted', ${`Reversal of inventory movement ${source.id}: ${reason}`},
           ${actorId}, ${actorId})
      `);
      firstReversalId ??= reversalId;
      reversalIds.push(reversalId);
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
           })}::jsonb,
           ${actorId})
      `);
    }

    if (serialId) {
      const reversedIssue =
        sources.length === 1 && sources[0]!.kind === "issue";
      const reversedReceipt =
        sources.length === 1 && sources[0]!.kind === "receipt";
      const restoredLocation = reversedIssue
        ? sources[0]!.stock_location_id
        : sources.length === 2
          ? sources.find((source) => source.kind === "transfer_out")!
              .stock_location_id
          : null;
      await tx.execute(sql`
        update serials
           set status = ${reversedReceipt ? "returned" : "in_stock"},
               current_stock_location_id = ${restoredLocation},
               updated_at = now(),
               updated_by = ${actorId}
         where id = ${serialId} and org_id = ${orgId}
      `);
    }

    return {
      // IDs are an unordered operation set. Canonicalize the public result so
      // the creator and an idempotent concurrent retry return byte-identical
      // evidence even when both reversal rows share the same created_at value.
      movementIds: reversalIds.sort(),
      entryId: reversalEntryId,
      alreadyReversed: false,
    };
  });
}
