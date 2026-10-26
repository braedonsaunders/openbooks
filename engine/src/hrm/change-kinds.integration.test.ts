import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { EMPLOYMENT_CHANGE_KINDS } from "./change-requests.ts";

/**
 * Durable guard for the employment_changes kind vocabulary. Every kind the
 * engine writes (derived from the typed union at the canonical writer, not
 * a hand-maintained list) must pass the CHECK: a migration redefining the
 * vocabulary without one of these fails here instead of inside a live
 * approval or direct application.
 */
test("every engine-written change kind passes the employment_changes CHECK", async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Kind Guard", "kind_guard");
    const subsidiary = (
      await db.execute<{ id: string }>(
        sql`
      select id from subsidiaries where org_id = ${org.orgId} order by id limit 1
    `,
        "objects",
      )
    )[0]!.id;
    const party = (
      await db.execute<{ id: string }>(
        sql`
      insert into parties (org_id, kind, display_name)
      values (${org.orgId}, 'employee', 'Kind Guard')
      returning id
    `,
        "objects",
      )
    )[0]!.id;
    const employment = (
      await db.execute<{ id: string }>(
        sql`
      insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
      values (${org.orgId}, ${party}, ${subsidiary})
      returning id
    `,
        "objects",
      )
    )[0]!.id;
    let revision = 1;
    for (const kind of EMPLOYMENT_CHANGE_KINDS) {
      const inserted = await db.execute<{ id: string }>(
        sql`
        insert into employment_changes
          (org_id, employment_id, revision, change_kind, prior_snapshot,
           reason, recorded_source, recorded_by, closed_versions)
        values (${org.orgId}, ${employment}, ${revision}, ${kind}, '{}'::jsonb,
                'kind vocabulary guard', 'user', ${userId}, '[]'::jsonb)
        returning id
      `,
        "objects",
      );
      assert.equal(inserted.length, 1, `kind ${kind} must pass the employment_changes CHECK`);
      revision += 1;
    }
    assert.equal(revision - 1, EMPLOYMENT_CHANGE_KINDS.length, "one row per engine-written kind");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
