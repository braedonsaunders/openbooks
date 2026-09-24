import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { unsealJson } from "../platform/secrets.ts";
import {
  createPaymentBankProfile,
  ensureBuiltInPaymentFormats,
  recordPaymentSettlement,
  updatePaymentBankProfile,
} from "./operations.ts";
import { PaymentError } from "./payment-errors.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const paymentOperationsSource = readFileSync(new URL("./operations.ts", import.meta.url), "utf8");
const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test("concurrent bank-profile secret rotations preserve both fields and audit the locked state", { skip: !DB }, async () => {
  const priorDataKey = process.env.OPENBOOKS_DATA_KEY;
  process.env.OPENBOOKS_DATA_KEY = "00".repeat(32);
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Profile operator", "admin"));
    await withOrgContext(org.orgId, () => ensureBuiltInPaymentFormats(org.orgId, actorId));
    const format = (await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`
      select id from payment_formats where org_id = ${org.orgId} and code = 'WIRE'
    `))).rows[0]!;
    const profile = await withOrgContext(org.orgId, () => createPaymentBankProfile(org.orgId, actorId, {
      name: "Rotation profile",
      bankAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId,
      paymentFormatId: format.id,
      currency: "CAD",
      originatorSecrets: { initial: "present" },
    }));

    await Promise.all([
      withOrgContext(org.orgId, () => updatePaymentBankProfile(profile.id, org.orgId, actorId, {
        name: "Rotation A",
        originatorSecrets: { credentialA: "value-a" },
      })),
      withOrgContext(org.orgId, () => updatePaymentBankProfile(profile.id, org.orgId, actorId, {
        name: "Rotation B",
        originatorSecrets: { credentialB: "value-b" },
      })),
    ]);

    const stored = (await withOrgContext(org.orgId, () => db.execute<{ originator_secrets_encrypted: string | null; name: string }>(sql`
      select originator_secrets_encrypted, name from payment_bank_profiles
       where id = ${profile.id} and org_id = ${org.orgId}
    `))).rows[0]!;
    assert.deepEqual(unsealJson(stored.originator_secrets_encrypted), {
      initial: "present",
      credentialA: "value-a",
      credentialB: "value-b",
    });

    const audit = (await withOrgContext(org.orgId, () => db.execute<{ changes: { before: { name: string }; after: { name: string } } }>(sql`
      select changes from audit_log
       where org_id = ${org.orgId} and table_name = 'payment_bank_profiles'
         and row_id = ${profile.id} and action = 'update'
    `))).rows;
    assert.equal(audit.length, 2, "each rotation must have an audit record");
    assert.ok(
      audit.some(({ changes }) => changes.before.name === "Rotation A" || changes.before.name === "Rotation B"),
      "the later audit before-image must include the earlier committed profile edit",
    );
    assert.ok(stored.name === "Rotation A" || stored.name === "Rotation B");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
    if (priorDataKey === undefined) delete process.env.OPENBOOKS_DATA_KEY;
    else process.env.OPENBOOKS_DATA_KEY = priorDataKey;
  }
});

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

