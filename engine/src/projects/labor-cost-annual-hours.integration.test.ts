import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { resolveAnnualHoursMany } from "./labor-costing.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { randomUUID } from "node:crypto";

/**
 * Batch annual-hours resolution follows the resolveWage scope priority:
 * the employee row beats the org default, the org default covers employees
 * with no row of their own, and an employee with no covering row at all
 * resolves to absent (there is no divisor to use).
 */
test("annual hours resolve per employee under wage scope priority", async () => {
  const org = await createScratchOrg();
  const empA = randomUUID();
  const empB = randomUUID();
  try {
    for (const [id, name] of [[empA, "Annual A"], [empB, "Annual B"]] as const) {
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${id}, ${org.orgId}, 'employee', ${name}, ${org.subsidiaryId}, true, '{}'::jsonb)`);
    }
    await db.execute(sql`insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours, effective_from)
      values (${org.orgId}, null, 'CAD', 30, 'hour', 2000, '2026-01-01'),
             (${org.orgId}, ${empA}, 'CAD', 40, 'hour', 1800, '2026-01-01')`);
    const got = await resolveAnnualHoursMany(org.orgId, [empA, empB], "2026-07-14");
    assert.equal(got.get(empA), "1800.0000");
    assert.equal(got.get(empB), "2000.0000");
    // Without the org default, the employee with no row resolves to absent.
    await db.execute(sql`delete from labor_cost_rates where org_id = ${org.orgId} and employee_party_id is null`);
    const bare = await resolveAnnualHoursMany(org.orgId, [empA, empB], "2026-07-14");
    assert.equal(bare.get(empA), "1800.0000");
    assert.ok(!bare.has(empB), "no covering row must resolve to absent");
    assert.deepEqual(await resolveAnnualHoursMany(org.orgId, [], "2026-07-14"), new Map());
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
