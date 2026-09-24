import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { listLeaveFilingEmploymentOptions } from "./leave-read.ts";

/**
 * C-68 regression (integration partition): the leave filing picker must
 * apply the actor's legal-entity scope in SQL, not in JS after the page
 * LIMIT. Twenty-five alphabetically earlier out-of-scope employments must
 * not displace the fileable in-scope one into an empty page.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedEmployment(
  orgId: string,
  subsidiaryId: string,
  displayName: string,
): Promise<string> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${displayName}, true, '{}'::jsonb)
  `);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${partyId}, ${subsidiaryId}, 1)
  `);
  return employmentId;
}

type Harness = { org: ScratchOrg; subB: string; managerAId: string; inScopeEmploymentId: string };

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  const subB = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Second Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`);
  // Twenty-five out-of-scope employments sorting before the in-scope one.
  for (let i = 0; i < 25; i++) {
    await seedEmployment(org.orgId, subB, `Aardvark ${String(i).padStart(2, "0")}`);
  }
  const inScopeEmploymentId = await seedEmployment(org.orgId, org.subsidiaryId, "Zed Zebulon");
  const managerAId = await createScratchUser(org.orgId, "Mara Manager", "leave_manager_a");
  await db.execute(sql`
    update app_roles
       set permissions = '["hrm.leave.manage"]'::jsonb,
           subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
     where org_id = ${org.orgId} and key = 'leave_manager_a'`);
  return { org, subB, managerAId, inScopeEmploymentId };
}

test("out-of-scope rows cannot displace the fileable in-scope picker option", { skip: !DB }, async () => {
  if (!DB) return;
  const h = await setupHarness();
  try {
    const options = await listLeaveFilingEmploymentOptions({ orgId: h.org.orgId, actorId: h.managerAId });
    const ids = options.map((o) => o.employmentId);
    assert.ok(ids.includes(h.inScopeEmploymentId), "the in-scope employment must survive the page");
    for (const option of options) {
      assert.match(option.label, /Zed Zebulon/, "no out-of-scope row may leak into the page");
    }
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
});
