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
import { HrmAuthorizationError } from "../authorization.ts";
import { UnrestrictedScopeError } from "../../organization/subsidiary-scope.ts";
import { HrmDocumentsError } from "./errors.ts";
import {
  generateDocument,
  getDocumentDetail,
  listDocuments,
  readDocumentFile,
  sendDocument,
  setLegalHold,
  uploadDocument,
  voidDocument,
} from "./documents.ts";
import { saveCategory } from "./categories.ts";
import { saveTemplate } from "./templates.ts";

/**
 * H-HRMDOCS two-entity regressions (integration partition): an HR actor
 * restricted to subsidiary A lists only A's subjects' documents, and
 * reads, downloads, sends, holds, voids, generates and template writes
 * against B's subjects are refused — with B's rows proven untouched in
 * storage. Proofs are read back from storage, never from service returns
 * alone.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

async function enableFeatures(orgId: string): Promise<void> {
  for (const feature of ["hrm", "hrmDocuments"]) {
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
  subB: string;
  adminId: string;
  managerAId: string;
  partyA: string;
  employmentA: string;
  partyB: string;
  employmentB: string;
  dualParty: string;
  dualEmploymentA: string;
  dualEmploymentB: string;
  templateId: string;
  docAId: string;
  docBId: string;
  docDualAId: string;
  docDualBId: string;
};

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableFeatures(org.orgId);
  const subB = await mkSecondSubsidiary(org.orgId, org.subsidiaryId);
  const empA = await seedPerson(org.orgId, org.subsidiaryId, "Amy Alpha");
  const empB = await seedPerson(org.orgId, subB, "Ben Beta");
  const adminId = await createScratchUser(org.orgId, "Ada Admin", "doc_admin");
  await db.execute(sql`
    update app_roles
       set permissions = '["hrm.documents.read", "hrm.documents.manage"]'::jsonb,
           subsidiary_restriction = '{"mode": "all"}'::jsonb
     where org_id = ${org.orgId} and key = 'doc_admin'`);
  const managerAId = await createScratchUser(org.orgId, "Mara Manager", "doc_manager_a");
  await db.execute(sql`
    update app_roles
       set permissions = '["hrm.documents.read", "hrm.documents.manage"]'::jsonb,
           subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
     where org_id = ${org.orgId} and key = 'doc_manager_a'`);
  await saveCategory({ orgId: org.orgId, actorId: adminId, key: "contract", label: "Contracts" });
  const tpl = await saveTemplate({
    orgId: org.orgId,
    actorId: adminId,
    name: `Offer ${randomUUID().slice(0, 8)}`,
    categoryKey: "contract",
    bodyTemplate: "Dear {{employee_name}} of {{org_name}}.",
    mergeFields: ["employee_name", "org_name"],
    requiresSignature: false,
    signerRoles: [],
    acknowledgmentOnly: true,
  });
  const docA = await generateDocument({
    orgId: org.orgId,
    actorId: adminId,
    templateId: tpl.id,
    employmentId: empA.employmentId,
    partyId: empA.partyId,
    title: "A offer",
    today: "2026-09-21",
  });
  const docB = await generateDocument({
    orgId: org.orgId,
    actorId: adminId,
    templateId: tpl.id,
    employmentId: empB.employmentId,
    partyId: empB.partyId,
    title: "B offer",
    today: "2026-09-21",
  });
  // One person employed by both entities: the B-employment slice must stay
  // out of an A-only actor's reach even though the A employment admits them.
  const dualPartyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, email, is_active, custom)
    values (${dualPartyId}, ${org.orgId}, 'person', 'Dana Dual', 'dana.dual@scratch.test', true, '{}'::jsonb)
  `);
  const dualEmploymentA = randomUUID();
  const dualEmploymentB = randomUUID();
  for (const [employmentId, subsidiaryId] of [
    [dualEmploymentA, org.subsidiaryId],
    [dualEmploymentB, subB],
  ] as const) {
    await db.execute(sql`
      insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
      values (${employmentId}, ${org.orgId}, ${dualPartyId}, ${subsidiaryId}, 1)
    `);
    await db.execute(sql`
      insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
      values (${org.orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())
    `);
  }
  const docDualA = await generateDocument({
    orgId: org.orgId,
    actorId: adminId,
    templateId: tpl.id,
    employmentId: dualEmploymentA,
    partyId: dualPartyId,
    title: "Dual A offer",
    today: "2026-09-21",
  });
  const docDualB = await generateDocument({
    orgId: org.orgId,
    actorId: adminId,
    templateId: tpl.id,
    employmentId: dualEmploymentB,
    partyId: dualPartyId,
    title: "Dual B offer",
    today: "2026-09-21",
  });
  return {
    org,
    subB,
    adminId,
    managerAId,
    partyA: empA.partyId,
    employmentA: empA.employmentId,
    partyB: empB.partyId,
    employmentB: empB.employmentId,
    dualParty: dualPartyId,
    dualEmploymentA,
    dualEmploymentB,
    templateId: tpl.id,
    docAId: docA.document.id,
    docBId: docB.document.id,
    docDualAId: docDualA.document.id,
    docDualBId: docDualB.document.id,
  };
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

async function docStatus(orgId: string, docId: string): Promise<string> {
  return (await db.execute<{ status: string }>(sql`
    select status from hrm_documents where org_id = ${orgId} and id = ${docId}
  `)).rows[0]!.status;
}

test("an A-restricted manager lists only in-scope subjects' documents", { skip: !DB }, async () => {
  await withHarness(async (h: Harness) => {
    const docs = await listDocuments({ orgId: h.org.orgId, actorId: h.managerAId });
    assert.deepEqual(new Set(docs.map((d) => d.id)), new Set([h.docAId, h.docDualAId]));
    const adminDocs = await listDocuments({ orgId: h.org.orgId, actorId: h.adminId });
    assert.equal(adminDocs.length, 4);
    await assert.rejects(
      listDocuments({ orgId: h.org.orgId, actorId: h.managerAId, partyId: h.partyB }),
      (e: unknown) => e instanceof HrmAuthorizationError && /not visible in this organization/.test(e.message),
    );
  });
});

test("a dual A+B employee's B-employment slice stays out of an A-only actor's reach", { skip: !DB }, async () => {
  await withHarness(async (h: Harness) => {
    const q = { orgId: h.org.orgId, actorId: h.managerAId };
    await assert.rejects(
      getDocumentDetail({ ...q, documentId: h.docDualBId }),
      /not visible in this organization/,
    );
    await assert.rejects(
      readDocumentFile({ ...q, documentId: h.docDualBId }),
      /not visible in this organization/,
    );
    // The A-employment slice of the same person stays readable.
    const detail = await getDocumentDetail({ ...q, documentId: h.docDualAId });
    assert.equal(detail.id, h.docDualAId);
  });
});

test("an A-restricted manager cannot read, download, send, hold or void B's document", { skip: !DB }, async () => {
  await withHarness(async (h: Harness) => {
    const q = { orgId: h.org.orgId, actorId: h.managerAId, documentId: h.docBId };
    await assert.rejects(getDocumentDetail(q), /not visible in this organization/);
    await assert.rejects(readDocumentFile(q), /not visible in this organization/);
    await assert.rejects(sendDocument(q), /not visible in this organization/);
    await assert.rejects(setLegalHold({ ...q, hold: true }), /not visible in this organization/);
    await assert.rejects(
      voidDocument({ ...q, reason: "cross-entity void attempt" }),
      /not visible in this organization/,
    );
    // B's row is untouched: still a draft with no hold.
    assert.equal(await docStatus(h.org.orgId, h.docBId), "draft");
    const hold = (await db.execute<{ legal_hold: boolean }>(sql`
      select legal_hold from hrm_documents where org_id = ${h.org.orgId} and id = ${h.docBId}
    `)).rows[0]!.legal_hold;
    assert.equal(hold, false);
    // The in-scope document still works for the restricted manager.
    const detail = await getDocumentDetail({
      orgId: h.org.orgId,
      actorId: h.managerAId,
      documentId: h.docAId,
    });
    assert.equal(detail.id, h.docAId);
  });
});

test("upload refuses an undeclared category and files a declared one", { skip: !DB }, async () => {
  await withHarness(async (h: Harness) => {
    const filed = {
      orgId: h.org.orgId,
      actorId: h.adminId,
      partyId: h.partyA,
      title: "Filed memo",
      filename: "memo.pdf",
      contentType: "application/pdf",
      bytes: Buffer.from("%PDF-1.4 memo"),
    };
    await assert.rejects(
      uploadDocument({ ...filed, categoryKey: "typo-category" }),
      (e: unknown) => e instanceof HrmDocumentsError && /not declared/.test(e.message),
    );
    const stored = await uploadDocument({ ...filed, categoryKey: "contract" });
    assert.equal(stored.categoryKey, "contract");
    const row = (await db.execute<{ category_key: string }>(sql`
      select category_key from hrm_documents where org_id = ${h.org.orgId} and id = ${stored.id}
    `)).rows[0]!;
    assert.equal(row.category_key, "contract");
  });
});

test("an A-restricted manager cannot generate for or template over an out-of-scope subject", { skip: !DB }, async () => {
  await withHarness(async (h: Harness) => {
    const before = (await db.execute<{ n: string }>(sql`
      select count(*) as n from hrm_documents where org_id = ${h.org.orgId} and party_id = ${h.partyB}
    `)).rows[0]!.n;
    await assert.rejects(
      generateDocument({
        orgId: h.org.orgId,
        actorId: h.managerAId,
        templateId: h.templateId,
        employmentId: h.employmentB,
        partyId: h.partyB,
        title: "B offer by restricted manager",
        today: "2026-09-21",
      }),
      /not visible in this organization/,
    );
    const after = (await db.execute<{ n: string }>(sql`
      select count(*) as n from hrm_documents where org_id = ${h.org.orgId} and party_id = ${h.partyB}
    `)).rows[0]!.n;
    assert.equal(after, before);
    await assert.rejects(
      saveTemplate({
        orgId: h.org.orgId,
        actorId: h.managerAId,
        name: "Restricted template",
        categoryKey: "contract",
        bodyTemplate: "Hello {{employee_name}}.",
        mergeFields: ["employee_name"],
        requiresSignature: false,
        signerRoles: [],
        acknowledgmentOnly: true,
      }),
      (e: unknown) =>
        e instanceof UnrestrictedScopeError && /requires unrestricted subsidiary access/.test(e.message),
    );
  });
});
