import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
} from "../../testing/fixtures.ts";
import {
  DB,
  mkSecondSubsidiary,
  scopeRole,
  seedPerson,
  setupHarness,
  withHarness,
} from "../../testing/hrm-harness.ts";
import { HrmAuthorizationError } from "../authorization.ts";
import { UnrestrictedScopeError } from "../../organization/subsidiary-scope.ts";
import { HrmDocumentsError } from "./errors.ts";
import {
  generateDocument,
  getDocumentDetail,
  listDocuments,
  readDocumentFile,
  acknowledgeDocument,
  sendDocument,
  setLegalHold,
  uploadDocument,
  voidDocument,
} from "./documents.ts";
import { saveCategory } from "./categories.ts";
import { saveTemplate } from "./templates.ts";
import { listRetentionActions, saveSchedule } from "./retention.ts";

/**
 * Two-entity document regressions: an HR actor
 * restricted to subsidiary A lists only A's subjects' documents, and
 * reads, downloads, sends, holds, voids, generates and template writes
 * against B's subjects are refused — with B's rows proven untouched in
 * storage. Proofs are read back from storage, never from service returns
 * alone.
 */


const DOC_SUBSIDIARY_FEATURES = ["hrm", "hrmDocuments", "hrmDocumentRetention"] as const;

const DOC_SUBSIDIARY_SPEC = {
  features: DOC_SUBSIDIARY_FEATURES,
  users: [
    { key: "adminId", name: "Ada Admin", handle: "doc_admin", permissions: ["hrm.documents.read", "hrm.documents.manage"] },
    { key: "managerAId", name: "Mara Manager", handle: "doc_manager_a", permissions: ["hrm.documents.read", "hrm.documents.manage"] },
  ],
} as const;

