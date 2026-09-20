import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { refreshCloseRun, startCloseRun } from "./close.ts";
import { buildRecognitionSchedule, runRevenueRecognition } from "../revenue/recognition.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

/**
 * Close readiness must not stay green while deferred revenue sits
 * unrecognized. Every other computed posting step has its check —
 * depreciation-unposted for fixed assets, fx-unrevalued for currency — but
 * an engine-built recognition schedule with due, unposted lines produced no
 * exception at all, so a run could score 100 and proceed to approval with
 * revenue missing from the period.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedUnrecognized(orgId: string, bookId: string, periodId: string, actorId: string, customerId: string): Promise<void> {
  const ruleId = randomUUID(), contractId = randomUUID(), oblId = randomUUID();
  const accounts = (await db.execute<{ deferred: string; recognized: string }>(sql`
    select (select id from accounts where org_id = ${orgId} and number = '2200') as deferred,
           (select id from accounts where org_id = ${orgId} and number = '4010') as recognized`)).rows[0]!;
  await db.execute(sql`insert into recognition_rules
    (id,org_id,code,name,method,is_forecast,recognition_periods,start_date_source,end_date_source,period_offset,start_offset_days,initial_amount_percent,deferred_account_id,recognized_account_id,is_active)
    values (${ruleId},${orgId},'W6R','W6 revenue rule','straight_line_even',false,1,'contract','contract',0,0,'0',${accounts.deferred},${accounts.recognized},true)`);
  await db.execute(sql`insert into revenue_contracts
    (id,org_id,customer_id,contract_number,status,starts_on,ends_on,currency,total_transaction_price,created_by,updated_by)
    values (${contractId},${orgId},${customerId},'W6R-C','active','2026-07-01','2026-07-31','CAD','1200.0000',${actorId},${actorId})`);
  await db.execute(sql`insert into performance_obligations
    (id,org_id,contract_id,description,recognition_rule_id,booked_amount,allocated_price,recognition_starts_on,recognition_ends_on,status,created_by,updated_by)
    values (${oblId},${orgId},${contractId},'W6 revenue obl',${ruleId},'1200.0000','1200.0000','2026-07-01','2026-07-31','open',${actorId},${actorId})`);
  const built = await buildRecognitionSchedule(oblId, orgId, actorId, bookId);
  assert.equal(built.lineCount, 1, "fixture must build one due July line");
}

async function openCounts(orgId: string, runId: string): Promise<Record<string, number>> {
  await refreshCloseRun(orgId, runId);
  const rows = (await db.execute<{ code: string; n: number }>(sql`
    select code,(details->>'count')::int as n from close_exceptions
     where org_id=${orgId} and run_id=${runId} and status='open'`)).rows;
  return Object.fromEntries(rows.map((r) => [r.code, r.n]));
}

test("unrecognized deferred revenue blocks readiness until it posts", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await seedUnrecognized(org.orgId, org.bookId, org.periodId, actorId, org.customerId);
    const runId = await startCloseRun({ orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, actorId });
    assert.equal(
      (await openCounts(org.orgId, runId))["recognition-unposted"], 1,
      "one due unposted recognition line must raise recognition-unposted",
    );
    const run = await runRevenueRecognition(org.orgId, "2026-07-31", actorId);
    assert.equal(run.posted, 1, "the July line must post through the recognition runner");
    assert.ok(
      !("recognition-unposted" in (await openCounts(org.orgId, runId))),
      "posting the line must resolve the exception",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
