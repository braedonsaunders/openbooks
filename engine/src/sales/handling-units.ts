import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { InventoryError } from "../inventory/contracts.ts";
import {
  loadSubsidiaryContext,
  restrictionAdmits,
} from "../organization/subsidiaries.ts";
import { resolveProfile } from "../inventory/profile-policy.ts";
import { assertSaleableStock } from "../inventory/stock-eligibility.ts";
import { lockInventoryPosition } from "../inventory/position.ts";
import { transferInventoryTx } from "../inventory/transfers.ts";
import { toBaseQuantity } from "../inventory/costing.ts";
import {
  createExecutionSuggestion,
  type ExecutionTask,
} from "../inventory/directed-execution.ts";
import { cmp } from "../money/money.ts";
import { compareDecimal } from "../money/exact-decimal.ts";
import { lockDraftShipment } from "./fulfillment.ts";
import { assertPackedUnit, type HandlingUnit } from "./handling-unit-state.ts";

interface Content extends Record<string, unknown> {
  shipment_line_id: string;
  pick_line_id: string;
  item_id: string;
  lot_id: string | null;
  serial_id: string | null;
  quantity: string;
  document_quantity: string;
  confirmed_at: string | null;
  unit: string | null;
}
async function unitById(tx: SqlExecutor, orgId: string, id: string) {
  const unit = (
    await tx.execute<HandlingUnit>(
      sql`select *,content_version::text from handling_units where org_id=${orgId} and id=${id}`,
    )
  ).rows[0];
  if (!unit) throw new ScopeNotFoundError();
  return unit;
}
async function contents(tx: SqlExecutor, orgId: string, unitId: string) {
  return (
    await tx.execute<Content>(sql`select content.*,content.quantity::text,content.document_quantity::text,line.unit
    from handling_unit_contents content join document_lines line on line.org_id=content.org_id and line.id=content.shipment_line_id
    where content.org_id=${orgId} and content.handling_unit_id=${unitId} order by content.item_id,content.shipment_line_id`)
  ).rows;
}
async function admitUnit(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  unit: Pick<HandlingUnit, "subsidiary_id">,
  requireShipping = false,
) {
  const scope = await lockActorCommandAuthority(
    tx,
    orgId,
    actorId,
    unit.subsidiary_id,
    "orders.fulfill",
  );
  for (const feature of requireShipping
    ? ["fulfillment", "shippingHub"]
    : ["fulfillment"])
    if (!(await lockAndCheckOrgFeature(tx, orgId, feature)))
      throw new InventoryError(
        `Turn on ${feature} in Company Settings → Features before handling cartons`,
      );
  return scope;
}
async function admitUnitRead(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  entityId: string,
) {
  await lockActorCommandAuthority(tx, orgId, actorId, entityId, "orders.read");
  if (!(await lockAndCheckOrgFeature(tx, orgId, "fulfillment")))
    throw new InventoryError(
      "Turn on fulfillment in Company Settings → Features before reviewing cartons",
    );
}
async function auditUnit(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  id: string,
  operation: string,
  changes: unknown,
) {
  const saved =
    await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
    values(${orgId},'handling_units',${id},'update',${JSON.stringify({ operation, changes })}::jsonb,${actorId}) returning id`);
  if (saved.rows.length !== 1)
    throw new InventoryError("Handling-unit operation was not audited");
}
async function assertNoLiveLabel(tx: SqlExecutor, orgId: string, id: string) {
  if (
    (
      await tx.execute(
        sql`select id from shipment_labels where org_id=${orgId} and handling_unit_id=${id} and status='purchased' limit 1`,
      )
    ).rows[0]
  )
    throw new InventoryError(
      "Void this handling unit's purchased label before changing its physical position or contents",
    );
}

export async function createHandlingUnit(
  orgId: string,
  actorId: string,
  input: { shipmentId: string; code: string; binId: string; lineIds: string[] },
) {
  return withOrgTransaction(orgId, async () => {
    const entity = (
      await db.execute<{
        subsidiary_id: string;
      }>(sql`select subsidiary_id from documents
      where org_id=${orgId} and id=${input.shipmentId} and kind='shipment'`)
    ).rows[0];
    if (!entity) throw new ScopeNotFoundError();
    const scope = await admitUnit(db, orgId, actorId, entity);
    const shipment = await lockDraftShipment(
      db,
      orgId,
      input.shipmentId,
      scope,
    );
    const code = input.code.trim();
    if (
      !code ||
      code.length > 60 ||
      !input.lineIds.length ||
      new Set(input.lineIds).size !== input.lineIds.length
    )
      throw new InventoryError(
        "Give the handling unit a unique code and select each carton line once",
      );
    const bin = (
      await db.execute(sql`select bin.id from stock_locations bin where bin.org_id=${orgId} and bin.id=${input.binId}
      and bin.is_active and stock_location_warehouse(${orgId}::uuid,bin.id)=${shipment.warehouse_id} for share`)
    ).rows[0];
    if (!bin)
      throw new InventoryError(
        "Select an active packing bin in the shipment warehouse",
      );
    await assertSaleableStock(db, orgId, input.binId);
    const lines = (
      await db.execute<Content>(sql`select line.id as shipment_line_id,fl.pick_line_id,line.item_id,fl.lot_id,fl.serial_id,
      line.quantity::text as document_quantity,line.unit from document_lines line
      join fulfillment_lines fl on fl.org_id=line.org_id and fl.line_id=line.id
      where line.org_id=${orgId} and line.document_id=${input.shipmentId} and line.id=any(${input.lineIds}::uuid[])
      order by line.line_number for update of line,fl`)
    ).rows;
    if (lines.length !== input.lineIds.length) throw new ScopeNotFoundError();
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`handling-unit-code:${orgId}:${code}`},0))`,
    );
    const prior = (
      await db.execute<HandlingUnit & { initial_stock_location_id: string }>(
        sql`select * from handling_units where org_id=${orgId} and code=${code}`,
      )
    ).rows[0];
    if (prior) {
      const priorLines = await contents(db, orgId, prior.id);
      if (
        prior.shipment_document_id !== input.shipmentId ||
        prior.initial_stock_location_id !== input.binId ||
        priorLines.length !== input.lineIds.length ||
        priorLines.some(
          (line) => !input.lineIds.includes(line.shipment_line_id),
        )
      )
        throw new InventoryError(
          "Carton code belongs to different contents or packing work; open that handling unit or choose a new code",
        );
      return prior;
    }
    if (
      (
        await db.execute(sql`select shipment_line_id from handling_unit_contents where org_id=${orgId}
      and shipment_line_id=any(${input.lineIds}::uuid[]) limit 1`)
      ).rows[0]
    )
      throw new InventoryError(
        "A selected line already belongs to a handling unit; open that carton",
      );
    const unit = (
      await db.execute<HandlingUnit>(sql`insert into handling_units
      (org_id,subsidiary_id,code,warehouse_id,current_stock_location_id,initial_stock_location_id,shipment_document_id,created_by,updated_by)
      values(${orgId},${entity.subsidiary_id},${code},${shipment.warehouse_id},${input.binId},${input.binId},${input.shipmentId},${actorId},${actorId}) returning *`)
    ).rows[0];
    if (!unit) throw new InventoryError("Handling unit was not created");
    for (const line of lines) {
      const profile = await resolveProfile(orgId, line.item_id, db);
      const row = await db.execute(sql`insert into handling_unit_contents
        (org_id,handling_unit_id,shipment_line_id,pick_line_id,item_id,lot_id,serial_id,quantity,document_quantity)
        values(${orgId},${unit.id},${line.shipment_line_id},${line.pick_line_id},${line.item_id},${line.lot_id},${line.serial_id},
          ${toBaseQuantity(line.document_quantity, line.unit, profile.unitConversions ?? {}, profile.baseUnit)},${line.document_quantity}) returning shipment_line_id`);
      if (row.rows.length !== 1)
        throw new InventoryError("Carton contents were not assigned");
      const carton =
        await db.execute(sql`update fulfillment_lines set carton=${code},updated_at=now(),updated_by=${actorId}
        where org_id=${orgId} and line_id=${line.shipment_line_id} and document_id=${input.shipmentId} returning line_id`);
      if (carton.rows.length !== 1)
        throw new InventoryError("Shipment carton identity was not saved");
    }
    await auditUnit(db, orgId, actorId, unit.id, "create_carton", {
      code,
      binId: input.binId,
      lineIds: input.lineIds,
    });
    return unit;
  });
}

