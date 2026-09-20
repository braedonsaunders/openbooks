import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { BUILTIN_PROJECT_TYPES } from "@openbooks/schema";
import { resolveProjectFinancials } from "./financials.ts";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const costPlusProfile = BUILTIN_PROJECT_TYPES.find((t) => t.key === "cost_plus")!
  .financialProfile;

/**
 * A cost-plus profile whose project carries no job markup must price billable
 * value at cost plus the profile's default markup — the same fallback the WIP
 * prebill pricer (`priceWipSource` → 200 at 15% = 230) and the WIP analytics
 * rollup already apply. The Financials P&L must agree with both.
 */
test("cost-plus billable value falls back to the profile default markup", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const projectId = randomUUID();
    const employeeId = randomUUID();
    await db.execute(sql`
      insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-CP', 'Cost-plus markup job',
              ${org.customerId}, 'active', true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'employee', 'Cost-plus worker', ${org.subsidiaryId}, true, '{}'::jsonb)`);
    // 4h × 50 cost = 200 of time cost; the project carries no markupPercent.
    await db.execute(sql`
      insert into time_entries (id, org_id, employee_party_id, worked_on, hours, project_id, status,
                                costing_basis, is_billable, billing_status, cost_rate, custom, created_by, updated_by)
      values (${randomUUID()}, ${org.orgId}, ${employeeId}, ${org.date}, '4.0000', ${projectId}, 'approved',
              'actual', true, 'unbilled', '50.0000', '{}'::jsonb, ${actor}, ${actor})`);

    const report = await resolveProjectFinancials(org.orgId, projectId, costPlusProfile);
    assert.equal(report.measures.billable_time_value, "230.0000");
    assert.equal(report.measures.billable_value, "230.0000");
    assert.equal(report.measures.unbilled_billable, "230.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
