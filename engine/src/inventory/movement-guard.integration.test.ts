import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { InventoryError } from "./contracts.ts";
import { receiveInventory } from "./movements.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Drizzle wraps Postgres errors (message holds the query text, the guard
 * text rides `cause`), so match across the whole chain like close.test.ts. */
function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  const messages: string[] = [];
  for (
    let current: unknown = error;
    current && typeof current === "object";
    current = (current as { cause?: unknown }).cause
  ) {
    messages.push(String((current as { message?: unknown }).message ?? ""));
  }
  return pattern.test(messages.join(" "));
}

/**
 * The `inv_move_guard` trigger is E6's enforcement (posted movements cannot
 * be deleted; posted rows are immutable), but no committed test attempted
 * the forbidden write — the guard was enforced yet unexercised. This pins
 * its exact contract end to end: delete-posted raises, posted→posted update
 * raises, and the teardown path the fixtures rely on (posted→pending, then
 * delete) stays allowed.
 */

test("posted inventory movements cannot be deleted or rewritten", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await receiveInventory(org.orgId, null, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "10",
      unitCost: "2.00",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    const movement = await db.execute<{ id: string }>(sql`
      select id from inventory_movements
       where org_id = ${org.orgId} and item_id = ${org.items.fifo} and status = 'posted'
       order by created_at desc limit 1`);
    const movementId = movement.rows[0]!.id;

    await assert.rejects(
      db.execute(sql`delete from inventory_movements where id = ${movementId} and org_id = ${org.orgId}`),
      (error: unknown) => errorChainMatches(error, /posted and cannot be deleted/),
      "deleting a posted movement must raise",
    );
    await assert.rejects(
      db.execute(sql`update inventory_movements set quantity = '99' where id = ${movementId} and org_id = ${org.orgId}`),
      (error: unknown) => errorChainMatches(error, /posted and immutable/),
      "rewriting a posted movement must raise",
    );

    // The allowed lifecycle the fixture teardown relies on keeps working:
    // posted demotes to pending (the guard only forbids delete-posted and
    // posted-to-posted rewrites). Layer rows still reference the movement,
    // so deletion itself stays a teardown-ordered operation.
    await db.execute(sql`
      update inventory_movements set status = 'pending' where id = ${movementId} and org_id = ${org.orgId}`);
    const demoted = await db.execute<{ status: string }>(sql`
      select status from inventory_movements where id = ${movementId} and org_id = ${org.orgId}`);
    assert.equal(demoted.rows[0]!.status, "pending", "posted must demote to pending");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("inventory quantities wider than numeric(19,4) fail closed before any write", { skip: !DB }, async () => {
  // Every movement quantity funnels through one persistor into numeric(19,4)
  // columns: a pasted 20-digit figure normalized fine and died only at the
  // insert with a storage error. Fail closed with a named error instead —
  // one guard covering receipts, issues, transfers, builds, and landed costs.
  const org = await createScratchOrg();
  const input = {
    itemId: org.items.fifo,
    stockLocationId: org.stockLocationId,
    subsidiaryId: org.subsidiaryId,
    offsetAccountId: org.accounts.clearing,
    date: org.date,
  } as const;
  try {
    await assert.rejects(
      receiveInventory(org.orgId, null, { ...input, quantity: "99999999999999999999", unitCost: "2.00" }),
      (error: unknown) =>
        error instanceof InventoryError && /out of range/.test(error.message),
      "an oversized receipt quantity should fail closed with a named error",
    );
    const rows = await db.execute<{ movements: number; lines: number }>(sql`
      select (select count(*)::int from inventory_movements where org_id = ${org.orgId}) as movements,
             (select count(*)::int from journal_lines where org_id = ${org.orgId}) as lines`);
    assert.deepEqual(rows.rows[0], { movements: 0, lines: 0 });
    // The column maximum itself still receives (unit cost 1 keeps the extended
    // journal math exactly at the maximum too).
    await receiveInventory(org.orgId, null, { ...input, quantity: "999999999999999.9999", unitCost: "1.00" });
    const saved = await db.execute<{ quantity: string }>(sql`
      select quantity::text as quantity from inventory_movements where org_id = ${org.orgId}`);
    assert.equal(saved.rows[0]!.quantity, "999999999999999.9999");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