export async function suggestPackConfirmation(
  orgId: string,
  actorId: string,
  input: { unitId: string; lineId: string; commandKey: string },
) {
  return withOrgTransaction(orgId, async () => {
    const unit = await unitById(db, orgId, input.unitId);
    const scope = await admitUnit(db, orgId, actorId, unit);
    await lockDraftShipment(db, orgId, unit.shipment_document_id, scope);
    if (unit.status !== "open")
      throw new InventoryError(
        "Open this carton for packing before confirming a line",
      );
    const content = (await contents(db, orgId, unit.id)).find(
      (row) => row.shipment_line_id === input.lineId,
    );
    if (!content || content.confirmed_at)
      throw new InventoryError(
        "Select an unconfirmed line assigned to this carton",
      );
    const line = (
      await db.execute<{
        stock_location_id: string;
        document_date: string;
      }>(sql`select line.stock_location_id,doc.document_date::text
      from document_lines line join documents doc on doc.org_id=line.org_id and doc.id=line.document_id
      where line.org_id=${orgId} and line.id=${input.lineId}`)
    ).rows[0]!;
    return createExecutionSuggestion(db, orgId, actorId, {
      stage: "pack",
      subsidiaryId: unit.subsidiary_id,
      itemId: content.item_id,
      documentLineId: input.lineId,
      fromStockLocationId: line.stock_location_id,
      toStockLocationId: unit.current_stock_location_id,
      quantity: content.quantity,
      documentQuantity: content.document_quantity,
      documentUnit: content.unit,
      lotId: content.lot_id,
      serialId: content.serial_id,
      postingDate: line.document_date,
      basis: { unitId: unit.id, version: unit.content_version },
      commandKey: input.commandKey,
    });
  });
}

