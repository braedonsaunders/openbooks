/**
 * A mirror run that lands everything reports ok; a run with entity-load
 * failures reports ok_with_errors instead of a dishonest ok.
 *
 * Entity errors used to hide inside stats.entities while the run row claimed
 * success — weeks of role-upsert 42702s passed unnoticed on a tenant. The
 * run still completes (verification gates and the cursor are unaffected);
 * only the reported status changes so the controller looks.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { runSync } from "./sync.ts";
import type { EntityStream, MigrationSource } from "./source.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

class EntityErrorSource implements MigrationSource {
  readonly name = "qbo";
  readonly refKey = "qboId";
  readonly baseCurrency = "CAD";
  constructor(private readonly badCredit: boolean) {}

  accountingPeriods(): Promise<never[]> {
    return Promise.resolve([]);
  }

  async entities(): Promise<EntityStream[]> {
    return [
      {
        resource: "parties",
        records: [
          {
            sourceRef: "GOOD-1",
            fields: { displayName: "Good Co", kind: "company", isActive: true },
          },
          ...(this.badCredit
            ? [
                {
                  sourceRef: "BAD-1",
                  fields: {
                    displayName: "Bad Credit Co",
                    kind: "company",
                    isActive: true,
                    customerRole: { creditLimit: "not-a-decimal" },
                  },
                },
              ]
            : []),
        ],
      },
    ];
  }

  nativeChanges(): Promise<{
    documents: [];
    applications: [];
    deletedRefs: [];
    syncedThrough: Date;
    unbuildable: [];
  }> {
    return Promise.resolve({
      documents: [],
      applications: [],
      deletedRefs: [],
      syncedThrough: new Date("2026-07-20T00:00:00.000Z"),
      unbuildable: [],
    });
  }

  trialBalance(): Promise<never[]> {
    return Promise.resolve([]);
  }

  monthlyActivity(): Promise<never[]> {
    return Promise.resolve([]);
  }

  openItems(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

async function runStatus(orgId: string, connectionId: string) {
  const rows = (await db.execute<{ status: string; error: string | null }>(sql`
    select status, error_message as error from sync_runs
     where org_id = ${orgId} and connection_id = ${connectionId}
     order by started_at desc limit 1`)).rows;
  return rows[0]!;
}

test(
  "a mirror run with entity failures reports ok_with_errors, a clean run ok",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const org = await createScratchOrg();
    try {
      const connectionId = randomUUID();
      await db.execute(sql`
        insert into connections (id, org_id, source, display_name)
        values (${connectionId}, ${org.orgId}, 'qbo', 'entity-error-status-test')`);

      const clean = await runSync(new EntityErrorSource(false), "entity-error-status-test", {
        kind: "full_migration",
        orgId: org.orgId,
        connectionId,
        since: null,
      });
      assert.equal(clean.entities?.parties?.failed ?? -1, 0);
      assert.equal((await runStatus(org.orgId, connectionId)).status, "ok");

      const dirty = await runSync(new EntityErrorSource(true), "entity-error-status-test", {
        kind: "full_migration",
        orgId: org.orgId,
        connectionId,
        since: null,
      });
      assert.equal(dirty.entities?.parties?.failed ?? -1, 1);
      const row = await runStatus(org.orgId, connectionId);
      assert.equal(row.status, "ok_with_errors");
      assert.match(row.error ?? "", /1 master-data record.*failed/);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
