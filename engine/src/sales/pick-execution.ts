import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { InventoryError } from "../inventory/contracts.ts";
import { resolveProfile } from "../inventory/profile-policy.ts";
import { assertSaleableStock } from "../inventory/stock-eligibility.ts";
import { getOnHandWith, lockInventoryPosition } from "../inventory/position.ts";
import { toBaseQuantity } from "../inventory/costing.ts";
import {
  createExecutionSuggestion,
  admitExecution,
  type ExecutionTask,
} from "../inventory/directed-execution.ts";
import { cmp } from "../money/money.ts";
import { canonicalDecimal, compareDecimal } from "../money/exact-decimal.ts";
import { releasePickList } from "./fulfillment.ts";

interface PickSource extends Record<string, unknown> {
  line_id: string;
  document_id: string;
  item_id: string;
  stock_location_id: string;
  quantity: string;
  unit: string | null;
  subsidiary_id: string;
  lot_id: string | null;
  serial_id: string | null;
  document_date: string;
  status: string;
  stage: string;
}
async function pickSource(
  tx: SqlExecutor,
  orgId: string,
  lineId: string,
  lock = false,
) {
  const source = (
    await tx.execute<PickSource>(sql`select line.id as line_id,line.document_id,line.item_id,line.stock_location_id,
    line.quantity::text,line.unit,pick.subsidiary_id,fl.lot_id,fl.serial_id,pick.document_date::text,pick.status,fd.stage
    from document_lines line join documents pick on pick.org_id=line.org_id and pick.id=line.document_id
    join fulfillment_documents fd on fd.org_id=pick.org_id and fd.document_id=pick.id
    join fulfillment_lines fl on fl.org_id=line.org_id and fl.line_id=line.id
    where line.org_id=${orgId} and line.id=${lineId} and pick.kind='pick_list'
    ${lock ? sql`for update of line,pick,fd` : sql``}`)
  ).rows[0];
  if (!source) throw new ScopeNotFoundError();
  if (source.status !== "approved" || source.stage !== "open")
    throw new InventoryError(
      "Release this pick list before confirming its lines",
    );
  return source;
}

export async function suggestPickConfirmation(
  orgId: string,
  actorId: string,
  input: {
    lineId: string;
    quantity: string;
    reason?: string;
    commandKey: string;
  },
) {
  return withOrgTransaction(orgId, async () => {
    const source = await pickSource(db, orgId, input.lineId);
    await admitExecution(db, orgId, actorId, "pick", source.subsidiary_id);
    const quantity = canonicalDecimal(input.quantity, 8);
    if (
      !quantity ||
      compareDecimal(quantity, "0") < 0 ||
      compareDecimal(quantity, source.quantity) > 0
    )
      throw new InventoryError(
        "Picked quantity must be between zero and the suggested pick quantity",
      );
    if (
      compareDecimal(quantity, source.quantity) < 0 &&
      (!input.reason ||
        input.reason.trim().length < 5 ||
        input.reason.trim().length > 500)
    )
      throw new InventoryError(
        "Record a short-pick reason of 5–500 characters before releasing the unpicked reservation",
      );
    const profile = await resolveProfile(orgId, source.item_id, db);
    return createExecutionSuggestion(db, orgId, actorId, {
      stage: "pick",
      subsidiaryId: source.subsidiary_id,
      itemId: source.item_id,
      documentLineId: source.line_id,
      fromStockLocationId: source.stock_location_id,
      toStockLocationId: source.stock_location_id,
      quantity: toBaseQuantity(
        quantity,
        source.unit,
        profile.unitConversions ?? {},
        profile.baseUnit,
      ),
      documentQuantity: quantity,
      documentUnit: source.unit,
      lotId: source.lot_id,
      serialId: source.serial_id,
      postingDate: source.document_date,
      basis: {
        requestedQuantity: source.quantity,
        reason: input.reason?.trim() ?? null,
      },
      commandKey: input.commandKey,
    });
  });
}

