import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import { sql } from "drizzle-orm";
import type { AssemblyBomRevisionEvidence } from "@openbooks/schema";
import { db, env } from "./db.ts";
import {
  buildAssembly,
  getOnHand,
  receiveInventory,
} from "./inventory.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (pattern.test(current.message)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

async function quietly(statement: string): Promise<void> {
  try {
    await db.execute(sql.raw(statement));
  } catch {
    // Failure-injector cleanup must never mask the test's own result.
  }
}

test("assembly builds acquire and snapshot the BOM inside their transaction", () => {
  const source = readFileSync(new URL("./inventory.ts", import.meta.url), "utf8");
  const start = source.indexOf("export async function buildAssembly(");
  const end = source.indexOf("export async function reverseAssemblyBuild(", start);
  assert.ok(start >= 0 && end > start, "buildAssembly source must be present");
  const build = source.slice(start, end);
  const transaction = build.indexOf("return await db.transaction");
  const lock = build.indexOf("lock table bom_components in share mode", transaction);
  const snapshot = build.indexOf("from bom_components", lock);
  const profileSnapshot = build.indexOf("resolveProfile(orgId, itemId, tx, true)", snapshot);
  const journalEvidence = build.indexOf("custom: { assemblyBuild: bomEvidence }", snapshot);

  assert.ok(transaction >= 0, "the build must be one database transaction");
  assert.ok(lock > transaction, "the transaction must serialize concurrent BOM writes");
  assert.ok(snapshot > lock, "the build must read the BOM only after acquiring its lock");
  assert.equal(
    build.slice(0, transaction).includes("from bom_components"),
    false,
    "no mutable BOM read may occur before the transaction",
  );
  assert.equal(
    build.slice(0, transaction).includes("resolveProfile("),
    false,
    "no mutable costing profile read may occur before the transaction",
  );
  assert.ok(
    profileSnapshot > snapshot,
    "the profiles used for valuation must be locked in the BOM transaction",
  );
  assert.ok(
    journalEvidence > snapshot,
    "the posted operation must retain the exact BOM revision evidence",
  );
});

