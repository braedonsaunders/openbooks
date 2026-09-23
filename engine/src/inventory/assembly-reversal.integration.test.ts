import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { getOnHand } from "./position.ts";
import { receiveInventory } from "./movements.ts";
import { buildAssembly, reverseAssemblyBuild } from "./assembly.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const REASON = "built the wrong quantity, unwinding the test build";

/**
 * IN2: an assembly build must be reversible. reverseAssemblyBuild restores
 * component stock and layers, removes the finished-good layer, and mirrors
 * the build journal — idempotently, from either leg of the operation.
 */

async function stockedOrg(): Promise<ScratchOrg> {
  const org = await createScratchOrg();
  await receiveInventory(org.orgId, null, {
    itemId: org.items.component,
    stockLocationId: org.stockLocationId,
    quantity: "10",
    unitCost: "1",
    subsidiaryId: org.subsidiaryId,
    offsetAccountId: org.accounts.clearing,
    date: org.date,
  });
  return org;
}

async function movementCount(orgId: string): Promise<number> {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from inventory_movements where org_id = ${orgId}`)).rows[0]!.n;
}

/** Every account touched by the build must net to exactly zero after reversal. */
async function glNetsToZero(orgId: string, entryIds: (string | null)[]): Promise<void> {
  const ids = entryIds.filter((id): id is string => id !== null);
  const rows = (await db.execute<{ account: string; net: string }>(sql`
    select account_id::text as account, sum(amount)::text as net
      from journal_lines
     where org_id = ${orgId} and entry_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
     group by account_id`)).rows;
  assert.ok(rows.length > 0, "the build and its reversal must leave journal evidence");
  for (const row of rows) {
    assert.equal(row.net, "0.0000", `account ${row.account} must net to zero across build + reversal`);
  }
}

test("reversing a build restores stock and GL exactly, and never double-reverses", { skip: !DB }, async () => {
  const org = await stockedOrg();
  try {
    const componentBefore = await getOnHand(org.orgId, org.items.component, org.stockLocationId);
    const assemblyBefore = await getOnHand(org.orgId, org.items.assembly, org.stockLocationId);

    const built = await buildAssembly(org.orgId, null, {
      assemblyItemId: org.items.assembly,
      quantity: "2",
      stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
    });

    const reversed = await reverseAssemblyBuild(org.orgId, randomUUID(), {
      movementId: built.movementId,
      reversalDate: org.date,
      reason: REASON,
    });
    assert.equal(reversed.alreadyReversed, false);

    assert.deepEqual(
      await getOnHand(org.orgId, org.items.component, org.stockLocationId),
      componentBefore,
      "component quantity and carrying value must be restored exactly",
    );
    assert.deepEqual(
      await getOnHand(org.orgId, org.items.assembly, org.stockLocationId),
      assemblyBefore,
      "finished-good stock must be removed exactly",
    );
    await glNetsToZero(org.orgId, [built.entryId, reversed.entryId]);

    const movementsAfterReverse = await movementCount(org.orgId);
    const again = await reverseAssemblyBuild(org.orgId, randomUUID(), {
      movementId: built.movementId,
      reversalDate: org.date,
      reason: REASON,
    });
    assert.equal(again.alreadyReversed, true, "a second reversal must replay, not post");
    assert.equal(await movementCount(org.orgId), movementsAfterReverse, "no second reversal may be written");
    assert.deepEqual(
      await getOnHand(org.orgId, org.items.component, org.stockLocationId),
      componentBefore,
      "the replay must not move stock",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("reversing from a consume leg reverses the whole operation", { skip: !DB }, async () => {
  const org = await stockedOrg();
  try {
    const componentBefore = await getOnHand(org.orgId, org.items.component, org.stockLocationId);
    const built = await buildAssembly(org.orgId, null, {
      assemblyItemId: org.items.assembly,
      quantity: "2",
      stockLocationId: org.stockLocationId,
      subsidiaryId: org.subsidiaryId,
      date: org.date,
    });
    const consume = (await db.execute<{ id: string }>(sql`
      select id from inventory_movements
       where org_id = ${org.orgId} and journal_entry_id = ${built.entryId} and kind = 'assembly_consume'`)).rows[0]!.id;
    const reversed = await reverseAssemblyBuild(org.orgId, randomUUID(), {
      movementId: consume,
      reversalDate: org.date,
      reason: REASON,
    });
    assert.equal(reversed.alreadyReversed, false);
    assert.deepEqual(
      await getOnHand(org.orgId, org.items.component, org.stockLocationId),
      componentBefore,
      "reversing from the consume leg must still restore component stock",
    );
    assert.equal(
      (await getOnHand(org.orgId, org.items.assembly, org.stockLocationId)).quantity,
      "0.0000",
      "reversing from the consume leg must still remove finished stock",
    );
    await glNetsToZero(org.orgId, [built.entryId, reversed.entryId]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
