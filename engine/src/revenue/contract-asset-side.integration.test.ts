import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../testing/fixtures.ts";
import { buildRecognitionSchedule, runRevenueRecognition } from "./recognition.ts";
import { contractPosition } from "./contract-scope.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// Contract-asset side: services performed (recognized) before any billing
// posts leave recognized in excess of billings — an unbilled receivable the
// contract reports per contract as side "asset". Billings only ever grow
// through posted invoices, so the asset appears exactly when recognition
// runs ahead of the echo invoice.

test("a contract recognized ahead of billing reports a contract asset", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    const calendar = (
      await db.execute<{ id: string }>(sql`
        select fiscal_calendar_id as id from accounting_periods
         where org_id = ${org.orgId} and id = ${org.periodId}`)
    ).rows[0]!.id;
    for (const [month, last] of [["07", "31"], ["08", "31"], ["09", "30"]] as const) {
      await db.execute(sql`
        insert into accounting_periods
          (id, org_id, fiscal_calendar_id, fiscal_year, period_number, name,
           starts_on, ends_on, is_adjustment, custom)
        values (${randomUUID()}, ${org.orgId}, ${calendar}, 2026, ${Number(month)},
                ${`2026-${month}`}, ${`2026-${month}-01`}, ${`2026-${month}-${last}`},
                false, '{}'::jsonb)
        on conflict do nothing`);
    }
    // A signed quarterly service agreement with no billing yet: the
    // obligation exists, the invoice does not.
    const contractId = randomUUID();
    const obligationId = randomUUID();
    await db.execute(sql`
      insert into revenue_contracts
        (id, org_id, subsidiary_id, customer_id, contract_number, status,
         starts_on, ends_on, currency, total_transaction_price, created_by, updated_by)
      values (${contractId}, ${org.orgId}, ${org.subsidiaryId}, ${org.customerId},
              'ASSET-001', 'active', '2026-07-01', '2026-09-30', 'CAD', 3000,
              ${actors.adminId}, ${actors.adminId})`);
    await db.execute(sql`
      insert into performance_obligations
        (id, org_id, contract_id, description, recognition_rule_id,
         allocated_price, standalone_selling_price,
         recognition_starts_on, recognition_ends_on,
         deferred_account_id, recognized_account_id, status, created_by, updated_by)
      values (${obligationId}, ${org.orgId}, ${contractId}, 'Quarterly service',
              ${org.recognitionRuleId}, 3000, 3000, '2026-07-01', '2026-09-30',
              ${org.accounts.deferred}, ${org.accounts.recognized}, 'open',
              ${actors.adminId}, ${actors.adminId})`);
    await buildRecognitionSchedule(obligationId, org.orgId, actors.adminId, org.bookId);

    const run = await runRevenueRecognition(org.orgId, "2026-07-31", actors.adminId, obligationId);
    assert.equal(run.posted, 1);
    assert.deepEqual(run.problems, []);

    const position = await contractPosition(db, org.orgId, contractId);
    assert.equal(position.billed, "0.0000");
    assert.equal(position.recognized, "1000.0000");
    assert.equal(position.net, "-1000.0000");
    assert.equal(position.side, "asset");

    // The asset is earned revenue awaiting its invoice: the primary book
    // holds one posted recognition journal for July's slice.
    const journals = (
      await db.execute<{ entries: number }>(sql`
        select count(distinct l.journal_entry_id)::int as entries
          from recognition_schedule_lines l
          join recognition_schedules s on s.id = l.schedule_id and s.org_id = l.org_id
         where s.org_id = ${org.orgId} and s.obligation_id = ${obligationId}
           and l.journal_entry_id is not null and l.reversal_journal_entry_id is null`)
    ).rows[0];
    assert.equal(journals?.entries, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
