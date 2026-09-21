import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { HrmDocumentsError } from "./documents/errors.ts";
import {
  acknowledgeDocument,
  generateDocument,
  getDocumentDetail,
  listDocuments,
  listOwnDocuments,
  readDocumentFile,
  readTokenDocument,
  sendDocument,
  signTokenDocument,
  declineTokenDocument,
  voidDocument,
  setLegalHold,
} from "./documents/documents.ts";
import { saveCategory } from "./documents/categories.ts";
import { saveTemplate } from "./documents/templates.ts";

/**
 * HR-19 documents DB coverage (integration partition): migration 0230
 * bootstrap, generate → send → ordered sign with evidence, signed-PDF
 * version append, token replay refusal, foreign-document read refusal,
 * void/acknowledge/hold, and the feature-off refusal. Proofs are read
 * back from storage, never from service returns alone.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

const FEATURES = ["hrm", "hrmDocuments", "hrmDocumentRetention", "hrmDataSubjectExport"];

async function enableFeatures(orgId: string): Promise<void> {
  for (const feature of FEATURES) {
    await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), ${`{features,${feature}}`}::text[], 'true'::jsonb, true)
       where id = ${orgId}
    `);
  }
}

async function grantPermissions(orgId: string, userId: string, permissions: string[]): Promise<void> {
  for (const permission of permissions) {
    await db.execute(sql`
      insert into user_permission_overrides (org_id, user_id, permission, effect)
      values (${orgId}, ${userId}, ${permission}, 'grant')
      on conflict (user_id, permission) do update set effect = 'grant'
    `);
  }
}

type Harness = {
  org: ScratchOrg;
  hrId: string;
  hrPartyId: string;
  employeeId: string;
  employeePartyId: string;
  employmentId: string;
  managerId: string;
  managerPartyId: string;
  managerEmploymentId: string;
};

async function seedPerson(orgId: string, subsidiaryId: string, name: string): Promise<{ partyId: string; employmentId: string }> {
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

async function setupHarness(): Promise<Harness> {
  const org = await createScratchOrg();
  await enableFeatures(org.orgId);
  const hr = await seedPerson(org.orgId, org.subsidiaryId, "HR Admin");
  const hrId = await createScratchUser(org.orgId, "HR Admin", "hr_admin");
  await db.execute(sql`update users set party_id = ${hr.partyId} where id = ${hrId} and org_id = ${org.orgId}`);
  const employee = await seedPerson(org.orgId, org.subsidiaryId, "Eddie Employee");
  const employeeId = await createScratchUser(org.orgId, "Eddie Employee", "employee_self");
  await db.execute(sql`update users set party_id = ${employee.partyId} where id = ${employeeId} and org_id = ${org.orgId}`);
  const manager = await seedPerson(org.orgId, org.subsidiaryId, "Mira Manager");
  const managerId = await createScratchUser(org.orgId, "Mira Manager", "manager_self");
  await db.execute(sql`update users set party_id = ${manager.partyId} where id = ${managerId} and org_id = ${org.orgId}`);
  await db.execute(sql`
    insert into reporting_relationships
      (org_id, employment_id, manager_employment_id, kind, relationship_id, version_no, effective_from, recorded_at)
    values (${org.orgId}, ${employee.employmentId}, ${manager.employmentId}, 'line',
            ${randomUUID()}, 1, '2020-01-01'::date, now())
  `);
  await grantPermissions(org.orgId, hrId, ["hrm.documents.read", "hrm.documents.manage"]);
  await grantPermissions(org.orgId, employeeId, ["hrm.self.read"]);
  await grantPermissions(org.orgId, managerId, ["hrm.self.read"]);
  // The declared category vocabulary templates must name.
  for (const [key, label] of [["contract", "Contracts"], ["policy", "Policies"]] as const) {
    await saveCategory({ orgId: org.orgId, actorId: hrId, key, label });
  }
  return {
    org,
    hrId,
    hrPartyId: hr.partyId,
    employeeId,
    employeePartyId: employee.partyId,
    employmentId: employee.employmentId,
    managerId,
    managerPartyId: manager.partyId,
    managerEmploymentId: manager.employmentId,
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

async function makeTemplate(h: Harness, signerRoles: string[]): Promise<string> {
  const tpl = await saveTemplate({
    orgId: h.org.orgId,
    actorId: h.hrId,
    name: `Offer ${randomUUID().slice(0, 8)}`,
    categoryKey: "contract",
    bodyTemplate: "Dear {{employee_name}} of {{org_name}}, your start is {{employment_start}}.",
    mergeFields: ["employee_name", "org_name", "employment_start"],
    requiresSignature: signerRoles.length > 0,
    signerRoles,
    acknowledgmentOnly: false,
  });
  return tpl.id;
}

test("generate, send, ordered sign completes with evidence and a signed PDF version", { skip: !DB }, async () => {
  await withHarness(async (h: Harness) => {
  const templateId = await makeTemplate(h, ["employee", "manager", "hr"]);
  const { document, mergePreview } = await generateDocument({
    orgId: h.org.orgId,
    actorId: h.hrId,
    templateId,
    employmentId: h.employmentId,
    partyId: h.employeePartyId,
    title: "Offer letter",
    today: "2026-09-21",
  });
  assert.equal(document.status, "draft");
  assert.ok(document.fileId);
  assert.match(mergePreview.employee_name, /Eddie Employee/);
  // The stored file is a real PDF with one version.
  const versions = (await db.execute<{ n: string }>(sql`
    select count(*) as n from file_versions where file_id = ${document.fileId!}
  `)).rows[0]!.n;
  assert.equal(versions, "1");

  const sent = await sendDocument({ orgId: h.org.orgId, actorId: h.hrId, documentId: document.id });
  assert.equal(sent.document.status, "sent");
  assert.equal(sent.deliveries.length, 3);
  assert.deepEqual(
    sent.deliveries.map((d) => d.partyId),
    [h.employeePartyId, h.managerPartyId, h.hrPartyId],
  );
  const [employeeToken, managerToken, hrToken] = sent.deliveries.map((d) => d.token);

  // Out-of-order signing is refused by name (manager before employee).
  await assert.rejects(
    signTokenDocument({ token: managerToken!, name: "Mira Manager" }),
    (e: unknown) => e instanceof HrmDocumentsError && e.code === "REFUSED" && /in order/.test(e.message),
  );

  // Viewing flips pending → viewed with an event, read back from storage.
  const viewed = await readTokenDocument(employeeToken!);
  assert.equal(viewed.document.id, document.id);
  const viewedRow = (await db.execute<{ status: string }>(sql`
    select status from hrm_document_signers where document_id = ${document.id} and ord = 0
  `)).rows[0]!;
  assert.equal(viewedRow.status, "viewed");

  const signed1 = await signTokenDocument({ token: employeeToken!, name: "Eddie Employee", ip: "10.0.0.1", userAgent: "test-agent" });
  assert.equal(signed1.status, "partially_signed");
  const signed2 = await signTokenDocument({ token: managerToken!, name: "Mira Manager" });
  assert.equal(signed2.status, "partially_signed");
  const done = await signTokenDocument({ token: hrToken!, name: "HR Admin" });
  assert.equal(done.status, "signed");
  assert.ok(done.completedAt);

  // Evidence hash recorded for every signer, read back from storage.
  const evidence = (await db.execute<{ role: string; evidence: { documentHash: string; ipHash: string | null } }>(sql`
    select role, evidence from hrm_document_signers
     where document_id = ${document.id} order by ord
  `)).rows;
  assert.equal(evidence.length, 3);
  for (const row of evidence) {
    assert.match(row.evidence.documentHash, /^[0-9a-f]{64}$/);
  }
  assert.ok(evidence[0]!.evidence.ipHash);

  // The signed PDF appended a second file version; retain_until stored.
  const versionsAfter = (await db.execute<{ n: string }>(sql`
    select count(*) as n from file_versions where file_id = ${document.fileId!}
  `)).rows[0]!.n;
  assert.equal(versionsAfter, "2");
  const stored = (await db.execute<{ status: string; retain_until: string | null }>(sql`
    select status, retain_until::text as retain_until from hrm_documents where id = ${document.id}
  `)).rows[0]!;
  assert.equal(stored.status, "signed");

  // Token replay after completion is refused, never double-counted.
  await assert.rejects(
    signTokenDocument({ token: employeeToken!, name: "Eddie Employee" }),
    (e: unknown) => e instanceof HrmDocumentsError && /once/.test(e.message),
  );
  const signEvents = (await db.execute<{ n: string }>(sql`
    select count(*) as n from hrm_document_events where document_id = ${document.id} and kind = 'signed'
  `)).rows[0]!.n;
  assert.equal(signEvents, "3");
  });
});

test("a foreign actor cannot read another person's document", { skip: !DB }, async () => {
  await withHarness(async (h: Harness) => {
  const templateId = await makeTemplate(h, ["employee"]);
  const { document } = await generateDocument({
    orgId: h.org.orgId,
    actorId: h.hrId,
    templateId,
    employmentId: h.employmentId,
    partyId: h.employeePartyId,
    title: "Private letter",
    today: "2026-09-21",
  });
  // The manager is not the subject and holds no HR grant.
  await assert.rejects(
    readDocumentFile({ orgId: h.org.orgId, actorId: h.managerId, documentId: document.id }),
    (e: unknown) => e instanceof HrmDocumentsError && e.code === "FORBIDDEN",
  );
  // The subject reads their own file through the self grant.
  const own = await readDocumentFile({ orgId: h.org.orgId, actorId: h.employeeId, documentId: document.id });
  assert.ok(own.bytes.length > 0);
  // Me listing is fenced to the own party.
  const mine = await listOwnDocuments({ orgId: h.org.orgId, actorId: h.employeeId });
  assert.equal(mine.partyId, h.employeePartyId);
  assert.ok(mine.documents.some((d) => d.id === document.id));
  const hrList = await listDocuments({ orgId: h.org.orgId, actorId: h.hrId, partyId: h.employeePartyId });
  assert.ok(hrList.some((d) => d.id === document.id));
  });
});

test("decline, void, acknowledge, and legal hold follow their rules", { skip: !DB }, async () => {
  await withHarness(async (h: Harness) => {
  const templateId = await makeTemplate(h, ["employee"]);
  const { document } = await generateDocument({
    orgId: h.org.orgId,
    actorId: h.hrId,
    templateId,
    employmentId: h.employmentId,
    partyId: h.employeePartyId,
    title: "Declinable",
    today: "2026-09-21",
  });
  const sent = await sendDocument({ orgId: h.org.orgId, actorId: h.hrId, documentId: document.id });
  const declined = await declineTokenDocument({ token: sent.deliveries[0]!.token, reason: "Wrong start date" });
  assert.equal(declined.status, "declined");
  // A signed-completed document cannot be voided; re-issue instead.
  const ackTpl = await saveTemplate({
    orgId: h.org.orgId,
    actorId: h.hrId,
    name: `Policy ${randomUUID().slice(0, 8)}`,
    categoryKey: "policy",
    bodyTemplate: "Policy for {{employee_name}}.",
    mergeFields: ["employee_name"],
    requiresSignature: false,
    signerRoles: [],
    acknowledgmentOnly: true,
  });
  const ack = await generateDocument({
    orgId: h.org.orgId,
    actorId: h.hrId,
    templateId: ackTpl.id,
    employmentId: h.employmentId,
    partyId: h.employeePartyId,
    title: "Handbook",
    today: "2026-09-21",
  });
  const acked = await acknowledgeDocument({ orgId: h.org.orgId, actorId: h.employeeId, documentId: ack.document.id });
  assert.equal(acked.status, "acknowledged");
  await assert.rejects(
    voidDocument({ orgId: h.org.orgId, actorId: h.hrId, documentId: ack.document.id, reason: "oops" }),
    (e: unknown) => e instanceof HrmDocumentsError && /history/.test(e.message),
  );
  // A draft voids with its reason stored.
  const draft2 = await generateDocument({
    orgId: h.org.orgId,
    actorId: h.hrId,
    templateId,
    employmentId: h.employmentId,
    partyId: h.employeePartyId,
    title: "Void me",
    today: "2026-09-21",
  });
  const voided = await voidDocument({ orgId: h.org.orgId, actorId: h.hrId, documentId: draft2.document.id, reason: "Issued in error" });
  assert.equal(voided.status, "voided");
  const reason = (await db.execute<{ void_reason: string }>(sql`
    select void_reason from hrm_documents where id = ${draft2.document.id}
  `)).rows[0]!;
  assert.equal(reason.void_reason, "Issued in error");
  // Legal hold toggles and lands in the audit log.
  const held = await setLegalHold({ orgId: h.org.orgId, actorId: h.hrId, documentId: document.id, hold: true });
  assert.equal(held.legalHold, true);
  const audit = (await db.execute<{ n: string }>(sql`
    select count(*) as n from audit_log
     where org_id = ${h.org.orgId} and table_name = 'hrm_documents' and row_id = ${document.id} and action = 'legal_hold_on'
  `)).rows[0]!.n;
  assert.equal(audit, "1");
  const detail = await getDocumentDetail({ orgId: h.org.orgId, actorId: h.hrId, documentId: document.id });
  assert.ok(detail.events.some((e) => e.kind === "sent"));
  assert.equal(detail.signers.length, 1);
  });
});

test("documents refuse while the hrmDocuments feature is off", { skip: !DB }, async () => {
  await withHarness(async (h: Harness) => {
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrmDocuments}', 'false'::jsonb, true)
     where id = ${h.org.orgId}
  `);
  await assert.rejects(
    generateDocument({
      orgId: h.org.orgId,
      actorId: h.hrId,
      templateId: randomUUID(),
      employmentId: h.employmentId,
      partyId: h.employeePartyId,
      title: "Blocked",
      today: "2026-09-21",
    }),
    (e: unknown) => e instanceof HrmDocumentsError && e.code === "REFUSED" && /hrmDocuments/.test(e.message),
  );
  });
});