async function moveContent(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  unit: HandlingUnit,
  content: Content,
  from: string,
  to: string,
  date: string,
) {
  await assertSaleableStock(tx, orgId, to, {
    lotId: content.lot_id,
    serialId: content.serial_id,
  });
  const pick = (
    await tx.execute<{
      picked_quantity: string;
      current_stock_location_id: string;
    }>(sql`select picked_quantity::text,current_stock_location_id
    from pick_execution_lines where org_id=${orgId} and line_id=${content.pick_line_id} for update`)
  ).rows[0];
  if (
    !pick ||
    compareDecimal(pick.picked_quantity, content.document_quantity) !== 0 ||
    pick.current_stock_location_id !== from
  )
    throw new InventoryError(
      "Confirm the full shipment quantity on its pick line before moving this carton",
    );
  const movement =
    from === to
      ? null
      : await transferInventoryTx(tx, orgId, actorId, {
          itemId: content.item_id,
          fromStockLocationId: from,
          toStockLocationId: to,
          quantity: content.quantity,
          subsidiaryId: unit.subsidiary_id,
          lotId: content.lot_id,
          serialId: content.serial_id,
          date,
          memo: `Handling unit ${unit.code}`,
        });
  const line =
    await tx.execute(sql`update document_lines set stock_location_id=${to},updated_at=now(),updated_by=${actorId}
    where org_id=${orgId} and id=${content.shipment_line_id} and document_id=${unit.shipment_document_id}
      and stock_location_id=${from} and item_id=${content.item_id} and quantity=${content.document_quantity} returning id`);
  const reservation =
    await tx.execute(sql`update pick_execution_lines set current_stock_location_id=${to}
    where org_id=${orgId} and line_id=${content.pick_line_id} and current_stock_location_id=${from} returning line_id`);
  if (line.rows.length !== 1 || reservation.rows.length !== 1)
    throw new InventoryError(
      "Shipment or reservation changed while moving its handling unit",
    );
  return movement;
}