async function setupDocSubsidiaryHarness() {
  return setupHarness(DOC_SUBSIDIARY_SPEC, async (base) => {
    const subB = await mkSecondSubsidiary(base.org.orgId, base.org.subsidiaryId, { currency: "USD", country: "US" });
    const empA = await seedPerson(base.org.orgId, base.org.subsidiaryId, "Amy Alpha");
    const empB = await seedPerson(base.org.orgId, subB, "Ben Beta");
    await scopeRole(base.org.orgId, "doc_admin", ["hrm.documents.read", "hrm.documents.manage"], "all");
    await scopeRole(base.org.orgId, "doc_manager_a", ["hrm.documents.read", "hrm.documents.manage"], [base.org.subsidiaryId]);
    await saveCategory({ orgId: base.org.orgId, actorId: base.adminId, key: "contract", label: "Contracts" });
    const tpl = await saveTemplate({
      orgId: base.org.orgId,
      actorId: base.adminId,
      name: `Offer ${randomUUID().slice(0, 8)}`,
      categoryKey: "contract",
      bodyTemplate: "Dear {{employee_name}} of {{org_name}}.",
      mergeFields: ["employee_name", "org_name"],
      requiresSignature: false,
      signerRoles: [],
      acknowledgmentOnly: true,
    });
    const docA = await generateDocument({
      orgId: base.org.orgId,
      actorId: base.adminId,
      templateId: tpl.id,
      employmentId: empA.employmentId,
      partyId: empA.partyId,
      title: "A offer",
      today: "2026-09-21",
    });
    const docB = await generateDocument({
      orgId: base.org.orgId,
      actorId: base.adminId,
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
      values (${dualPartyId}, ${base.org.orgId}, 'person', 'Dana Dual', 'dana.dual@scratch.test', true, '{}'::jsonb)
    `);
    const dualEmploymentA = randomUUID();
    const dualEmploymentB = randomUUID();
    for (const [employmentId, subsidiaryId] of [
      [dualEmploymentA, base.org.subsidiaryId],
      [dualEmploymentB, subB],
    ] as const) {
      await db.execute(sql`
        insert into worker_employments (id, org_id, worker_party_id, employer_subsidiary_id, revision)
        values (${employmentId}, ${base.org.orgId}, ${dualPartyId}, ${subsidiaryId}, 1)
      `);
      await db.execute(sql`
        insert into worker_employment_versions (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
        values (${base.org.orgId}, ${employmentId}, 1, 'active', '2020-01-01'::date, null, now())
      `);
    }
    const docDualA = await generateDocument({
      orgId: base.org.orgId,
      actorId: base.adminId,
      templateId: tpl.id,
      employmentId: dualEmploymentA,
      partyId: dualPartyId,
      title: "Dual A offer",
      today: "2026-09-21",
    });
    const docDualB = await generateDocument({
      orgId: base.org.orgId,
      actorId: base.adminId,
      templateId: tpl.id,
      employmentId: dualEmploymentB,
      partyId: dualPartyId,
      title: "Dual B offer",
      today: "2026-09-21",
    });
    return {
      subB,
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
  });
}

async function docStatus(orgId: string, docId: string): Promise<string> {
  return (await db.execute<{ status: string }>(sql`
    select status from hrm_documents where org_id = ${orgId} and id = ${docId}
  `)).rows[0]!.status;
}

test("an A-restricted manager lists only in-scope subjects' documents", { skip: !DB }, async () => {
  await withHarness(() => setupDocSubsidiaryHarness(), async (h) => {
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
  await withHarness(() => setupDocSubsidiaryHarness(), async (h) => {
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
    await db.execute(sql`
      update hrm_documents
         set sent_at = '2026-09-02T01:30:00Z'::timestamptz,
             expires_at = '2026-09-30T23:59:59Z'::timestamptz
       where org_id = ${h.org.orgId} and id = ${h.docDualAId}
    `);
    const detail = await getDocumentDetail({ ...q, documentId: h.docDualAId });
    assert.equal(detail.id, h.docDualAId);
    assert.ok(detail.sentAt instanceof Date, "sentAt stays a Date value through the document service");
    assert.ok(detail.expiresAt instanceof Date, "expiresAt stays a Date value through the document service");
    assert.ok(detail.events.length > 0, "the document has its recorded creation event");
    assert.ok(
      detail.events.every((event) => event.recordedAt instanceof Date),
      "event timestamps remain Date values until the viewer formats them",
    );
  });
});

test("an A-restricted manager cannot read, download, send, hold or void B's document", { skip: !DB }, async () => {
  await withHarness(() => setupDocSubsidiaryHarness(), async (h) => {
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

test("retention action pending and history lists expose only visible document subjects", { skip: !DB }, async () => {
  await withHarness(() => setupDocSubsidiaryHarness(), async (h) => {
    const schedule = await saveSchedule({
      orgId: h.org.orgId, actorId: h.adminId, categoryKey: "contract",
      retainYears: 7, fromEvent: "completion", action: "anonymize",
    });
    await db.execute(sql`
      insert into hrm_retention_actions
        (org_id, document_id, schedule_id, due_on, action, blocked_reason, executed_at)
      values
        (${h.org.orgId}, ${h.docAId}, ${schedule.id}, current_date, 'anonymize', 'A subject reason', null),
        (${h.org.orgId}, ${h.docBId}, ${schedule.id}, current_date, 'anonymize', 'B private reason', null),
        (${h.org.orgId}, ${h.docBId}, ${schedule.id}, current_date, 'anonymize', 'B history reason', now())
    `);
    for (const pendingOnly of [true, false]) {
      const visible = await listRetentionActions({
        orgId: h.org.orgId, actorId: h.managerAId, pendingOnly,
      });
      assert.ok(visible.every((action) => action.documentId !== h.docBId));
      assert.equal(visible.some((action) => action.documentId === h.docAId), true);
      assert.ok(visible.every((action) => !action.blockedReason?.includes('B private')));
    }
  });
});

test("in-session acknowledgment refuses signature templates and terminal documents before recording an event", { skip: !DB }, async () => {
  await withHarness(() => setupDocSubsidiaryHarness(), async (h) => {
    await db.execute(sql`
      update hrm_documents set status = 'signed'
       where org_id = ${h.org.orgId} and id = ${h.docAId}
    `);
    const eventsBefore = (await db.execute<{ count: string }>(sql`
      select count(*)::text as count from hrm_document_events
       where org_id = ${h.org.orgId} and document_id = ${h.docAId}
    `)).rows[0]!.count;
    await assert.rejects(
      acknowledgeDocument({ orgId: h.org.orgId, actorId: h.adminId, documentId: h.docAId }),
      (error: unknown) => error instanceof HrmDocumentsError && /only an open acknowledgment document/.test(error.message),
    );
    await db.execute(sql`
      update hrm_documents set status = 'sent'
       where org_id = ${h.org.orgId} and id = ${h.docAId}
    `);
    await db.execute(sql`
      update hrm_document_templates set acknowledgment_only = false
       where org_id = ${h.org.orgId} and id = ${h.templateId}
    `);
    await assert.rejects(
      acknowledgeDocument({ orgId: h.org.orgId, actorId: h.adminId, documentId: h.docAId }),
      (error: unknown) => error instanceof HrmDocumentsError && /requires a signature/.test(error.message),
    );
    const eventsAfter = (await db.execute<{ count: string }>(sql`
      select count(*)::text as count from hrm_document_events
       where org_id = ${h.org.orgId} and document_id = ${h.docAId}
    `)).rows[0]!.count;
    assert.equal(eventsAfter, eventsBefore, "refused acknowledgments leave no audit event");
    assert.equal(await docStatus(h.org.orgId, h.docAId), "sent");
  });
});

test("concurrent in-session acknowledgment records exactly one transition and event", { skip: !DB }, async () => {
  await withHarness(() => setupDocSubsidiaryHarness(), async (h) => {
    await db.execute(sql`
      update hrm_documents set status = 'sent'
       where org_id = ${h.org.orgId} and id = ${h.docAId}
    `);
    const outcomes = await Promise.allSettled([
      acknowledgeDocument({ orgId: h.org.orgId, actorId: h.adminId, documentId: h.docAId }),
      acknowledgeDocument({ orgId: h.org.orgId, actorId: h.adminId, documentId: h.docAId }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
    const acknowledgments = (await db.execute<{ count: string }>(sql`
      select count(*)::text as count from hrm_document_events
       where org_id = ${h.org.orgId} and document_id = ${h.docAId} and kind = 'acknowledged'
    `)).rows[0]!.count;
    assert.equal(acknowledgments, "1");
    assert.equal(await docStatus(h.org.orgId, h.docAId), "acknowledged");
  });
});

test("upload refuses an undeclared category and files a declared one", { skip: !DB }, async () => {
  await withHarness(() => setupDocSubsidiaryHarness(), async (h) => {
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

test("generation and upload reject an employment that belongs to another party", { skip: !DB }, async () => {
  await withHarness(() => setupDocSubsidiaryHarness(), async (h) => {
    const before = (await db.execute<{ count: string }>(sql`
      select count(*)::text as count from hrm_documents where org_id = ${h.org.orgId}
    `)).rows[0]!.count;
    await assert.rejects(
      generateDocument({
        orgId: h.org.orgId, actorId: h.adminId, templateId: h.templateId,
        employmentId: h.employmentB, partyId: h.partyA, title: "Cross-linked generated document", today: "2026-09-21",
      }),
      (error: unknown) => error instanceof HrmDocumentsError && /does not belong to this document subject/.test(error.message),
    );
    await assert.rejects(
      uploadDocument({
        orgId: h.org.orgId, actorId: h.adminId, employmentId: h.employmentB, partyId: h.partyA,
        categoryKey: "contract", title: "Cross-linked uploaded document", filename: "memo.pdf",
        contentType: "application/pdf", bytes: Buffer.from("%PDF-1.4 memo"),
      }),
      (error: unknown) => error instanceof HrmDocumentsError && /does not belong to this document subject/.test(error.message),
    );
    const after = (await db.execute<{ count: string }>(sql`
      select count(*)::text as count from hrm_documents where org_id = ${h.org.orgId}
    `)).rows[0]!.count;
    assert.equal(after, before, "mismatched identities create no document rows");
  });
});

test("employment-linked templates refuse generation without an employment", { skip: !DB }, async () => {
  await withHarness(() => setupDocSubsidiaryHarness(), async (h) => {
    const template = await saveTemplate({
      orgId: h.org.orgId, actorId: h.adminId, name: "Employment details template",
      categoryKey: "contract", bodyTemplate: "{{department}} / {{position_title}} / {{employment_start}}",
      mergeFields: ["department", "position_title", "employment_start"],
      requiresSignature: false, signerRoles: [], acknowledgmentOnly: false,
    });
    const before = (await db.execute<{ count: string }>(sql`
      select count(*)::text as count from hrm_documents where org_id = ${h.org.orgId}
    `)).rows[0]!.count;
    await assert.rejects(
      generateDocument({
        orgId: h.org.orgId, actorId: h.adminId, templateId: template.id,
        partyId: h.partyA, title: "Missing employment", today: "2026-09-21",
      }),
      (error: unknown) => error instanceof HrmDocumentsError && /needs employment details/.test(error.message),
    );
    const after = (await db.execute<{ count: string }>(sql`
      select count(*)::text as count from hrm_documents where org_id = ${h.org.orgId}
    `)).rows[0]!.count;
    assert.equal(after, before);
  });
});

test("an A-restricted manager cannot generate for or template over an out-of-scope subject", { skip: !DB }, async () => {
  await withHarness(() => setupDocSubsidiaryHarness(), async (h) => {
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
