import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
const { sql } = await import("drizzle-orm");
const { db, withOrgTransaction } = await import("./db.ts");
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } =
  await import("./test-fixtures.ts");
const { buildRecognitionSchedule, runRevenueRecognition } =
  await import("./revenue-recognition.ts");
test(
  "recognition isolates a failed journal inside an ambient transaction and continues valid lines",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const constraint =
      "audit_recognition_failure_" + randomUUID().replaceAll("-", "");
    try {
      const contract = randomUUID(),
        obligation = randomUUID();
      await db.execute(
        sql`insert into revenue_contracts(id,org_id,customer_id,contract_number,status,starts_on,currency,total_transaction_price,created_by,updated_by) values(${contract},${org.orgId},${org.customerId},'REV-SNAPSHOT','active',${org.date},'CAD',2400,${actor},${actor})`,
      );
      await db.execute(
        sql`insert into performance_obligations(id,org_id,contract_id,description,recognition_rule_id,booked_amount,allocated_price,recognition_starts_on,status,created_by,updated_by) values(${obligation},${org.orgId},${contract},'A failing obligation',${org.recognitionRuleId},1200,1200,${org.date},'open',${actor},${actor})`,
      );
      await db.execute(
        sql`update recognition_rules set recognition_periods=1 where org_id=${org.orgId} and id=${org.recognitionRuleId}`,
      );
      await buildRecognitionSchedule(obligation, org.orgId, actor);
      await db.execute(
        sql`update performance_obligations set recognized_account_id=${org.accounts.revenue} where org_id=${org.orgId} and id=${obligation}`,
      );
      const valid = randomUUID();
      await db.execute(
        sql`insert into performance_obligations(id,org_id,contract_id,description,recognition_rule_id,booked_amount,allocated_price,recognition_starts_on,status,created_by,updated_by) values(${valid},${org.orgId},${contract},'B valid obligation',${org.recognitionRuleId},1200,1200,${org.date},'open',${actor},${actor})`,
      );
      await buildRecognitionSchedule(valid, org.orgId, actor);
      await db.execute(
        sql.raw(
          `alter table journal_lines add constraint ${constraint} check (org_id <> '${org.orgId}'::uuid or account_id <> '${org.accounts.revenue}'::uuid) not valid`,
        ),
      );
      await withOrgTransaction(org.orgId, async () => {
        await db.execute(
          sql`update parties set display_name='Surviving recognition caller' where org_id=${org.orgId} and id=${org.customerId}`,
        );
        const result = await runRevenueRecognition(
          org.orgId,
          "2026-07-31",
          actor,
        );
        assert.equal(result.posted, 1);
        assert.equal(result.totalAmount, "1200.0000");
        assert.equal(result.problems.length, 1);
        await db.execute(sql`select 1 as usable`);
      });
      const caller = (
        await db.execute<{ name: string }>(
          sql`select display_name as name from parties where org_id=${org.orgId} and id=${org.customerId}`,
        )
      ).rows[0];
      assert.equal(caller?.name, "Surviving recognition caller");
      const entries = (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from journal_entries where org_id=${org.orgId} and origin='revenue_recognition'`,
        )
      ).rows[0]!.n;
      assert.equal(
        entries,
        1,
        "only the successful posting remains; the failed draft is removed",
      );
      const failed = (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from journal_entries where org_id=${org.orgId} and origin='revenue_recognition' and status='draft'`,
        )
      ).rows[0]!.n;
      assert.equal(failed, 0);
      const lines = (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from journal_lines jl join journal_entries j on j.org_id=jl.org_id and j.id=jl.entry_id where j.org_id=${org.orgId} and j.origin='revenue_recognition'`,
        )
      ).rows[0]!.n;
      assert.equal(
        lines,
        2,
        "the deferred leg written before the injected failure is also rolled back",
      );
    } finally {
      await db.execute(
        sql.raw(
          `alter table journal_lines drop constraint if exists ${constraint}`,
        ),
      );
      await dropScratchOrgReporting(org.orgId);
    }
  },
);

test(
  "nested explicit savepoints preserve caller writes and independently roll back caught application errors",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const { withTransactionSavepoint } = await import("./db.ts");
    const org = await createScratchOrg();
    const before = randomUUID(),
      outer = randomUUID(),
      inner = randomUUID(),
      after = randomUUID();
    try {
      const insert = (id: string) =>
        db.execute(
          sql`insert into parties(id,org_id,kind,display_name) values(${id},${org.orgId},'person','Savepoint probe')`,
        );
      await withOrgTransaction(org.orgId, async () => {
        await insert(before);
        await assert.rejects(
          withTransactionSavepoint(db, async () => {
            await insert(outer);
            await assert.rejects(
              withTransactionSavepoint(db, async () => {
                await insert(inner);
                throw new Error("inner application failure");
              }),
              /inner application failure/,
            );
            assert.equal(
              (
                await db.execute<{ n: number }>(
                  sql`select count(*)::int as n from parties where org_id=${org.orgId} and id=${outer}`,
                )
              ).rows[0]!.n,
              1,
            );
            throw new Error("outer application failure");
          }),
          /outer application failure/,
        );
        await insert(after);
      });
      const retained = (
        await db.execute<{ id: string }>(
          sql`select id from parties where org_id=${org.orgId} and id in (${before},${outer},${inner},${after})`,
        )
      ).rows
        .map((row) => row.id)
        .sort();
      assert.deepEqual(retained, [before, after].sort());
    } finally {
      await dropScratchOrgReporting(org.orgId);
    }
  },
);
