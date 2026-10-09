import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { createScratchUser } from "./fixtures.ts";
import { confirmExecutionTask } from "../inventory/directed-execution.ts";
import {
  suggestPickConfirmation,
  executePickDirection,
} from "../sales/pick-execution.ts";
import {
  createHandlingUnit,
  suggestPackConfirmation,
  executePackDirection,
  sealHandlingUnit,
} from "../sales/handling-units.ts";

/** Real assigned grants for operators exercising directed stock and shipping commands. */
export async function createWarehouseOperator(
  orgId: string,
  name: string,
): Promise<string> {
  const actor = await createScratchUser(orgId, name, "warehouse_operator");
  const grant = await db.execute(sql`update app_roles set permissions=
    '["items.read","items.post","items.manage","orders.read","orders.fulfill","shipping.manage"]'::jsonb
    where org_id=${orgId} and id in (select role_id from role_assignments
      where org_id=${orgId} and user_id=${actor}) returning id`);
  assert.ok(
    grant.rows.length,
    "operator requires a native assigned permission grant",
  );
  return actor;
}

/** Manual execution is admitted only when the fixture keeps Barcode scanning disabled. */
export async function confirmFixturePick(
  orgId: string,
  actorId: string,
  pickId: string,
): Promise<void> {
  const lines = await withOrgTransaction(orgId, () =>
    db.execute<{ id: string; quantity: string }>(sql`
    select id,quantity::text from document_lines where org_id=${orgId} and document_id=${pickId} order by line_number`),
  );
  assert.ok(lines.rows.length);
  for (const line of lines.rows) {
    const task = await suggestPickConfirmation(orgId, actorId, {
      lineId: line.id,
      quantity: line.quantity,
      commandKey: randomUUID(),
    });
    const result = await confirmExecutionTask(
      orgId,
      actorId,
      { taskId: task.id },
      (tx, current) => executePickDirection(tx, orgId, actorId, current),
    );
    assert.equal(result.status, "done");
  }
}

export async function packFixtureShipment(
  orgId: string,
  actorId: string,
  shipmentId: string,
  binId: string,
  lineIds?: readonly string[],
): Promise<string> {
  const lines = await withOrgTransaction(orgId, () =>
    db.execute<{ id: string }>(sql`
    select id from document_lines where org_id=${orgId} and document_id=${shipmentId} order by line_number`),
  );
  const selected = lineIds
    ? lines.rows.filter((line) => lineIds.includes(line.id))
    : lines.rows;
  assert.ok(
    selected.length && (!lineIds || selected.length === lineIds.length),
  );
  const unit = await createHandlingUnit(orgId, actorId, {
    shipmentId,
    code: `BOX-${randomUUID()}`,
    binId,
    lineIds: selected.map((line) => line.id),
  });
  for (const line of selected) {
    const task = await suggestPackConfirmation(orgId, actorId, {
      unitId: unit.id,
      lineId: line.id,
      commandKey: randomUUID(),
    });
    const result = await confirmExecutionTask(
      orgId,
      actorId,
      { taskId: task.id },
      (tx, current) => executePackDirection(tx, orgId, actorId, current),
    );
    assert.equal(result.status, "done");
  }
  assert.equal(
    (await sealHandlingUnit(orgId, actorId, unit.id)).status,
    "packed",
  );
  return unit.id;
}
