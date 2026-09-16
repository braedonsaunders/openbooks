/**
 * Mirror party-role upserts must survive their own conflict guard.
 *
 * The role upsert keys on the globally unique party_id and pins the tenant
 * on the ON CONFLICT DO UPDATE write. A bare `where org_id = …` there is
 * visible as both the existing row and the proposed row, so PostgreSQL
 * rejects every role write with 42702 (column reference "org_id" is
 * ambiguous) — the party lands but its customer/vendor/employee role never
 * does, and the run records an entity error while reporting success.
 *
 * Red without the fix: parties.failed is 3 and no role row exists.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../db.ts";
import { createScratchOrg, dropScratchOrg } from "../test-fixtures.ts";
import { loadEntities } from "./migrate.ts";
import type { EntityStream, MigrationSource, SourceEntity } from "./source.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function stubSource(): MigrationSource {
  return {
    name: "role-upsert-test",
    refKey: "roleUpsertTest",
    baseCurrency: "CAD",
    accountingPeriods: async () => [],
    entities: async () => [],
    nativeChanges: async () => {
      throw new Error("not used by this test");
    },
    trialBalance: async () => [],
    monthlyActivity: async () => [],
  } as unknown as MigrationSource;
}

function partyRecord(sourceRef: string, role: Record<string, unknown>): SourceEntity {
  return {
    sourceRef,
    fields: { displayName: `Party ${sourceRef}`, kind: "company", isActive: true, ...role },
  };
}

const STREAMS = (creditLimit: string): EntityStream[] => [
  {
    resource: "parties",
    records: [
      partyRecord("C-2427", { customerRole: { creditLimit } }),
      partyRecord("V-9", { vendorRole: {} }),
      partyRecord("E-2790", { employeeRole: { employeeNumber: "E-2790" } }),
    ],
  },
];

async function roleRows(orgId: string) {
  return withOrg(orgId, () =>
    db.execute<{
      table: string;
      ref: string;
      credit: string | null;
      employeeNumber: string | null;
    }>(sql`
      select 'customer' as table, d.custom->>'roleUpsertTest' as ref,
             r.credit_limit::text as credit, null::text as "employeeNumber"
        from customer_roles r join parties d on d.id = r.party_id
       where r.org_id = ${orgId}
      union all
      select 'vendor', d.custom->>'roleUpsertTest', null, null
        from vendor_roles r join parties d on d.id = r.party_id
       where r.org_id = ${orgId}
      union all
      select 'employee', d.custom->>'roleUpsertTest', null, r.employee_number
        from employee_roles r join parties d on d.id = r.party_id
       where r.org_id = ${orgId}`),
  ).then((r) => r.rows);
}

test(
  "party role upserts land on insert and on the party_id conflict write",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const org = await createScratchOrg();
    try {
      const first = await withOrg(org.orgId, () =>
        loadEntities(stubSource(), org.orgId, null, undefined, undefined, STREAMS("1738300.0000")),
      );
      assert.deepEqual(first.parties?.errors ?? [], []);
      assert.equal(first.parties?.failed ?? -1, 0);
      const landed = await roleRows(org.orgId);
      assert.equal(landed.length, 3);
      assert.equal(
        landed.find((r) => r.table === "customer")?.credit,
        "1738300.0000",
      );
      assert.equal(
        landed.find((r) => r.table === "employee")?.employeeNumber,
        "E-2790",
      );

      // Second pull hits the ON CONFLICT DO UPDATE branch for every role.
      const second = await withOrg(org.orgId, () =>
        loadEntities(stubSource(), org.orgId, null, undefined, undefined, STREAMS("1800000.0000")),
      );
      assert.deepEqual(second.parties?.errors ?? [], []);
      assert.equal(second.parties?.failed ?? -1, 0);
      const relanded = await roleRows(org.orgId);
      assert.equal(relanded.length, 3);
      assert.equal(
        relanded.find((r) => r.table === "customer")?.credit,
        "1800000.0000",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
