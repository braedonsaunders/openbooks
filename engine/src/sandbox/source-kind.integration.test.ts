import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { createSandbox, deleteSandbox } from "./lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("createSandbox rejects a sandbox source before creating target metadata", { skip: !DB }, async () => {
  const source = await createScratchOrg();
  const name = `Invalid source ${randomUUID()}`;
  try {
    await db.execute(sql`update orgs set env_kind = 'sandbox' where id = ${source.orgId}`);
    await assert.rejects(
      createSandbox({ productionOrgId: source.orgId, name, tier: "dev", masked: false }),
      /must be a production organization/,
    );
    const created = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from sandboxes where production_org_id = ${source.orgId}`);
    assert.equal(created.rows[0]?.count, 0);
  } finally {
    const leftoverOrgs = await db.execute<{ id: string }>(sql`
      select id from orgs where sandbox_of = ${source.orgId} and name = ${name}`);
    for (const org of leftoverOrgs.rows) {
      const sandboxes = await db.execute<{ id: string }>(sql`select id from sandboxes where org_id = ${org.id}`);
      for (const sandbox of sandboxes.rows) await deleteSandbox(sandbox.id);
      await db.execute(sql`delete from orgs where id = ${org.id}`);
    }
    await dropScratchOrg(source.orgId);
  }
});
