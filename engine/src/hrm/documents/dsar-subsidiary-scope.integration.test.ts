import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import { HrmDocumentsError } from "./errors.ts";
import {
  buildExport,
  downloadExport,
  listExports,
  requestExport,
} from "./dsar.ts";

/**
 * H-DSAR two-entity regressions (integration partition): an HR actor
 * restricted to subsidiary A cannot queue a full data ZIP for B's people,
 * lists only in-scope subjects' exports, and cannot download (or mark
 * delivered) B's ready export. Proofs are read back from storage, never
 * from service returns alone.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableFeatures(orgId: string): Promise<void> {
  for (const feature of ["hrm", "hrmDocuments", "hrmDataSubjectExport"]) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${feature}}`}::text[], 'true'::jsonb, true)
       where id = ${orgId}
    `);
  }
}

async function seedPerson(
  orgId: string,
  subsidiaryId: string,
  name: string,
): Promise<{ partyId: string; employmentId: string }> {
  const partyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, email, is_active, custom)
    values (${partyId}, ${orgId}, 'person', ${name}, ${`${name.replaceAll(" ", ".").toLowerCase()}@scratch.test`}, true, '{}'::jsonb)
  `);
  const employmentId = randomUUID();
  await db.execute(sql`
    insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
    values (${employmentId}, ${orgId}, ${partyId}, ${subsidiaryId}, 1)
  `);
  await db.execute(sql`
    insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
    values (${orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())
  `);
  return { partyId, employmentId };
}

async function mkSecondSubsidiary(orgId: string, parentId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${orgId}, ${parentId}, 'Second Co', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`);
  return id;
}

type Harness = {
  org: ScratchOrg;
  adminId: string;
  managerAId: string;
  partyA: string;
  partyB: string;
};

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableFeatures(org.orgId);
  const subB = await mkSecondSubsidiary(org.orgId, org.subsidiaryId);
  const empA = await seedPerson(org.orgId, org.subsidiaryId, "Amy Alpha");
  const empB = await seedPerson(org.orgId, subB, "Ben Beta");
  const adminId = await createScratchUser(org.orgId, "Ada Admin", "dsar_admin");
  await db.execute(sql`
    update app_roles
       set permissions = '["hrm.documents.read", "hrm.documents.manage"]'::jsonb,
           subsidiary_restriction = '{"mode": "all"}'::jsonb
     where org_id = ${org.orgId} and key = 'dsar_admin'`);
  const managerAId = await createScratchUser(org.orgId, "Mara Manager", "dsar_manager_a");
  await db.execute(sql`
    update app_roles
       set permissions = '["hrm.documents.read", "hrm.documents.manage"]'::jsonb,
           subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
     where org_id = ${org.orgId} and key = 'dsar_manager_a'`);
  return { org, adminId, managerAId, partyA: empA.partyId, partyB: empB.partyId };
}

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  if (!DB) return;
  const h = await setupHarness();
  try {
    await fn(h);
  } finally {
    await dropScratchOrg(h.org.orgId);
  }
}

async function exportCount(orgId: string, partyId: string): Promise<number> {
  return Number(
    (
      await db.execute<{ n: string }>(sql`
        select count(*) as n from hrm_data_subject_exports where org_id = ${orgId} and party_id = ${partyId}
      `)
    ).rows[0]!.n,
  );
}

test("an A-restricted manager cannot queue an export for an out-of-scope subject", { skip: !DB }, async () => {
  await withHarness(async (h: Harness) => {
    const before = await exportCount(h.org.orgId, h.partyB);
    await assert.rejects(
      requestExport({ orgId: h.org.orgId, actorId: h.managerAId, partyId: h.partyB }),
      /not visible in this organization/,
    );
    assert.equal(await exportCount(h.org.orgId, h.partyB), before);
    // The in-scope subject still queues.
    const queued = await requestExport({ orgId: h.org.orgId, actorId: h.managerAId, partyId: h.partyA });
    assert.equal(queued.partyId, h.partyA);
  });
});

test("an A-restricted manager lists only in-scope subjects' exports", { skip: !DB }, async () => {
  await withHarness(async (h: Harness) => {
    await requestExport({ orgId: h.org.orgId, actorId: h.adminId, partyId: h.partyA });
    await requestExport({ orgId: h.org.orgId, actorId: h.adminId, partyId: h.partyB });
    const listed = await listExports({ orgId: h.org.orgId, actorId: h.managerAId });
    assert.ok(listed.length > 0);
    for (const row of listed) assert.equal(row.partyId, h.partyA);
    await assert.rejects(
      listExports({ orgId: h.org.orgId, actorId: h.managerAId, partyId: h.partyB }),
      /not visible in this organization/,
    );
  });
});

test("an A-restricted manager cannot download an out-of-scope ready export", { skip: !DB }, async () => {
  await withHarness(async (h: Harness) => {
    const requested = await requestExport({ orgId: h.org.orgId, actorId: h.adminId, partyId: h.partyB });
    await buildExport(h.org.orgId, requested.id);
    const status = (
      await db.execute<{ status: string }>(sql`
        select status from hrm_data_subject_exports where org_id = ${h.org.orgId} and id = ${requested.id}
      `)
    ).rows[0]!.status;
    assert.equal(status, "ready");
    await assert.rejects(
      downloadExport({ orgId: h.org.orgId, actorId: h.managerAId, exportId: requested.id }),
      (e: unknown) => e instanceof HrmDocumentsError || /not visible in this organization/.test(String(e)),
    );
    // The refused read never flips the row to delivered.
    const after = (
      await db.execute<{ status: string }>(sql`
        select status from hrm_data_subject_exports where org_id = ${h.org.orgId} and id = ${requested.id}
      `)
    ).rows[0]!.status;
    assert.equal(after, "ready");
  });
});
