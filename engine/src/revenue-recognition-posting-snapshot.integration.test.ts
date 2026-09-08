import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
const { sql } = await import("drizzle-orm");
const { db, pool } = await import("./db.ts");
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } =
  await import("./test-fixtures.ts");
const { buildRecognitionSchedule, runRevenueRecognition } =
  await import("./revenue-recognition.ts");
for (const change of [
  "obligation-account",
  "rule-account",
  "amount",
  "zero-to-positive",
  "positive-to-zero",
  "forecast-rule",
  "missing-accounts",
] as const)
  test(
    `recognition reloads ${change} committed while its obligation lock was pending`,
    { skip: !process.env.OPENBOOKS_DB_URL },
    async () => {
      const org = await createScratchOrg();
      const actor = (await seedFlowActors(org.orgId)).adminId;
      const blocker = await pool.connect();
      let task:
        | Promise<
            | { value: Awaited<ReturnType<typeof runRevenueRecognition>> }
            | { error: unknown }
          >
        | undefined;
      try {
        const contract = randomUUID(),
          obligation = randomUUID();
        await db.execute(
          sql`insert into revenue_contracts(id,org_id,customer_id,contract_number,status,starts_on,currency,total_transaction_price,created_by,updated_by) values(${contract},${org.orgId},${org.customerId},'REV-SNAPSHOT','active',${org.date},'CAD',1200,${actor},${actor})`,
        );
        await db.execute(
          sql`insert into performance_obligations(id,org_id,contract_id,description,recognition_rule_id,booked_amount,allocated_price,recognition_starts_on,status,created_by,updated_by) values(${obligation},${org.orgId},${contract},'Snapshot obligation',${org.recognitionRuleId},1200,1200,${org.date},'open',${actor},${actor})`,
        );
        await db.execute(
          sql`update recognition_rules set recognition_periods=1 where org_id=${org.orgId} and id=${org.recognitionRuleId}`,
        );
        await buildRecognitionSchedule(obligation, org.orgId, actor);
        assert.notEqual(org.accounts.revenue, org.accounts.recognized);
        if (change === "zero-to-positive")
          await db.execute(
            sql`update recognition_schedule_lines set planned_amount=0 where org_id=${org.orgId}`,
          );
        await blocker.query("begin");
        const pid = Number(
          (await blocker.query("select pg_backend_pid() as pid")).rows[0].pid,
        );
        await blocker.query(
          "select id from performance_obligations where org_id=$1 and id=$2 for update",
          [org.orgId, obligation],
        );
        if (change === "obligation-account") {
          await blocker.query(
            "update performance_obligations set recognized_account_id=$1 where org_id=$2 and id=$3",
            [org.accounts.revenue, org.orgId, obligation],
          );
        } else if (change === "rule-account") {
          await blocker.query(
            "update recognition_rules set recognized_account_id=$1 where org_id=$2 and id=$3",
            [org.accounts.revenue, org.orgId, org.recognitionRuleId],
          );
        } else if (change === "missing-accounts") {
          await blocker.query(
            "update recognition_rules set deferred_account_id=null, recognized_account_id=null where org_id=$1 and id=$2",
            [org.orgId, org.recognitionRuleId],
          );
        } else if (change === "forecast-rule") {
          await blocker.query(
            "update recognition_rules set is_forecast=true where org_id=$1 and id=$2",
            [org.orgId, org.recognitionRuleId],
          );
        } else {
          await blocker.query(
            "update recognition_schedule_lines set planned_amount=$1 where org_id=$2",
            [change === "positive-to-zero" ? "0" : "650", org.orgId],
          );
        }
        task = runRevenueRecognition(
          org.orgId,
          "2026-07-31",
          actor,
          obligation,
        ).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        let parked = false;
        for (let i = 0; i < 500; i++) {
          parked =
            Number(
              (
                await pool.query(
                  "select count(*)::int as n from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))",
                  [pid],
                )
              ).rows[0].n,
            ) > 0;
          if (parked) break;
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.ok(parked, "posting is waiting after its preliminary read");
        await blocker.query("commit");
        const result = await task;
        const posted = (
          await db.execute<{ account_id: string; amount: string }>(
            sql`select jl.account_id,jl.amount from journal_lines jl join journal_entries j on j.org_id=jl.org_id and j.id=jl.entry_id where j.org_id=${org.orgId} and j.origin='revenue_recognition' and jl.amount<0`,
          )
        ).rows;
        assert.ok(
          result && typeof result === "object" && "value" in result,
          "recognition completed successfully",
        );
        const shouldPost =
          change !== "positive-to-zero" &&
          change !== "forecast-rule" &&
          change !== "missing-accounts";
        if (change === "missing-accounts") {
          assert.equal(result.value.skipped, 1);
          assert.equal(result.value.problems.length, 1);
          assert.match(result.value.problems[0]!, /account not configured/);
        } else
          assert.deepEqual(
            result.value.problems,
            [],
            "the controlled edit does not cause a posting error",
          );
        assert.equal(result.value.posted, shouldPost ? 1 : 0);
        assert.equal(posted.length, shouldPost ? 1 : 0);
        if (shouldPost) {
          assert.equal(
            posted[0]!.account_id,
            change === "obligation-account" || change === "rule-account"
              ? org.accounts.revenue
              : org.accounts.recognized,
          );
          assert.equal(
            posted[0]!.amount,
            change === "amount" || change === "zero-to-positive"
              ? "-650.0000"
              : "-1200.0000",
          );
        }
        const amounts = (
          await db.execute<{ planned: string; recognized: string | null }>(
            sql`select planned_amount as planned, recognized_amount as recognized from recognition_schedule_lines where org_id=${org.orgId}`,
          )
        ).rows;
        if (change !== "forecast-rule" && change !== "missing-accounts")
          assert.equal(
            amounts[0]!.recognized,
            amounts[0]!.planned,
            "stored recognized amount agrees with the claimed plan",
          );
      } finally {
        await blocker.query("rollback");
        blocker.release();
        if (task) await task;
        await dropScratchOrgReporting(org.orgId);
      }
    },
  );
