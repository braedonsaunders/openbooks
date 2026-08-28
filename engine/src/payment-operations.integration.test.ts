import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "./db.ts";
import { recordPaymentSettlement } from "./payment-operations.ts";
import { PaymentError } from "./payments.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "./test-fixtures.ts";

const paymentOperationsSource = readFileSync(new URL("./payment-operations.ts", import.meta.url), "utf8");
const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test("returned instructions are guarded before settlement writes", () => {
  const guard = paymentOperationsSource.match(
    /if \(\["returned", "reversed"\]\.includes\(instruction\.status\) && opts\.status === "settled"\) \{[\s\S]*?\n    \}/,
  );
  assert.ok(guard, "a returned instruction must reject a later settled outcome");
  const guardOffset = paymentOperationsSource.indexOf(guard[0]);
  const upsertOffset = paymentOperationsSource.indexOf("insert into payment_settlements");
  assert.ok(guardOffset >= 0 && guardOffset < upsertOffset, "the terminal guard must run before the settlement upsert");
});

test(
  "a returned payment instruction cannot be relabelled settled while a sent instruction still can",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Settlement operator", "admin"),
      );
      const runId = randomUUID();
      const returnedInstructionId = randomUUID();
      const reversedInstructionId = randomUUID();
      const sentInstructionId = randomUUID();
      await withOrgContext(org.orgId, async () => {
        await db.execute(sql`
          insert into payment_runs
            (id, org_id, run_number, bank_account_id, subsidiary_id, method,
             direction, purpose, currency, status, payment_count, total_amount,
             created_by, updated_by)
          values (${runId}, ${org.orgId}, ${`RETURN-GUARD-${runId}`},
                  ${org.accounts.bank}, ${org.subsidiaryId}, 'wire', 'outbound',
                  'vendor_payments', 'CAD', 'returned', 3, '75', ${actorId}, ${actorId})
        `);
        await db.execute(sql`
          insert into payment_instructions
            (id, org_id, payment_run_id, payee_party_id, amount, currency, status,
             created_by, updated_by)
          values
            (${returnedInstructionId}, ${org.orgId}, ${runId}, ${org.vendorId},
             '25', 'CAD', 'returned', ${actorId}, ${actorId}),
            (${reversedInstructionId}, ${org.orgId}, ${runId}, ${org.vendorId},
             '25', 'CAD', 'reversed', ${actorId}, ${actorId}),
            (${sentInstructionId}, ${org.orgId}, ${runId}, ${org.vendorId},
             '25', 'CAD', 'sent', ${actorId}, ${actorId})
        `);
      });

      await assert.rejects(
        withOrgContext(org.orgId, () =>
          recordPaymentSettlement({
            instructionId: returnedInstructionId,
            orgId: org.orgId,
            userId: actorId,
            status: "settled",
            effectiveOn: org.date,
            bankReference: "late-settlement",
          }),
        ),
        (error: unknown) =>
          error instanceof PaymentError
          && error.message === "a returned or reversed payment instruction cannot be settled",
      );

      await assert.rejects(
        withOrgContext(org.orgId, () =>
          recordPaymentSettlement({
            instructionId: reversedInstructionId,
            orgId: org.orgId,
            userId: actorId,
            status: "settled",
            effectiveOn: org.date,
            bankReference: "late-settlement-after-reversal",
          }),
        ),
        (error: unknown) =>
          error instanceof PaymentError
          && error.message === "a returned or reversed payment instruction cannot be settled",
      );

      const afterRefusals = await withOrgContext(org.orgId, async () =>
        (await db.execute<{
          returned_status: string;
          reversed_status: string;
          returned_settlement_count: number;
          reversed_settlement_count: number;
          run_status: string;
        }>(sql`
          select
            (select status from payment_instructions where id = ${returnedInstructionId}) as returned_status,
            (select status from payment_instructions where id = ${reversedInstructionId}) as reversed_status,
            (select count(*)::int from payment_settlements where payment_instruction_id = ${returnedInstructionId}) as returned_settlement_count,
            (select count(*)::int from payment_settlements where payment_instruction_id = ${reversedInstructionId}) as reversed_settlement_count,
            (select status from payment_runs where id = ${runId}) as run_status
        `)).rows[0],
      );
      assert.deepEqual(afterRefusals, {
        returned_status: "returned",
        reversed_status: "reversed",
        returned_settlement_count: 0,
        reversed_settlement_count: 0,
        run_status: "returned",
      });

      await withOrgContext(org.orgId, () =>
        recordPaymentSettlement({
          instructionId: sentInstructionId,
          orgId: org.orgId,
          userId: actorId,
          status: "settled",
          effectiveOn: org.date,
          bankReference: "normal-settlement",
        }),
      );
      const afterHappyPath = await withOrgContext(org.orgId, async () =>
        (await db.execute<{
          instruction_status: string;
          settlement_status: string;
          run_status: string;
        }>(sql`
          select
            (select status from payment_instructions where id = ${sentInstructionId}) as instruction_status,
            (select status from payment_settlements where payment_instruction_id = ${sentInstructionId}) as settlement_status,
            (select status from payment_runs where id = ${runId}) as run_status
        `)).rows[0],
      );
      assert.deepEqual(afterHappyPath, {
        instruction_status: "settled",
        settlement_status: "settled",
        run_status: "returned",
      });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
