import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  db,
  withBypassContext,
  withOrgContext,
} from "@openbooks/engine/src/platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "@openbooks/engine/src/testing/fixtures.ts";
import { createWarehouseOperator } from "@openbooks/engine/src/testing/warehouse-execution.ts";
import {
  createStockCount,
  startStockCount,
} from "@openbooks/engine/src/inventory/stock-counts.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const session = { orgId: "", actorId: "" };
Object.assign(globalThis, { __warehouseExecutionSession: session });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/lib/feature-gates")
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(`
    export async function guardFeaturePermission() {
      const s=globalThis.__warehouseExecutionSession;
      return {user:{orgId:s.orgId,id:s.actorId},permissions:new Set(['*']),allowedSubsidiaryIds:null};
    }`),
      };
    return next(specifier, context);
  },
});
const { POST } = await import("./route");
const native = <T>(work: () => Promise<T>) => withBypassContext(work);
const post = (body: Record<string, unknown>) =>
  withOrgContext(session.orgId, () =>
    POST(
      new Request("http://warehouse.test/api/inventory/execution", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    ),
  );

test(
  "execution API rechecks hidden, empty, wrong-tenant and revoked authority behind a stale session",
  { skip: !DB },
  async () => {
    const org = await native(() => createScratchOrg()),
      foreign = await native(() => createScratchOrg());
    let scenarioError: unknown;
    try {
      const actor = await native(() =>
        createWarehouseOperator(org.orgId, "Counter"),
      );
      const hidden = randomUUID();
      await native(async () => {
        await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)
        ||'{"inventory":true,"barcodeScanning":false}'::jsonb) where id=${org.orgId}`);
        await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
        values(${hidden},${org.orgId},${org.subsidiaryId},'Hidden count entity','CAD','CA')`);
      });
      const makeCount = async (entity: string) => {
        const count = await native(() =>
          createStockCount(org.orgId, actor, {
            locationId: org.locationId,
            subsidiaryId: entity,
            countedOn: org.date,
            blind: true,
            lines: [
              { itemId: org.items.fifo, stockLocationId: org.stockLocationId },
            ],
          }),
        );
        await native(() => startStockCount(org.orgId, actor, count.id));
        return (
          await native(() =>
            db.execute<{ id: string }>(
              sql`select id from stock_count_lines where org_id=${org.orgId} and stock_count_id=${count.id}`,
            ),
          )
        ).rows[0]!.id;
      };
      const visible = await makeCount(org.subsidiaryId),
        invisible = await makeCount(hidden);
      session.orgId = org.orgId;
      session.actorId = actor;
      const restrict = (
        ids: string[],
        permissions = ["items.read", "items.post"],
      ) =>
        native(() =>
          db.execute(sql`update app_roles
      set permissions=${JSON.stringify(permissions)}::jsonb,subsidiary_restriction=${JSON.stringify({ mode: "list", subsidiaryIds: ids })}::jsonb
      where org_id=${org.orgId} and key='warehouse_operator'`),
        );
      await restrict([org.subsidiaryId]);
      const suggest = (lineId: string) =>
        post({
          action: "count",
          lineId,
          quantity: "0",
          observation: "first",
          commandKey: randomUUID(),
        });
      const allowed = await suggest(visible);
      assert.equal(allowed.status, 200);
      const payload = (await allowed.json()) as {
        task: { id: string; quantity: string; expectedQuantity?: string };
      };
      assert.ok(payload.task.id);
      assert.ok(!("expectedQuantity" in payload.task));
      assert.equal((await suggest(invisible)).status, 404);
      await restrict([]);
      assert.equal((await suggest(visible)).status, 404);
      assert.equal(
        (await post({ action: "confirm", taskId: payload.task.id })).status,
        404,
      );
      await restrict([org.subsidiaryId]);
      session.orgId = foreign.orgId;
      assert.ok(
        (await post({ action: "confirm", taskId: payload.task.id })).status >=
          400,
      );
      session.orgId = org.orgId;
      await native(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,inventory}','false') where id=${org.orgId}`,
        ),
      );
      assert.ok(
        (await post({ action: "confirm", taskId: payload.task.id })).status >=
          400,
      );
      await native(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,inventory}','true') where id=${org.orgId}`,
        ),
      );
      await restrict([org.subsidiaryId], []);
      assert.equal(
        (await post({ action: "confirm", taskId: payload.task.id })).status,
        404,
      );
      await restrict([org.subsidiaryId]);
      const done = await post({ action: "confirm", taskId: payload.task.id });
      assert.equal(done.status, 200);
      assert.equal((await done.json()).status, "done");
      const before = (
        await native(() =>
          db.execute(
            sql`select id from inventory_movements where org_id=${org.orgId}`,
          ),
        )
      ).rows;
      const replay = await post({ action: "confirm", taskId: payload.task.id });
      assert.equal(replay.status, 200);
      assert.equal((await replay.json()).replayed, true);
      assert.deepEqual(
        (
          await native(() =>
            db.execute(
              sql`select id from inventory_movements where org_id=${org.orgId}`,
            ),
          )
        ).rows,
        before,
      );
    } catch (error) {
      scenarioError = error;
      throw error;
    } finally {
      try {
        await native(() => dropScratchOrg(foreign.orgId));
        await native(() => dropScratchOrg(org.orgId));
      } catch (cleanupError) {
        throw scenarioError
          ? new AggregateError(
              [scenarioError, cleanupError],
              "Execution route scenario and cleanup failed",
            )
          : cleanupError;
      }
    }
  },
);