test(
  "an in-flight build waits for a BOM edit, re-reads it, and retains finished-layer provenance",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const editor = new pg.Client({ connectionString: env.OPENBOOKS_DB_URL });
    await editor.connect();
    let editorCommitted = false;
    let pendingBuild: ReturnType<typeof buildAssembly> | undefined;
    try {
      await receiveInventory(org.orgId, null, {
        itemId: org.items.component,
        stockLocationId: org.stockLocationId,
        quantity: "6",
        unitCost: "1",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      });

      await editor.query("begin");
      await editor.query("select set_config('app.bypass_rls', 'on', true)");
      await editor.query("lock table bom_components in row exclusive mode");
      await editor.query(
        `update bom_components
            set quantity_per = '3', updated_at = now()
          where org_id = $1 and assembly_item_id = $2`,
        [org.orgId, org.items.assembly],
      );

      pendingBuild = buildAssembly(org.orgId, null, {
        assemblyItemId: org.items.assembly,
        quantity: "2",
        stockLocationId: org.stockLocationId,
        subsidiaryId: org.subsidiaryId,
        date: org.date,
      });

      let queuedOnBom = false;
      for (let waited = 0; waited < 10_000 && !queuedOnBom; waited += 25) {
        const waiting = (await db.execute<{ waiting: boolean }>(sql`
          select exists(
            select 1
              from pg_locks
             where relation = 'bom_components'::regclass
               and mode = 'ShareLock'
               and granted = false
          ) as waiting
        `)).rows[0]?.waiting;
        queuedOnBom = waiting === true;
        if (!queuedOnBom) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(
        queuedOnBom,
        true,
        "the build must wait until the concurrent BOM revision commits",
      );

      await editor.query("commit");
      editorCommitted = true;
      const built = await pendingBuild;
      assert.equal(built.value, "6.0000", "the committed quantity-per revision must drive cost");

      const operation = (await db.execute<{
        custom: { assemblyBuild?: AssemblyBomRevisionEvidence };
        consumed_quantity: string;
      }>(sql`
        select entry.custom,
               (select quantity
                  from inventory_movements consumed
                 where consumed.org_id = movement.org_id
                   and consumed.journal_entry_id = movement.journal_entry_id
                   and consumed.kind = 'assembly_consume') as consumed_quantity
          from cost_layers layer
          join inventory_movements movement
            on movement.org_id = layer.org_id
           and movement.id = layer.source_movement_id
          join journal_entries entry
            on entry.org_id = movement.org_id
           and entry.id = movement.journal_entry_id
         where layer.org_id = ${org.orgId}
           and layer.source_movement_id = ${built.movementId}
      `)).rows[0];
      assert.ok(operation, "the finished layer must resolve to its build operation");
      assert.equal(operation.consumed_quantity, "-6.0000");
      assert.deepEqual(operation.custom.assemblyBuild, {
        format: "openbooks.inventory-bom.v1",
        revision: built.bomRevision,
        assemblyItemId: org.items.assembly,
        components: [
          {
            componentItemId: org.items.component,
            quantityPer: "3.0000",
            sortOrder: 0,
          },
        ],
      });
      assert.match(built.bomRevision, /^sha256:[0-9a-f]{64}$/);
    } finally {
      if (!editorCommitted) await editor.query("rollback").catch(() => undefined);
      await editor.end().catch(() => undefined);
      await pendingBuild?.catch(() => undefined);
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a late assembly-build failure rolls back consumption, journal, movement, and finished layer",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const guard = `assembly_build_fault_${randomUUID().replaceAll("-", "")}`;
    try {
      await receiveInventory(org.orgId, null, {
        itemId: org.items.component,
        stockLocationId: org.stockLocationId,
        quantity: "10",
        unitCost: "1",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      });
      const beforeComponent = await getOnHand(
        org.orgId,
        org.items.component,
        org.stockLocationId,
      );
      const beforeCounts = (await db.execute<{
        movements: number;
        entries: number;
        layers: number;
      }>(sql`
        select (select count(*)::int from inventory_movements where org_id = ${org.orgId}) as movements,
               (select count(*)::int from journal_entries where org_id = ${org.orgId}) as entries,
               (select count(*)::int from cost_layers where org_id = ${org.orgId}) as layers
      `)).rows[0]!;

      await db.execute(sql.raw(`
        create function "${guard}"() returns trigger language plpgsql as $fn$
        begin
          if new.org_id = '${org.orgId}'::uuid and new.kind = 'assembly_build' then
            raise exception 'forced late assembly build failure';
          end if;
          return new;
        end
        $fn$`));
      await db.execute(sql.raw(`
        create trigger "${guard}_trg"
          before insert on inventory_movements
          for each row execute function "${guard}"()`));

      await assert.rejects(
        buildAssembly(org.orgId, null, {
          assemblyItemId: org.items.assembly,
          quantity: "2",
          stockLocationId: org.stockLocationId,
          subsidiaryId: org.subsidiaryId,
          date: org.date,
        }),
        (error: unknown) => errorChainMatches(error, /forced late assembly build failure/),
      );

      const afterCounts = (await db.execute<{
        movements: number;
        entries: number;
        layers: number;
      }>(sql`
        select (select count(*)::int from inventory_movements where org_id = ${org.orgId}) as movements,
               (select count(*)::int from journal_entries where org_id = ${org.orgId}) as entries,
               (select count(*)::int from cost_layers where org_id = ${org.orgId}) as layers
      `)).rows[0]!;
      assert.deepEqual(afterCounts, beforeCounts);
      assert.deepEqual(
        await getOnHand(org.orgId, org.items.component, org.stockLocationId),
        beforeComponent,
        "component quantity and carrying value must be restored",
      );
      assert.equal(
        (await getOnHand(org.orgId, org.items.assembly, org.stockLocationId)).quantity,
        "0.0000",
      );
    } finally {
      await quietly(`drop trigger if exists "${guard}_trg" on inventory_movements`);
      await quietly(`drop function if exists "${guard}"()`);
      await dropScratchOrg(org.orgId);
    }
  },
);
