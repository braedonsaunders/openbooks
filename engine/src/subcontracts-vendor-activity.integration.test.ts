import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrgReporting } from "./test-fixtures.ts";
import { createSubcontract, SubcontractError } from "./subcontracts.ts";

const enabled = { skip: !process.env.OPENBOOKS_DB_URL };

test("createSubcontract refuses an inactive vendor party even when its vendor role is active", enabled, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Inactive vendor controller", "admin");
    const projectId = randomUUID();
    await db.execute(sql`
      update orgs
      set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
        || '{"projects":true,"subcontracts":true}'::jsonb)
      where id = ${org.orgId}
    `);
    await db.execute(sql`
      insert into projects(id, org_id, subsidiary_id, code, name, customer_id, status)
      values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'SVA', 'Inactive vendor project', ${org.customerId}, 'active')
    `);
    await db.execute(sql`
      insert into vendor_roles(org_id, party_id, is_active)
      values (${org.orgId}, ${org.vendorId}, true)
    `);
    await db.execute(sql`
      update parties set is_active = false where org_id = ${org.orgId} and id = ${org.vendorId}
    `);

    await assert.rejects(
      createSubcontract({
        orgId: org.orgId,
        userId: actor,
        projectId,
        vendorId: org.vendorId,
        number: "SVA-1",
        title: "Inactive vendor subcontract",
        originalCommitment: "1000",
      }),
      (error: unknown) => error instanceof SubcontractError && error.message === "Vendor is not active in this organization",
    );
    assert.equal(
      (await db.execute(sql`select count(*)::int as count from subcontracts where org_id = ${org.orgId}`)).rows[0]?.count,
      0,
      "an inactive vendor must not create a subcontract",
    );
    assert.equal(
      (await db.execute(sql`select count(*)::int as count from audit_log where org_id = ${org.orgId}`)).rows[0]?.count,
      0,
      "a rejected subcontract must not write audit evidence",
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
