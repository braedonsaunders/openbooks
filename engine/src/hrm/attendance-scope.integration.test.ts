import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { employmentsOnLeave } from "./attendance.ts";

/**
 * C-21: the on-leave roster is scoped to the actor's allowed employers.
 * employmentsOnLeave takes the scope as a REQUIRED parameter (null =
 * unrestricted), so a subsidiary-A HR reader sees only A's on-leave
 * workers and count — never names or totals from across the org.
 * DB-owned (skips without OPENBOOKS_DB_URL, one file at a time).
 */

const DB = !!process.env.OPENBOOKS_DB_URL;
const TODAY = "2026-03-04";

async function mkEmployment(orgId: string, label: string, subsidiaryId: string): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${label}, true, '{}'::jsonb)
  `);
  return (await db.execute<{ id: string }>(sql`
    insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
    values (${orgId}, ${partyId}, ${subsidiaryId}) returning id`)).rows[0]!.id;
}

async function mkSecondSubsidiary(orgId: string, parentId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${orgId}, ${parentId}, 'Second Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

test("on-leave names and counts stay inside the actor's allowed employers", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const subB = await mkSecondSubsidiary(org.orgId, org.subsidiaryId);
    const typeId = (await db.execute<{ id: string }>(sql`
      insert into hrm_leave_types (org_id, code, name)
      values (${org.orgId}, 'VAC', 'Vacation') returning id`)).rows[0]!.id;
    const empA = await mkEmployment(org.orgId, "Worker A", org.subsidiaryId);
    const empB = await mkEmployment(org.orgId, "Worker B", subB);
    for (const employmentId of [empA, empB]) {
      await db.execute(sql`
        insert into hrm_absences (org_id, employment_id, on_date, hours, leave_type_id, source)
        values (${org.orgId}, ${employmentId}, ${TODAY}::date, 8, ${typeId}, 'recorded')`);
    }
    // Unrestricted (null scope) reads the whole org — the HR-full shape.
    const all = await employmentsOnLeave(db, org.orgId, TODAY, null);
    assert.deepEqual(
      all.map((row) => row.workerName).sort(),
      ["Worker A", "Worker B"],
    );
    // An A-scoped reader sees only A's worker and count.
    const scopedA = await employmentsOnLeave(db, org.orgId, TODAY, new Set([org.subsidiaryId]));
    assert.deepEqual(scopedA.map((row) => row.workerName), ["Worker A"]);
    const scopedB = await employmentsOnLeave(db, org.orgId, TODAY, new Set([subB]));
    assert.deepEqual(scopedB.map((row) => row.workerName), ["Worker B"]);
    // An empty scope reads empty, never all.
    assert.deepEqual(await employmentsOnLeave(db, org.orgId, TODAY, new Set()), []);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
