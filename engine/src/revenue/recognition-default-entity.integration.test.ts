import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { runRevenueRecognition } from "./recognition.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * B-INV-06 residual (revenue): an obligation with no subsidiary anywhere in
 * its attribution chain (contract, document line, document, project) posts
 * under the hierarchy root — the shared unscoped-posting default — never
 * the oldest-created subsidiary.
 */
test("unattributed revenue posts under the root when an older sibling exists", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const elderId = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
      values(${elderId},${org.orgId},${org.subsidiaryId},'Elder child','CAD','CA')`);
    await db.execute(sql`update subsidiaries set created_at='2020-01-01T00:00:00Z' where org_id=${org.orgId} and id=${elderId}`);
    const oldest = (await db.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id=${org.orgId} order by created_at,id limit 1`)).rows[0]!.id;
    assert.equal(oldest, elderId, "fixture must make a non-root entity the oldest");

    const ruleId = randomUUID(), contractId = randomUUID(), oblId = randomUUID();
    const accounts = (await db.execute<{ deferred: string; recognized: string }>(sql`
      select (select id from accounts where org_id = ${org.orgId} and number = '2200') as deferred,
             (select id from accounts where org_id = ${org.orgId} and number = '4010') as recognized`)).rows[0]!;
    await db.execute(sql`insert into recognition_rules
      (id,org_id,code,name,method,is_forecast,recognition_periods,start_date_source,end_date_source,period_offset,start_offset_days,initial_amount_percent,deferred_account_id,recognized_account_id,is_active)
      values (${ruleId},${org.orgId},'W6R','W6 revenue rule','straight_line_even',false,1,'contract','contract',0,0,'0',${accounts.deferred},${accounts.recognized},true)`);
    await db.execute(sql`insert into revenue_contracts
      (id,org_id,customer_id,contract_number,status,starts_on,ends_on,currency,total_transaction_price,created_by,updated_by)
      values (${contractId},${org.orgId},${org.customerId},'W6R-C','active','2026-07-01','2026-07-31','CAD','1200.0000',${actorId},${actorId})`);
    await db.execute(sql`insert into performance_obligations
      (id,org_id,contract_id,description,recognition_rule_id,booked_amount,allocated_price,recognition_starts_on,recognition_ends_on,status,created_by,updated_by)
      values (${oblId},${org.orgId},${contractId},'W6 revenue obl',${ruleId},'1200.0000','1200.0000','2026-07-01','2026-07-31','open',${actorId},${actorId})`);
    const { buildRecognitionSchedule } = await import("./recognition.ts");
    const built = await buildRecognitionSchedule(oblId, org.orgId, actorId, org.bookId);
    assert.equal(built.lineCount, 1, "fixture must build one due July line");

    const run = await runRevenueRecognition(org.orgId, "2026-07-31", actorId);
    assert.equal(run.posted, 1, "the July line must post through the recognition runner");
    const entries = (await db.execute<{ subsidiary_id: string }>(sql`
      select distinct subsidiary_id::text as subsidiary_id from journal_entries where org_id=${org.orgId}`));
    assert.ok(entries.rows.length > 0, "the run must post at least one journal");
    for (const entry of entries.rows) {
      assert.equal(entry.subsidiary_id, org.subsidiaryId, "unattributed revenue books to the root, not the oldest entity");
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
