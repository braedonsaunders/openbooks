import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, env, withOrg } from "../platform/db.ts";
import { loadEntities } from "./migrate.ts";
import type { MigrationSource } from "./source.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

/**
 * Live-Postgres regression: the connector project loader never backfills the
 * `custom.source = {system, externalId}` envelope on its update path, so rows
 * landed by older adapter runs (adapter-refKey identity only, e.g. the real
 * tenant's 71 `{"nsId": "…"}` projects) stay permanently outside the
 * `projects_org_source_identity` unique fence. A re-keyed adapter, a second
 * adapter, or any insert path that misses the refKey can then silently mirror
 * the same job under a second id — the fence cannot see rows that carry no
 * envelope. Re-migration must heal the envelope (absent-only: never clobber
 * another system's attribution) so grandfathered rows enter fence coverage.
 */

const DB = !!env.OPENBOOKS_DB_URL;

function source(): MigrationSource {
  return {
    name: "migration-test",
    refKey: "migrationTest",
    baseCurrency: "CAD",
    accountingPeriods: async () => [],
    entities: async () => [],
    nativeChanges: async () => {
      throw new Error("not used by this test");
    },
    trialBalance: async () => [],
    monthlyActivity: async () => [],
  };
}

async function projectCustom(orgId: string, ref: string) {
  return withOrg(orgId, () =>
    db.execute<{ custom: unknown }>(sql`
      select custom from projects where org_id = ${orgId} and custom->>'migrationTest' = ${ref}
    `),
  );
}

test(
  "project re-migration backfills a missing source envelope without duplicating",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      // A grandfathered row: adapter identity only, no source envelope, as
      // landed by older adapter runs (the real tenant carries 71 like this).
      await withOrg(org.orgId, () =>
        db.execute(sql`
          insert into projects (org_id, name, is_active, custom)
          values (${org.orgId}, 'Grandfathered project', true, '{"migrationTest": "PRJ-1"}'::jsonb)
        `),
      );
      const stats = await withOrg(org.orgId, () =>
        loadEntities(source(), org.orgId, null, undefined, undefined, [
          {
            resource: "projects",
            records: [
              { sourceRef: "PRJ-1", fields: { name: "Backfilled project" } },
            ],
          },
        ]),
      );
      assert.equal(stats.projects?.updated, 1);
      assert.equal(stats.projects?.created, 0);
      const rows = (await projectCustom(org.orgId, "PRJ-1")).rows;
      assert.equal(rows.length, 1, "re-migration updates instead of duplicating");
      assert.deepEqual((rows[0]!.custom as Record<string, unknown>).source, {
        system: "migration-test",
        externalId: "PRJ-1",
      });
      assert.equal(
        (rows[0]!.custom as Record<string, unknown>).migrationTest,
        "PRJ-1",
        "the adapter refKey identity survives the heal",
      );
      const name = await withOrg(org.orgId, () =>
        db.execute<{ name: string }>(sql`
          select name from projects where org_id = ${org.orgId} and custom->>'migrationTest' = 'PRJ-1'
        `),
      );
      assert.equal(name.rows[0]?.name, "Backfilled project");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "project re-migration never clobbers another system's source envelope",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await withOrg(org.orgId, () =>
        db.execute(sql`
          insert into projects (org_id, name, is_active, custom)
          values (${org.orgId}, 'Foreign project', true,
                  '{"migrationTest": "PRJ-2", "source": {"system": "other", "externalId": "PRJ-2"}}'::jsonb)
        `),
      );
      await withOrg(org.orgId, () =>
        loadEntities(source(), org.orgId, null, undefined, undefined, [
          {
            resource: "projects",
            records: [
              { sourceRef: "PRJ-2", fields: { name: "Foreign project renamed" } },
            ],
          },
        ]),
      );
      const rows = (await projectCustom(org.orgId, "PRJ-2")).rows;
      assert.equal(rows.length, 1);
      assert.deepEqual((rows[0]!.custom as Record<string, unknown>).source, {
        system: "other",
        externalId: "PRJ-2",
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
