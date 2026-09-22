/**
 * Document identity is namespaced per source, not per connection: two live
 * same-source connections in one org would merge charts (every master-data
 * loader keys accounts and parties by the adapter's refKey org-wide) and
 * cross-update each other's `Invoice:123`.
 *
 * The connections table constrains only (org_id, display_name), so nothing
 * at the schema level stops the second connection — the sync refuses the run
 * naming the sibling before any write, including master data.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";
import { runSync } from "./sync.ts";
import type { MigrationSource } from "./source.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function newConnection(orgId: string, displayName: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into connections (id, org_id, source, display_name)
    values (${id}, ${orgId}, 'qbo', ${displayName})`);
  return id;
}

test(
  "a second live same-source connection refuses the run before any write",
  { skip: !DB },
  async () => {
    const o: ScratchOrg = await createScratchOrg();
    try {
      const primary = await newConnection(o.orgId, "qbo-primary");
      await newConnection(o.orgId, "qbo-duplicate");
      let pulled = false;
      const source = {
        name: "qbo",
        refKey: "qboId",
        baseCurrency: "CAD",
        nativeChanges: async () => {
          pulled = true;
          return {
            documents: [],
            applications: [],
            deletedRefs: [],
            syncedThrough: new Date(),
            unbuildable: [],
          };
        },
      } as unknown as MigrationSource;

      await assert.rejects(
        runSync(source, "identity-probe", {
          kind: "incremental",
          orgId: o.orgId,
          connectionId: primary,
          since: new Date("2026-07-16T00:00:00.000Z"),
          loadEntitiesFirst: false,
        }),
        (error: Error) =>
          /another qbo connection/.test(error.message) &&
          /qbo-duplicate/.test(error.message) &&
          /remove the duplicate connection/.test(error.message),
      );
      // The refusal lands before the pull, let alone any write.
      assert.equal(pulled, false);
      const docs = (await db.execute<{ count: number }>(sql`
        select count(*)::int as count from documents where org_id = ${o.orgId}`));
      assert.equal(docs.rows[0]?.count, 0);
    } finally {
      await dropScratchOrg(o.orgId);
    }
  },
);