export async function executePickDirection(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  task: ExecutionTask,
): Promise<Record<string, unknown>> {
  if (task.stage !== "pick")
    throw new InventoryError("Select pick work for this command");
  const source = await pickSource(tx, orgId, task.document_line_id!, true);
  await admitExecution(tx, orgId, actorId, "pick", source.subsidiary_id);
  if (
    source.item_id !== task.item_id ||
    source.stock_location_id !== task.from_stock_location_id ||
    source.subsidiary_id !== task.subsidiary_id ||
    source.lot_id !== task.lot_id ||
    source.serial_id !== task.serial_id ||
    compareDecimal(source.quantity, String(task.basis.requestedQuantity)) !== 0
  )
    throw new InventoryError(
      "Pick suggestion changed; refresh it before confirming stock",
    );
  if (cmp(task.quantity, "0") > 0) {
    await assertSaleableStock(tx, orgId, task.from_stock_location_id, {
      lotId: task.lot_id,
      serialId: task.serial_id,
    });
    const stock = await getOnHandWith(
      tx,
      orgId,
      task.item_id,
      task.from_stock_location_id,
      {
        subsidiaryId: task.subsidiary_id,
        lotId: task.lot_id,
        serialId: task.serial_id,
        saleableOnly: true,
      },
    );
    if (cmp(stock.quantity, task.quantity) < 0)
      throw new InventoryError(
        "Suggested stock is short; record the actual short-pick quantity and reason",
      );
  }
  if (
    (
      await tx.execute(
        sql`select line_id from pick_execution_lines where org_id=${orgId} and line_id=${source.line_id}`,
      )
    ).rows[0]
  )
    throw new InventoryError(
      "This pick line was already confirmed; reopen its recorded picked and short quantities",
    );
  const short = (
    await tx.execute<{ quantity: string }>(
      sql`select (${source.quantity}::numeric-${task.document_quantity}::numeric)::text as quantity`,
    )
  ).rows[0]!.quantity;
  const written = await tx.execute(sql`insert into pick_execution_lines
    (line_id,org_id,document_id,requested_quantity,picked_quantity,short_quantity,current_stock_location_id,confirmation_task_id,reason,created_by)
    values(${source.line_id},${orgId},${source.document_id},${source.quantity},${task.document_quantity},${short},
      ${source.stock_location_id},${task.id},${task.basis.reason ?? null},${actorId}) returning line_id`);
  if (written.rows.length !== 1)
    throw new InventoryError("Pick confirmation was not recorded");
  const audit =
    await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
    values(${orgId},'pick_execution_lines',${source.line_id},'insert',${JSON.stringify(
      {
        operation: "confirm_pick",
        before: { reservedQuantity: source.quantity },
        after: {
          pickedQuantity: task.document_quantity,
          releasedQuantity: short,
        },
        reason: task.basis.reason,
      },
    )}::jsonb,${actorId}) returning id`);
  if (audit.rows.length !== 1)
    throw new InventoryError("Short-pick release was not audited");
  return {
    lineId: source.line_id,
    pickedQuantity: task.document_quantity,
    releasedQuantity: short,
  };
}

export async function setPickDispatchPolicy(
  orgId: string,
  actorId: string,
  input: { pickListId: string; priority: number; cutoffAt: string },
) {
  return withOrgTransaction(orgId, async () => {
    const pick = (
      await db.execute<{
        subsidiary_id: string;
      }>(sql`select subsidiary_id from documents
      where org_id=${orgId} and id=${input.pickListId} and kind='pick_list' and status='draft' for update`)
    ).rows[0];
    if (!pick) throw new ScopeNotFoundError();
    await admitExecution(db, orgId, actorId, "pick", pick.subsidiary_id);
    if (
      !Number.isSafeInteger(input.priority) ||
      input.priority < -2147483648 ||
      input.priority > 2147483647 ||
      !Number.isFinite(Date.parse(input.cutoffAt))
    )
      throw new InventoryError(
        "Set an integer priority and a valid release cutoff timestamp",
      );
    const before = (
      await db.execute(sql`select pick_priority,release_cutoff_at::text from fulfillment_documents
      where org_id=${orgId} and document_id=${input.pickListId} for update`)
    ).rows[0];
    const changed =
      await db.execute(sql`update fulfillment_documents set pick_priority=${input.priority},release_cutoff_at=${input.cutoffAt}::timestamptz,
      updated_at=now(),updated_by=${actorId} where org_id=${orgId} and document_id=${input.pickListId} and stage='open' returning document_id`);
    if (changed.rows.length !== 1)
      throw new InventoryError(
        "Pick dispatch policy changed; reload the draft pick list",
      );
    const audited =
      await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values(${orgId},'fulfillment_documents',${input.pickListId},'update',${JSON.stringify(
        {
          operation: "set_dispatch",
          before,
          after: { priority: input.priority, cutoffAt: input.cutoffAt },
        },
      )}::jsonb,${actorId}) returning id`);
    if (audited.rows.length !== 1)
      throw new InventoryError("Pick dispatch policy was not audited");
    return {
      id: input.pickListId,
      priority: input.priority,
      cutoffAt: input.cutoffAt,
    };
  });
}