export async function executePackDirection(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  task: ExecutionTask,
): Promise<Record<string, unknown>> {
  if (task.stage !== "pack")
    throw new InventoryError("Select a carton pack confirmation");
  const observed = await unitById(tx, orgId, String(task.basis.unitId));
  const scope = await admitUnit(tx, orgId, actorId, observed);
  await lockDraftShipment(tx, orgId, observed.shipment_document_id, scope);
  const unit = (
    await tx.execute<HandlingUnit>(sql`select *,content_version::text from handling_units
    where org_id=${orgId} and id=${observed.id} for update`)
  ).rows[0]!;
  if (
    unit.status !== "open" ||
    unit.current_stock_location_id !== task.to_stock_location_id ||
    unit.content_version !== String(task.basis.version)
  )
    throw new InventoryError(
      "Carton contents, position or status changed; refresh the pack suggestion",
    );
  const content = (await contents(tx, orgId, unit.id)).find(
    (row) => row.shipment_line_id === task.document_line_id,
  );
  if (
    !content ||
    content.confirmed_at ||
    content.item_id !== task.item_id ||
    content.lot_id !== task.lot_id ||
    content.serial_id !== task.serial_id ||
    cmp(content.quantity, task.quantity) !== 0 ||
    compareDecimal(content.document_quantity, task.document_quantity) !== 0
  )
    throw new InventoryError(
      "Carton contents changed; refresh its pack suggestion",
    );
  await assertNoLiveLabel(tx, orgId, unit.id);
  const movement = await moveContent(
    tx,
    orgId,
    actorId,
    unit,
    content,
    task.from_stock_location_id,
    task.to_stock_location_id,
    task.posting_date,
  );
  const confirmed =
    await tx.execute(sql`update handling_unit_contents set confirmation_task_id=${task.id},confirmed_at=now(),confirmed_by=${actorId}
    where org_id=${orgId} and handling_unit_id=${unit.id} and shipment_line_id=${content.shipment_line_id} and confirmed_at is null returning shipment_line_id`);
  const version =
    await tx.execute(sql`update handling_units set content_version=content_version+1,updated_at=now(),updated_by=${actorId}
    where org_id=${orgId} and id=${unit.id} and status='open' returning id`);
  if (confirmed.rows.length !== 1 || version.rows.length !== 1)
    throw new InventoryError("Carton confirmation was not recorded");
  await auditUnit(tx, orgId, actorId, unit.id, "confirm_contents", {
    lineId: content.shipment_line_id,
    movement,
    taskId: task.id,
  });
  return { unitId: unit.id, lineId: content.shipment_line_id, movement };
}

export async function sealHandlingUnit(
  orgId: string,
  actorId: string,
  unitId: string,
) {
  return withOrgTransaction(orgId, async () => {
    const observed = await unitById(db, orgId, unitId);
    const scope = await admitUnit(db, orgId, actorId, observed);
    await lockDraftShipment(db, orgId, observed.shipment_document_id, scope);
    const unit = (
      await db.execute<HandlingUnit>(
        sql`select * from handling_units where org_id=${orgId} and id=${unitId} for update`,
      )
    ).rows[0]!;
    if (unit.status !== "open" && unit.status !== "packed")
      throw new InventoryError("This handling unit cannot be packed");
    const rows = await contents(db, orgId, unit.id);
    if (!rows.length || rows.some((row) => !row.confirmed_at))
      throw new InventoryError(
        "Confirm every suggested carton line before marking it packed",
      );
    if (unit.status === "open") {
      const changed =
        await db.execute(sql`update handling_units set status='packed',updated_at=now(),updated_by=${actorId}
        where org_id=${orgId} and id=${unit.id} and status='open' returning id`);
      if (changed.rows.length !== 1)
        throw new InventoryError("Handling unit changed before packing");
      await auditUnit(db, orgId, actorId, unit.id, "pack_carton", {
        lineIds: rows.map((row) => row.shipment_line_id),
      });
    }
    await assertPackedUnit(db, orgId, unit.shipment_document_id, unit.id);
    return { id: unit.id, status: "packed" };
  });
}

