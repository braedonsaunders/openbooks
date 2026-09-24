import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { loadEntities } from "./migrate.ts";
import type { EntityStream, MigrationSource } from "./source.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function source(name: string, refKey: string): MigrationSource {
  return { name, refKey, baseCurrency: "CAD" } as MigrationSource;
}

function parties(name: string): EntityStream[] {
  return [{
    resource: "parties",
    records: [{ sourceRef: "SHARED-42", fields: { displayName: name, kind: "company", isActive: true } }],
  }];
}

test("the same external id from different connectors lands as separate canonical source identities", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const qbo = await withOrg(org.orgId, () =>
      loadEntities(source("qbo", "qboId"), org.orgId, null, undefined, undefined, parties("QBO company")),
    );
    const netsuite = await withOrg(org.orgId, () =>
      loadEntities(source("netsuite", "nsId"), org.orgId, null, undefined, undefined, parties("NetSuite company")),
    );
    assert.equal(qbo.parties?.created, 1);
    assert.equal(netsuite.parties?.created, 1, "a different connector must not adopt QBO's external id");
    const rows = await withOrg(org.orgId, () =>
      db.execute<{ display_name: string; custom: Record<string, unknown> }>(sql`
        select display_name, custom from parties
         where org_id = ${org.orgId}
           and custom->>'qboId' = 'SHARED-42' or
               org_id = ${org.orgId} and custom->>'nsId' = 'SHARED-42'
         order by display_name`),
    );
    assert.deepEqual(rows.rows.map((row) => ({
      name: row.display_name,
      custom: row.custom,
    })), [
      {
        name: "NetSuite company",
        custom: { nsId: "SHARED-42", source: { system: "netsuite", externalId: "SHARED-42" } },
      },
      {
        name: "QBO company",
        custom: { qboId: "SHARED-42", source: { system: "qbo", externalId: "SHARED-42" } },
      },
    ]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("duplicate legacy adapter keys refuse without updating either party", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await withOrg(org.orgId, () => db.execute(sql`
      insert into parties (org_id, kind, display_name, is_active, custom)
      values
        (${org.orgId}, 'company', 'Legacy A', true, '{"nsId":"DUP-7"}'::jsonb),
        (${org.orgId}, 'company', 'Legacy B', true, '{"nsId":"DUP-7"}'::jsonb)`));

    await assert.rejects(
      () => withOrg(org.orgId, () =>
        loadEntities(source("netsuite", "nsId"), org.orgId, null, undefined, undefined, [{
          resource: "parties",
          records: [{ sourceRef: "DUP-7", fields: { displayName: "Replacement", kind: "company" } }],
        }]),
      ),
      /contains multiple rows for connector identity nsId:DUP-7/,
    );
    const rows = await withOrg(org.orgId, () => db.execute<{ display_name: string }>(sql`
      select display_name from parties where org_id = ${org.orgId} and custom->>'nsId' = 'DUP-7' order by display_name`));
    assert.deepEqual(rows.rows.map((row) => row.display_name), ["Legacy A", "Legacy B"]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