export async function releasePickWave(
  orgId: string,
  actorId: string,
  input: {
    warehouseId: string;
    subsidiaryId: string;
    mode: "cutoff" | "priority";
    cutoffAt: string;
    pickListIds?: string[];
    commandKey: string;
  },
) {
  return withOrgTransaction(orgId, async () => {
    if (
      !Number.isFinite(Date.parse(input.cutoffAt)) ||
      input.commandKey.trim().length < 8 ||
      input.commandKey.length > 200
    )
      throw new InventoryError(
        "A wave requires a valid cutoff and stable command key",
      );
    const request = {
      ...input,
      cutoffAt: new Date(input.cutoffAt).toISOString(),
      pickListIds: input.pickListIds
        ? [...new Set(input.pickListIds)].sort()
        : null,
    };
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`pick-wave:${orgId}:${input.commandKey}`},0))`,
    );
    const prior = (
      await db.execute<{
        id: string;
        matches: boolean;
      }>(sql`select id,request=${JSON.stringify(request)}::jsonb as matches
      from pick_waves where org_id=${orgId} and command_key=${input.commandKey}`)
    ).rows[0];
    if (prior) {
      await admitExecution(db, orgId, actorId, "pick", input.subsidiaryId);
      if (!prior.matches)
        throw new InventoryError(
          "Wave key belongs to a different release request",
        );
      return { waveId: prior.id, replayed: true };
    }
    const selected = (
      await db.execute<{ id: string; priority: number; cutoff_at: string }>(sql`
      select pick.id,fd.pick_priority as priority,coalesce(fd.release_cutoff_at,pick.created_at)::text as cutoff_at
      from documents pick join fulfillment_documents fd on fd.org_id=pick.org_id and fd.document_id=pick.id
      where pick.org_id=${orgId} and pick.kind='pick_list' and pick.status='draft' and fd.stage='open'
        and pick.subsidiary_id=${input.subsidiaryId} and fd.warehouse_id=${input.warehouseId}
        and coalesce(fd.release_cutoff_at,pick.created_at)<=${input.cutoffAt}::timestamptz
        ${request.pickListIds ? sql`and pick.id=any(${request.pickListIds}::uuid[])` : sql``}
      order by ${input.mode === "priority" ? sql`fd.pick_priority desc,` : sql``}coalesce(fd.release_cutoff_at,pick.created_at),pick.id limit 500`)
    ).rows;
    if (!selected.length)
      throw new InventoryError(
        "No draft picks meet this warehouse, entity and release cutoff",
      );
    const ids = selected.map((pick) => pick.id);
    const positions = (
      await db.execute<{
        item_id: string;
        stock_location_id: string;
      }>(sql`select distinct item_id,stock_location_id from document_lines
      where org_id=${orgId} and document_id=any(${ids}::uuid[]) order by item_id,stock_location_id`)
    ).rows;
    for (const position of positions)
      await lockInventoryPosition(
        db,
        position.item_id,
        position.stock_location_id,
      );
    const scope = await lockActorCommandAuthority(
      db,
      orgId,
      actorId,
      input.subsidiaryId,
      "orders.fulfill",
    );
    if (!(await lockAndCheckOrgFeature(db, orgId, "fulfillment")))
      throw new InventoryError("Turn on Fulfillment before releasing picks");
    const current = (
      await db.execute<{
        id: string;
        priority: number;
        cutoff_at: string;
      }>(sql`select pick.id,fd.pick_priority as priority,
      coalesce(fd.release_cutoff_at,pick.created_at)::text as cutoff_at
      from documents pick join fulfillment_documents fd on fd.org_id=pick.org_id and fd.document_id=pick.id
      where pick.org_id=${orgId} and pick.id=any(${ids}::uuid[]) and pick.kind='pick_list' and pick.status='draft'
        and fd.stage='open' and fd.warehouse_id=${input.warehouseId} and pick.subsidiary_id=${input.subsidiaryId}
      order by pick.id for update of pick,fd`)
    ).rows;
    if (
      current.length !== selected.length ||
      selected.some(
        (pick) =>
          !current.some(
            (row) =>
              row.id === pick.id &&
              row.priority === pick.priority &&
              row.cutoff_at === pick.cutoff_at,
          ),
      )
    )
      throw new InventoryError(
        "Wave candidates changed; refresh the dispatch cutoff and retry with a new command key",
      );
    if (
      request.pickListIds &&
      (request.pickListIds.length !== selected.length ||
        request.pickListIds.some((id) => !ids.includes(id)))
    )
      throw new ScopeNotFoundError();
    const released = [];
    for (const pick of selected)
      released.push({
        pick,
        result: await releasePickList(orgId, actorId, {
          pickListId: pick.id,
          allowedSubsidiaryIds: scope,
        }),
      });
    const wave = (
      await db.execute<{ id: string }>(sql`insert into pick_waves
      (org_id,subsidiary_id,warehouse_id,mode,cutoff_at,status,command_key,request,created_by)
      values(${orgId},${input.subsidiaryId},${input.warehouseId},${input.mode},${input.cutoffAt}::timestamptz,
        ${released.some((row) => row.result.status === "pending_approval") ? "pending_approval" : "released"},${input.commandKey},${JSON.stringify(request)}::jsonb,${actorId}) returning id`)
    ).rows[0];
    if (!wave) throw new InventoryError("Pick wave was not recorded");
    for (const [index, row] of released.entries()) {
      const member =
        await db.execute(sql`insert into pick_wave_members(org_id,wave_id,pick_list_id,sequence,priority,cutoff_at,release_status)
        values(${orgId},${wave.id},${row.pick.id},${index + 1},${row.pick.priority},${row.pick.cutoff_at}::timestamptz,${row.result.status}) returning pick_list_id`);
      if (member.rows.length !== 1)
        throw new InventoryError("Pick wave membership was not recorded");
    }
    return {
      waveId: wave.id,
      replayed: false,
      picks: released.map((row) => row.result),
    };
  });
}