test(
  "settlement evidence must come from the payment run's bank account",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    const foreignOrg = await withBypass(() => createScratchOrg());
    const runId = randomUUID();
    const instructionId = randomUUID();
    const statementId = randomUUID();
    const statementLineId = randomUUID();
    try {
      const actorId = await withBypass(() =>
        createScratchUser(org.orgId, "Settlement account operator", "admin"),
      );
      const foreignActorId = await withBypass(() =>
        createScratchUser(foreignOrg.orgId, "Foreign settlement operator", "admin"),
      );
      await withOrgContext(org.orgId, async () => {
        await db.execute(sql`
          insert into payment_runs
            (id, org_id, run_number, bank_account_id, subsidiary_id, method,
             direction, purpose, currency, status, payment_count, total_amount,
             created_by, updated_by)
          values (${runId}, ${org.orgId}, ${`ACCOUNT-SCOPE-${runId}`},
                  ${org.accounts.bank}, ${org.subsidiaryId}, 'wire', 'outbound',
                  'vendor_payments', 'CAD', 'confirmed', 1, '25', ${actorId}, ${actorId})
        `);
        await db.execute(sql`
          insert into payment_instructions
            (id, org_id, payment_run_id, payee_party_id, amount, currency, status,
             created_by, updated_by)
          values (${instructionId}, ${org.orgId}, ${runId}, ${org.vendorId},
                  '25', 'CAD', 'sent', ${actorId}, ${actorId})
        `);
      });
      await withOrgContext(foreignOrg.orgId, async () => {
        await db.execute(sql`
          insert into bank_statements
            (id, org_id, account_id, source, statement_date, raw_file_ref, created_by, updated_by)
          values (${statementId}, ${foreignOrg.orgId}, ${foreignOrg.accounts.bank}, 'test', ${foreignOrg.date}, 'test-source', ${foreignActorId}, ${foreignActorId})
        `);
        await db.execute(sql`
          insert into bank_statement_lines
            (id, org_id, statement_id, line_number, posted_on, amount, currency,
             account_id, created_by, updated_by)
          values (${statementLineId}, ${foreignOrg.orgId}, ${statementId}, 1, ${foreignOrg.date},
                  '-25', 'CAD', ${foreignOrg.accounts.bank}, ${foreignActorId}, ${foreignActorId})
        `);
      });

      await assert.rejects(
        withOrgContext(org.orgId, () =>
          recordPaymentSettlement({
            instructionId,
            orgId: org.orgId,
            userId: actorId,
            status: "settled",
            effectiveOn: org.date,
            bankStatementLineId: statementLineId,
          }),
        ),
        (error: unknown) =>
          error instanceof PaymentError
          && error.message === "bank statement line does not belong to the payment run's bank account",
      );

      const state = await withOrgContext(org.orgId, async () =>
        (await db.execute<{ instruction_status: string; settlements: number }>(sql`
          select
            (select status from payment_instructions where id = ${instructionId}) as instruction_status,
            (select count(*)::int from payment_settlements where payment_instruction_id = ${instructionId}) as settlements
        `)).rows[0],
      );
      assert.deepEqual(state, { instruction_status: "sent", settlements: 0 });
    } finally {
      await withBypass(() => db.execute(sql`
        delete from payment_settlements where payment_instruction_id = ${instructionId}
      `));
      await withBypass(() => dropScratchOrg(foreignOrg.orgId));
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "re-settling an instruction updates its own tenant row and no other",
  { skip: !DB },
  async () => {
    // The settlement upsert keys on payment_instruction_id and pins the
    // tenant on the conflict write: a bare org_id there is ambiguous
    // (42702) and every re-settlement fails. Settling twice in one org
    // must update the single row through the conflict branch, while the
    // other org's settlement row keeps its own bank reference.
    const orgA = await withBypass(() => createScratchOrg());
    const orgB = await withBypass(() => createScratchOrg());
    const runA = randomUUID();
    const instructionA = randomUUID();
    const runB = randomUUID();
    const instructionB = randomUUID();
    try {
      const actorA = await withBypass(() => createScratchUser(orgA.orgId, "Settlement operator A", "admin"));
      const actorB = await withBypass(() => createScratchUser(orgB.orgId, "Settlement operator B", "admin"));
      for (const [org, actor, runId, instructionId] of [
        [orgA, actorA, runA, instructionA],
        [orgB, actorB, runB, instructionB],
      ] as const) {
        await withOrgContext(org.orgId, async () => {
          await db.execute(sql`
            insert into payment_runs
              (id, org_id, run_number, bank_account_id, subsidiary_id, method,
               direction, purpose, currency, status, payment_count, total_amount,
               created_by, updated_by)
            values (${runId}, ${org.orgId}, ${`RESETTLE-${runId}`},
                    ${org.accounts.bank}, ${org.subsidiaryId}, 'wire', 'outbound',
                    'vendor_payments', 'CAD', 'confirmed', 1, '25', ${actor}, ${actor})`);
          await db.execute(sql`
            insert into payment_instructions
              (id, org_id, payment_run_id, payee_party_id, amount, currency, status,
               created_by, updated_by)
            values (${instructionId}, ${org.orgId}, ${runId}, ${org.vendorId},
                    '25', 'CAD', 'sent', ${actor}, ${actor})`);
        });
      }

      const settle = (org: typeof orgA, actor: string, instructionId: string, ref: string) =>
        recordPaymentSettlement({
          instructionId, orgId: org.orgId, userId: actor,
          status: "settled", effectiveOn: org.date, bankReference: ref,
        });
      await settle(orgA, actorA, instructionA, "ref-A1");
      await settle(orgA, actorA, instructionA, "ref-A2");
      await settle(orgB, actorB, instructionB, "ref-B");

      const rows = await withBypass(async () =>
        (await db.execute<{ orgId: string; reference: string | null; count: number }>(sql`
          select org_id as "orgId", bank_reference as "reference", count(*)::int as "count"
            from payment_settlements
           where payment_instruction_id in (${instructionA}, ${instructionB})
           group by org_id, bank_reference`)).rows,
      );
      const sortedRows = [...rows].sort((a, b) => a.orgId.localeCompare(b.orgId));
      const expectedRows = [
        { orgId: orgA.orgId, reference: "ref-A2", count: 1 },
        { orgId: orgB.orgId, reference: "ref-B", count: 1 },
      ].sort((a, b) => a.orgId.localeCompare(b.orgId));
      assert.deepEqual(sortedRows, expectedRows);
    } finally {
      await withBypass(() => db.execute(sql`
        delete from payment_settlements where payment_instruction_id in (${instructionA}, ${instructionB})`));
      await withBypass(() => dropScratchOrg(orgB.orgId));
      await withBypass(() => dropScratchOrg(orgA.orgId));
    }
  },
);

test(
  "built-in payment formats ensure per tenant without duplicating on re-ensure",
  { skip: !DB },
  async () => {
    // The format upsert keys on (org_id, code) and pins the tenant on the
    // conflict write. Ensuring twice in one org must refresh the same rows
    // through the conflict branch, while the other org keeps its own set.
    const orgA = await withBypass(() => createScratchOrg());
    const orgB = await withBypass(() => createScratchOrg());
    try {
      await ensureBuiltInPaymentFormats(orgA.orgId, null);
      await ensureBuiltInPaymentFormats(orgB.orgId, null);
      const count = async (orgId: string) =>
        (await db.execute<{ n: number }>(sql`
          select count(*)::int as n from payment_formats where org_id = ${orgId}`)).rows[0]!.n;
      const first = await count(orgA.orgId);
      assert.ok(first > 0, "built-ins land on first ensure");
      await ensureBuiltInPaymentFormats(orgA.orgId, null);
      assert.equal(await count(orgA.orgId), first, "re-ensure refreshes instead of duplicating");
      assert.equal(await count(orgB.orgId), first, "both tenants hold the full built-in set");
    } finally {
      await withBypass(() => dropScratchOrg(orgB.orgId));
      await withBypass(() => dropScratchOrg(orgA.orgId));
    }
  },
);
