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
import { db, withBypass, withOrg } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
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

test(
  "the same connector pull in two orgs lands separate parties and roles",
  { skip: !DB, timeout: 180_000 },
  async () => {
    // Tenant isolation of the whole upsert path: the same sourceRef pulled
    // into two orgs must create one party and one role row per org. An
    // org-unscoped party lookup would make the second org adopt the first
    // org's party (no new rows, and the conflict guard would then refuse
    // the role write), while an org-unscoped role write would overwrite the
    // first org's credit limit with the second's.
    const orgA = await createScratchOrg();
    const orgB = await createScratchOrg();
    try {
      const first = await withOrg(orgA.orgId, () =>
        loadEntities(stubSource(), orgA.orgId, null, undefined, undefined, STREAMS("1738300.0000")),
      );
      assert.deepEqual(first.parties?.errors ?? [], []);
      assert.equal(first.parties?.failed ?? -1, 0);
      // Under bypass there is no ambient RLS: only the loaders' own tenant
      // scoping stands between org B's pull and org A's rows.
      const second = await withBypass(() =>
        loadEntities(stubSource(), orgB.orgId, null, undefined, undefined, STREAMS("999.0000")),
      );
      assert.deepEqual(second.parties?.errors ?? [], []);
      assert.equal(second.parties?.failed ?? -1, 0);

      const rolesA = await roleRows(orgA.orgId);
      const rolesB = await roleRows(orgB.orgId);
      assert.equal(rolesA.length, 3);
      assert.equal(rolesB.length, 3);
      assert.equal(
        rolesA.find((r) => r.table === "customer")?.credit,
        "1738300.0000",
      );
      assert.equal(
        rolesB.find((r) => r.table === "customer")?.credit,
        "999.0000",
      );

      // The shared sourceRef resolves to one party per org, never a shared row.
      const parties = await db.execute<{ orgId: string; partyId: string }>(sql`
        select org_id as "orgId", id as "partyId" from parties
         where custom->>'roleUpsertTest' = 'C-2427'
           and org_id in (${orgA.orgId}, ${orgB.orgId})`);
      const byOrg = new Map(parties.rows.map((r) => [r.orgId, r.partyId]));
      assert.equal(byOrg.size, 2);
      assert.ok(byOrg.has(orgA.orgId) && byOrg.has(orgB.orgId));
      assert.notEqual(byOrg.get(orgA.orgId), byOrg.get(orgB.orgId));
    } finally {
      await dropScratchOrg(orgA.orgId);
      await dropScratchOrg(orgB.orgId);
    }
  },
);
