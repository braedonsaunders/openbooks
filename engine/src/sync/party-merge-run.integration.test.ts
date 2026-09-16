/**
 * The mirror's run summary carries source-entity merges and holds.
 *
 * Red without the SyncResult wiring: the merge applies (entities converge)
 * but the run result has no partyMerges/partyHolds line for the controller.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, dropScratchOrg } from "../test-fixtures.ts";
import { runSync } from "./sync.ts";
import type { EntityStream, MigrationSource, SourceEntity } from "./source.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function party(sourceRef: string, mergedIntoRef?: string): SourceEntity {
  return {
    sourceRef,
    fields: { displayName: `${sourceRef} Co`, kind: "company", isActive: true },
    ...(mergedIntoRef ? { mergedIntoRef } : {}),
  };
}

class MergeHoldSource implements MigrationSource {
  readonly name = "qbo";
  readonly refKey = "qboId";
  readonly baseCurrency = "CAD";
  merged = false;

  accountingPeriods(): Promise<SourceEntity[]> {
    return Promise.resolve([]);
  }

  async entities(): Promise<EntityStream[]> {
    return [
      {
        resource: "parties",
        records: this.merged
          ? [party("A"), party("B", "A")]
          : [party("A"), party("B"), party("C")],
      },
      {
        resource: "contacts",
        records: this.merged
          ? [{ sourceRef: "C-1", fields: { companyRef: "B", name: "Bee" } }]
          : [
              { sourceRef: "C-1", fields: { companyRef: "B", name: "Bee" } },
              { sourceRef: "C-2", fields: { companyRef: "C", name: "Cee" } },
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

test(
  "a mirror run reports applied party merges and held parties in its summary",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const org = await createScratchOrg();
    try {
      const connectionId = randomUUID();
      await db.execute(sql`
        insert into connections (id, org_id, source, display_name)
        values (${connectionId}, ${org.orgId}, 'qbo', 'party-merge-run-test')`);
      const source = new MergeHoldSource();

      const first = await runSync(source, "party-merge-run-test", {
        kind: "full_migration",
        orgId: org.orgId,
        connectionId,
        since: null,
      });
      assert.deepEqual(first.partyMerges ?? [], []);
      assert.deepEqual(first.partyHolds ?? [], []);

      // Upstream merges B into A and drops C (still referenced by its contact).
      source.merged = true;
      const second = await runSync(source, "party-merge-run-test", {
        kind: "full_migration",
        orgId: org.orgId,
        connectionId,
        since: null,
      });
      assert.deepEqual(second.partyMerges, [{ absorbedRef: "B", survivorRef: "A" }]);
      assert.deepEqual(second.partyHolds, ["C"]);
      assert.equal(second.entities?.parties?.failed, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
