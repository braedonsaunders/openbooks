import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { payrollSetupState } from "./readiness.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// setup.schedule used to read pay_schedules org-wide, so a caller restricted
// to subsidiary A saw ok:true off a schedule living under B — a calendar the
// caller can never run payroll on. Schedules are subsidiary-scoped, so the
// check carries the same scope predicate as the population, slots and rates
// on this surface: only an active schedule in the caller's scope counts.

function scheduleCheck(
  state: Awaited<ReturnType<typeof payrollSetupState>>,
): { ok: boolean } {
  const found = state.checks.filter((check) => check.code === "setup.schedule");
  assert.equal(found.length, 1);
  return found[0]!;
}

test("an A-scoped caller with the only schedule under B gets setup.schedule not ok", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  try {
    const childB = randomUUID();
    await db.execute(sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country)
      values(${childB},${org.orgId},${org.subsidiaryId},'Division B','CAD','CA')`);
    await db.execute(sql`
      insert into pay_schedules
        (id, org_id, subsidiary_id, name, frequency, periods_per_year, anchor_period_end,
         pay_date_offset_days, is_active, created_by, updated_by)
      values (${randomUUID()}, ${org.orgId}, ${childB}, 'Division B weekly', 'weekly', 52,
              '2026-07-31', 0, true, ${actorId}, ${actorId})`);

    // Restricted to A (the root entity): B's schedule is unusable.
    assert.equal(scheduleCheck(await payrollSetupState(org.orgId, new Set([org.subsidiaryId]))).ok, false);
    // The same caller scoped to both entities, and the unrestricted caller,
    // still see the schedule.
    assert.equal(
      scheduleCheck(await payrollSetupState(org.orgId, new Set([org.subsidiaryId, childB]))).ok, true,
    );
    assert.equal(scheduleCheck(await payrollSetupState(org.orgId)).ok, true);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
