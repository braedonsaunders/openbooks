import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { neg } from "../money/money.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";
import { getOnHand } from "./position.ts";
import { receiveInventory } from "./movements.ts";
import {
  postLandedCostVoucher,
  reverseLandedCostVoucher,
} from "./landed-cost.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * A posted landed-cost voucher reverses through appended contra evidence:
 * the voucher, its allocations, and its journal stay readable while negative
 * allocations and a mirrored journal unwind both the subledger and the GL,
 * with the reversal linked in the audit log under the acting user.
 */
test("landed-cost reversal keeps the original evidence and appends an exact contra", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    await receiveInventory(org.orgId, actor, {
      itemId: org.items.fifo,
      stockLocationId: org.stockLocationId,
      quantity: "10",
      unitCost: "10",
      subsidiaryId: org.subsidiaryId,
      offsetAccountId: org.accounts.clearing,
      date: org.date,
    });
    const voucher = await postLandedCostVoucher(org.orgId, actor, {
      amount: "20",
      basis: "value",
      freightAccountId: org.accounts.freight,
      subsidiaryId: org.subsidiaryId,
      voucherDate: org.date,
      memo: "Freight to unwind",
      targets: [{ itemId: org.items.fifo, stockLocationId: org.stockLocationId }],
    });
    assert.equal((await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).value, "120.0000");

    const sourceLines = (await db.execute<{ account_id: string; amount: string; line_number: number }>(sql`
      select account_id, amount::text, line_number from journal_lines
       where org_id = ${org.orgId} and entry_id = ${voucher.entryId}
       order by line_number`)).rows;
    const sourceAllocations = (await db.execute<{ id: string; amount: string }>(sql`
      select id, amount::text from landed_cost_allocations
       where org_id = ${org.orgId} and voucher_id = ${voucher.id}
         and reverses_allocation_id is null
       order by id`)).rows;
    assert.ok(sourceAllocations.length > 0);

    const reversal = await reverseLandedCostVoucher(org.orgId, actor, {
      voucherId: voucher.id,
      reversalDate: org.date,
      reason: "Freight was billed to the wrong receipt entirely",
    });
    assert.equal(reversal.alreadyReversed, false);
    assert.equal(reversal.reversedAllocations, sourceAllocations.length);

    // The original allocation and journal rows are untouched.
    assert.deepEqual(
      ((await db.execute<{ id: string; amount: string }>(sql`
        select id, amount::text from landed_cost_allocations
         where org_id = ${org.orgId} and voucher_id = ${voucher.id}
           and reverses_allocation_id is null
         order by id`))).rows,
      sourceAllocations,
    );
    assert.deepEqual(
      ((await db.execute<{ account_id: string; amount: string; line_number: number }>(sql`
        select account_id, amount::text, line_number from journal_lines
         where org_id = ${org.orgId} and entry_id = ${voucher.entryId}
         order by line_number`))).rows,
      sourceLines,
    );

    // Each original allocation carries exactly one negative contra linked to it.
    const contra = (await db.execute<{ amount: string; reverses_allocation_id: string }>(sql`
      select amount::text, reverses_allocation_id from landed_cost_allocations
       where org_id = ${org.orgId} and voucher_id = ${voucher.id}
         and reverses_allocation_id is not null
       order by reverses_allocation_id`)).rows;
    assert.equal(contra.length, sourceAllocations.length);
    for (let i = 0; i < sourceAllocations.length; i++) {
      assert.equal(contra[i]!.reverses_allocation_id, sourceAllocations[i]!.id);
      assert.equal(contra[i]!.amount, neg(sourceAllocations[i]!.amount));
    }

    // The contra journal mirrors the source line for line.
    const contraLines = (await db.execute<{ account_id: string; amount: string; line_number: number }>(sql`
      select account_id, amount::text, line_number from journal_lines
       where org_id = ${org.orgId} and entry_id = ${reversal.entryId}
       order by line_number`)).rows;
    assert.equal(contraLines.length, sourceLines.length);
    for (let i = 0; i < sourceLines.length; i++) {
      assert.equal(contraLines[i]!.account_id, sourceLines[i]!.account_id);
      assert.equal(contraLines[i]!.line_number, sourceLines[i]!.line_number);
      assert.equal(contraLines[i]!.amount, neg(sourceLines[i]!.amount));
    }

    // The voucher links its reversal and the audit log names actor + reason.
    const head = ((await db.execute<{ status: string; reversal_journal_entry_id: string }>(sql`
      select status, reversal_journal_entry_id from landed_cost_vouchers
       where org_id = ${org.orgId} and id = ${voucher.id}`))).rows[0]!;
    assert.equal(head.status, "void");
    assert.equal(head.reversal_journal_entry_id, reversal.entryId);
    const audit = (await db.execute<{ actor_id: string; changes: { reason: string } }>(sql`
      select actor_id, changes from audit_log
       where org_id = ${org.orgId} and table_name = 'landed_cost_vouchers'
         and row_id = ${voucher.id} and action = 'void'`)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.actor_id, actor);
    assert.equal(audit[0]!.changes.reason, "Freight was billed to the wrong receipt entirely");

    // Layers and GL both return to the pre-voucher carrying value.
    assert.equal((await getOnHand(org.orgId, org.items.fifo, org.stockLocationId)).value, "100.0000");

    // Repeating the reversal replays the stored result without new evidence.
    const journalCount = async () =>
      ((await db.execute<{ count: number }>(sql`select count(*)::int as count from journal_entries where org_id = ${org.orgId}`))).rows[0]!.count;
    const before = await journalCount();
    const retry = await reverseLandedCostVoucher(org.orgId, actor, {
      voucherId: voucher.id,
      reversalDate: org.date,
      reason: "Freight was billed to the wrong receipt entirely",
    });
    assert.deepEqual(retry, { ...reversal, alreadyReversed: true });
    assert.equal(await journalCount(), before);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