export async function moveHandlingUnit(
  orgId: string,
  actorId: string,
  input: {
    unitId: string;
    toBinId: string;
    date: string;
    reason: string;
    commandKey: string;
  },
) {
  return withOrgTransaction(orgId, async () => {
    const observed = await unitById(db, orgId, input.unitId);
    const rows = await contents(db, orgId, observed.id);
    for (const key of [
      ...new Set(
        rows.flatMap((row) => [
          `${row.item_id}:${observed.current_stock_location_id}`,
          `${row.item_id}:${input.toBinId}`,
        ]),
      ),
    ].sort()) {
      const [item, bin] = key.split(":");
      await lockInventoryPosition(db, item!, bin!);
    }
    const scope = await admitUnit(db, orgId, actorId, observed, true);
    await lockDraftShipment(db, orgId, observed.shipment_document_id, scope);
    const unit = (
      await db.execute<HandlingUnit>(
        sql`select *,content_version::text from handling_units where org_id=${orgId} and id=${input.unitId} for update`,
      )
    ).rows[0]!;
    if (unit.current_stock_location_id !== observed.current_stock_location_id)
      throw new InventoryError(
        "Handling unit moved while this request waited; reload its position and retry",
      );
    if (
      input.commandKey.trim().length < 8 ||
      input.commandKey.length > 200 ||
      input.reason.trim().length < 5 ||
      input.reason.trim().length > 500
    )
      throw new InventoryError(
        "Moving a handling unit requires a stable command key and a reason of 5–500 characters",
      );
    const request = {
      toBinId: input.toBinId,
      date: input.date,
      reason: input.reason.trim(),
    };
    const prior = (
      await db.execute<{
        id: string;
        matches: boolean;
      }>(sql`select id,request=${JSON.stringify(request)}::jsonb as matches
      from handling_unit_moves where org_id=${orgId} and handling_unit_id=${unit.id} and command_key=${input.commandKey}`)
    ).rows[0];
    if (prior) {
      if (!prior.matches)
        throw new InventoryError("Move key belongs to different carton work");
      return { id: prior.id, replayed: true };
    }
    await assertPackedUnit(db, orgId, unit.shipment_document_id, unit.id);
    await assertNoLiveLabel(db, orgId, unit.id);
    if (unit.current_stock_location_id === input.toBinId)
      throw new InventoryError(
        "Select a different destination bin for this handling unit",
      );
    const target = (
      await db.execute(sql`select id from stock_locations where org_id=${orgId} and id=${input.toBinId}
      and is_active and stock_location_warehouse(${orgId}::uuid,id)=${unit.warehouse_id} for share`)
    ).rows[0];
    if (!target)
      throw new InventoryError(
        "Move the handling unit to an active bin in its warehouse",
      );
    const movements = [];
    for (const content of rows)
      movements.push({
        shipmentLineId: content.shipment_line_id,
        ...(await moveContent(
          db,
          orgId,
          actorId,
          unit,
          content,
          unit.current_stock_location_id,
          input.toBinId,
          input.date,
        )),
      });
    const changed =
      await db.execute(sql`update handling_units set current_stock_location_id=${input.toBinId},content_version=content_version+1,
      updated_at=now(),updated_by=${actorId} where org_id=${orgId} and id=${unit.id} and current_stock_location_id=${unit.current_stock_location_id} returning id`);
    if (changed.rows.length !== 1)
      throw new InventoryError(
        "Handling unit moved concurrently; reload its position",
      );
    const move = (
      await db.execute<{ id: string }>(sql`insert into handling_unit_moves
      (org_id,handling_unit_id,from_stock_location_id,to_stock_location_id,moved_on,command_key,request,movements,reason,created_by)
      values(${orgId},${unit.id},${unit.current_stock_location_id},${input.toBinId},${input.date},${input.commandKey},
        ${JSON.stringify(request)}::jsonb,${JSON.stringify(movements)}::jsonb,${input.reason.trim()},${actorId}) returning id`)
    ).rows[0];
    if (!move) throw new InventoryError("Handling-unit move was not recorded");
    await auditUnit(db, orgId, actorId, unit.id, "move_carton", {
      from: unit.current_stock_location_id,
      to: input.toBinId,
      movements,
      reason: input.reason.trim(),
    });
    return { id: move.id, replayed: false, movements };
  });
}

export async function getHandlingUnits(
  orgId: string,
  actorId: string,
  shipmentId: string,
) {
  return withOrgTransaction(orgId, async () => {
    const subject = (
      await db.execute<{
        subsidiary_id: string;
      }>(sql`select subsidiary_id from documents
      where org_id=${orgId} and id=${shipmentId} and kind='shipment'`)
    ).rows[0];
    if (!subject) throw new ScopeNotFoundError();
    await admitUnitRead(db, orgId, actorId, subject.subsidiary_id);
    const units = (
      await db.execute<
        HandlingUnit & { bin_code: string }
      >(sql`select unit.*,unit.content_version::text,bin.code as bin_code
      from handling_units unit join stock_locations bin on bin.org_id=unit.org_id and bin.id=unit.current_stock_location_id
      where unit.org_id=${orgId} and unit.shipment_document_id=${shipmentId} order by unit.created_at,unit.id`)
    ).rows;
    return Promise.all(
      units.map(async (unit) => ({
        id: unit.id,
        code: unit.code,
        status: unit.status,
        binId: unit.current_stock_location_id,
        binCode: unit.bin_code,
        version: unit.content_version,
        lines: (await contents(db, orgId, unit.id)).map((row) => ({
          lineId: row.shipment_line_id,
          itemId: row.item_id,
          quantity: row.document_quantity,
          confirmed: row.confirmed_at !== null,
        })),
      })),
    );
  });
}

export async function handlingUnitBinOptions(
  orgId: string,
  actorId: string,
  shipmentId: string,
) {
  return withOrgTransaction(orgId, async () => {
    const subject = (
      await db.execute<{
        subsidiary_id: string;
        warehouse_id: string;
      }>(sql`select doc.subsidiary_id,fd.warehouse_id from documents doc
      join fulfillment_documents fd on fd.org_id=doc.org_id and fd.document_id=doc.id
      where doc.org_id=${orgId} and doc.id=${shipmentId} and doc.kind='shipment'`)
    ).rows[0];
    if (!subject) throw new ScopeNotFoundError();
    await admitUnitRead(db, orgId, actorId, subject.subsidiary_id);
    const context = await loadSubsidiaryContext(db, orgId);
    const bins = (
      await db.execute<{
        id: string;
        code: string;
        subsidiary_id: string | null;
        include_children: boolean;
      }>(sql`
      select bin.id,bin.code,location.subsidiary_id,location.subsidiary_include_children as include_children
      from stock_locations bin join locations location on location.org_id=bin.org_id and location.id=bin.location_id
      where bin.org_id=${orgId} and bin.is_active and bin.inventory_ownership='owned' and bin.kind not in('quarantine','transit')
        and stock_location_warehouse(${orgId}::uuid,bin.id)=${subject.warehouse_id} order by bin.code,bin.id`)
    ).rows;
    return bins
      .filter((bin) =>
        restrictionAdmits(
          context,
          bin.subsidiary_id,
          bin.include_children,
          subject.subsidiary_id,
        ),
      )
      .map((bin) => ({ id: bin.id, code: bin.code }));
  });
}
