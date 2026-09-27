import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { seedEmployment, seedPerson } from "../../testing/hrm-harness.ts";
import { NOT_VISIBLE, countRows, refusal, scopeMatrix, scopeRow, type ScopeWorld } from "../../testing/hrm-scope-matrix.ts";
import { UnrestrictedScopeError } from "../../organization/subsidiary-scope.ts";
import { HrmAuthorizationError } from "../authorization.ts";
import { HrmDocumentsError } from "./errors.ts";
import { saveCategory } from "./categories.ts";
import { saveTemplate } from "./templates.ts";
import { listRetentionActions, listSchedules, saveSchedule } from "./retention.ts";
import { buildExport, downloadExport, listExports, requestExport } from "./dsar.ts";
import {
  acknowledgeDocument, generateDocument, getDocumentDetail, listDocuments, readDocumentFile,
  sendDocument, setLegalHold, uploadDocument, voidDocument,
} from "./documents.ts";

/**
 * HR documents under a legal-entity lens. A manager restricted to entity A
 * lists, reads, changes and exports only A's subjects, with B's rows proven
 * untouched in storage; org-wide policy (retention schedules, templates)
 * needs unrestricted scope to write.
 */

const PERMISSIONS = ["hrm.documents.read", "hrm.documents.manage"];
const DOCS = { permissions: PERMISSIONS, subB: { currency: "USD", country: "US" }, features: ["hrmDocuments", "hrmDocumentRetention"] };
const UNRESTRICTED = /requires unrestricted subsidiary access/;
const SCHEDULE = { categoryKey: "contract", retainYears: 7, fromEvent: "completion", action: "anonymize" } as const;
const TODAY = "2026-09-21";

const template = (w: ScopeWorld, actorId: string, name: string, bodyTemplate: string, mergeFields: string[], acknowledgmentOnly = true) =>
  saveTemplate({ orgId: w.orgId, actorId, name, categoryKey: "contract", bodyTemplate, mergeFields, requiresSignature: false, signerRoles: [], acknowledgmentOnly });

const upload = (w: ScopeWorld, extra: { partyId: string; employmentId?: string; categoryKey: string }) => uploadDocument({
  orgId: w.orgId, actorId: w.admin, title: "Filed memo", filename: "memo.pdf", contentType: "application/pdf", bytes: Buffer.from("%PDF-1.4 memo"), ...extra,
});

/** Amy in A, Ben in B, and Dana employed by both, each with a generated acknowledgment document. */
async function seedDocs(w: ScopeWorld) {
  await saveCategory({ orgId: w.orgId, actorId: w.admin, key: "contract", label: "Contracts" });
  const tpl = await template(w, w.admin, `Offer ${randomUUID().slice(0, 8)}`, "Dear {{employee_name}} of {{org_name}}.", ["employee_name", "org_name"]);
  const a = await seedPerson(w.orgId, w.subA, "Amy Alpha");
  const b = await seedPerson(w.orgId, w.subB, "Ben Beta");
  const dualA = await seedPerson(w.orgId, w.subA, "Dana Dual");
  const dualB = await seedEmployment(w.orgId, w.subB, { workerPartyId: dualA.partyId });
  const gen = async (employmentId: string, partyId: string, title: string) =>
    (await generateDocument({ orgId: w.orgId, actorId: w.admin, templateId: tpl.id, employmentId, partyId, title, today: TODAY })).document.id;
  return {
    a, b, templateId: tpl.id, dualParty: dualA.partyId,
    docA: await gen(a.employmentId, a.partyId, "A offer"),
    docB: await gen(b.employmentId, b.partyId, "B offer"),
    docDualA: await gen(dualA.employmentId, dualA.partyId, "Dual A offer"),
    docDualB: await gen(dualB.employmentId, dualA.partyId, "Dual B offer"),
  };
}

async function docRow(w: ScopeWorld, id: string) {
  return (await db.execute<{ status: string; legal_hold: boolean }>(sql`
    select status, legal_hold from hrm_documents where org_id = ${w.orgId} and id = ${id}`)).rows[0]!;
}

const docEvents = (w: ScopeWorld, id: string, kind?: string) =>
  countRows(sql`from hrm_document_events where org_id = ${w.orgId} and document_id = ${id} ${kind ? sql`and kind = ${kind}` : sql``}`);

scopeMatrix([
  scopeRow({
    name: "an entity-restricted manager cannot write org-wide retention policy but still reads it",
    ...DOCS,
    write: async (w) => {
      await saveCategory({ orgId: w.orgId, actorId: w.admin, key: "contract", label: "Contracts" });
      await refusal(saveSchedule({ orgId: w.orgId, actorId: w.scoped, ...SCHEDULE }), UnrestrictedScopeError, UNRESTRICTED);
      assert.equal(await countRows(sql`from hrm_retention_schedules where org_id = ${w.orgId}`), 0, "the refused schedule stored nothing");
      const saved = await saveSchedule({ orgId: w.orgId, actorId: w.admin, ...SCHEDULE });
      assert.equal(saved.categoryKey, "contract");
      assert.ok((await listSchedules({ orgId: w.orgId, actorId: w.scoped })).some((row) => row.id === saved.id), "the read list stays open");
    },
  }),
  scopeRow({
    name: "data-subject exports queue, list and download only for in-scope subjects",
    ...DOCS,
    features: ["hrmDocuments", "hrmDataSubjectExport"],
    seed: async (w) => ({ a: await seedPerson(w.orgId, w.subA, "Amy Alpha"), b: await seedPerson(w.orgId, w.subB, "Ben Beta") }),
    write: async (w, { a, b }) => {
      const orgId = w.orgId;
      const exportStatus = async (id: string) => (await db.execute<{ status: string }>(sql`
        select status from hrm_data_subject_exports where org_id = ${orgId} and id = ${id}`)).rows[0]!.status;
      await refusal(requestExport({ orgId, actorId: w.scoped, partyId: b.partyId }), Error, NOT_VISIBLE);
      assert.equal(await countRows(sql`from hrm_data_subject_exports where org_id = ${orgId} and party_id = ${b.partyId}`), 0, "the refused request queued nothing");
      assert.equal((await requestExport({ orgId, actorId: w.scoped, partyId: a.partyId })).partyId, a.partyId, "the in-scope subject still queues");

      const exportA = await requestExport({ orgId, actorId: w.admin, partyId: a.partyId });
      const exportB = await requestExport({ orgId, actorId: w.admin, partyId: b.partyId });
      const listed = await listExports({ orgId, actorId: w.scoped });
      assert.ok(listed.some((row) => row.id === exportA.id), "an in-scope export another user queued still lists");
      for (const row of listed) assert.equal(row.partyId, a.partyId, "only in-scope subjects' exports list");
      await refusal(listExports({ orgId, actorId: w.scoped, partyId: b.partyId }), Error, NOT_VISIBLE);

      await buildExport(orgId, exportB.id);
      assert.equal(await exportStatus(exportB.id), "ready");
      await refusal(downloadExport({ orgId, actorId: w.scoped, exportId: exportB.id }), Error, NOT_VISIBLE);
      assert.equal(await exportStatus(exportB.id), "ready", "the refused read never marks the export delivered");
    },
  }),
  scopeRow({
    name: "an A-restricted manager lists and reads only in-scope subjects' documents, per employment",
    ...DOCS,
    seed: seedDocs,
    read: async (w, s) => {
      const q = { orgId: w.orgId, actorId: w.scoped };
      assert.deepEqual(new Set((await listDocuments(q)).map((d) => d.id)), new Set([s.docA, s.docDualA]));
      assert.equal((await listDocuments({ ...q, actorId: w.admin })).length, 4);
      await refusal(listDocuments({ ...q, partyId: s.b.partyId }), HrmAuthorizationError, NOT_VISIBLE);
      // Dana's A employment admits her, but her B-employment document stays out of reach.
      for (const documentId of [s.docB, s.docDualB]) {
        await refusal(getDocumentDetail({ ...q, documentId }), Error, NOT_VISIBLE);
        await refusal(readDocumentFile({ ...q, documentId }), Error, NOT_VISIBLE);
      }
      assert.equal((await getDocumentDetail({ ...q, documentId: s.docA })).id, s.docA);
      await db.execute(sql`
        update hrm_documents set sent_at = '2026-09-02T01:30:00Z'::timestamptz, expires_at = '2026-09-30T23:59:59Z'::timestamptz
         where org_id = ${w.orgId} and id = ${s.docDualA}`);
      const detail = await getDocumentDetail({ ...q, documentId: s.docDualA });
      assert.equal(detail.id, s.docDualA, "the A-employment slice of the same person stays readable");
      assert.ok(detail.sentAt instanceof Date && detail.expiresAt instanceof Date, "timestamps stay Date values through the service");
      assert.ok(detail.events.length > 0, "the document has its recorded creation event");
      assert.ok(detail.events.every((event) => event.recordedAt instanceof Date), "event timestamps stay Date values until the viewer formats them");
    },
  }),
  scopeRow({
    name: "an A-restricted manager cannot send, hold, void, generate or template over B's subjects",
    ...DOCS,
    seed: seedDocs,
    write: async (w, s) => {
      const q = { orgId: w.orgId, actorId: w.scoped, documentId: s.docB };
      await refusal(sendDocument(q), Error, NOT_VISIBLE);
      await refusal(setLegalHold({ ...q, hold: true }), Error, NOT_VISIBLE);
      await refusal(voidDocument({ ...q, reason: "cross-entity void attempt" }), Error, NOT_VISIBLE);
      assert.deepEqual(await docRow(w, s.docB), { status: "draft", legal_hold: false }, "B's document is untouched");

      const docsOfB = () => countRows(sql`from hrm_documents where org_id = ${w.orgId} and party_id = ${s.b.partyId}`);
      const before = await docsOfB();
      await refusal(generateDocument({
        orgId: w.orgId, actorId: w.scoped, templateId: s.templateId, employmentId: s.b.employmentId, partyId: s.b.partyId, title: "B offer by restricted manager", today: TODAY,
      }), Error, NOT_VISIBLE);
      assert.equal(await docsOfB(), before, "the refused generation stored nothing");
      await refusal(template(w, w.scoped, "Restricted template", "Hello {{employee_name}}.", ["employee_name"]), UnrestrictedScopeError, UNRESTRICTED);
    },
  }),
  scopeRow({
    name: "retention action lists expose only visible document subjects",
    ...DOCS,
    seed: seedDocs,
    read: async (w, s) => {
      const schedule = await saveSchedule({ orgId: w.orgId, actorId: w.admin, ...SCHEDULE });
      await db.execute(sql`
        insert into hrm_retention_actions (org_id, document_id, schedule_id, due_on, action, blocked_reason, executed_at)
        values (${w.orgId}, ${s.docA}, ${schedule.id}, current_date, 'anonymize', 'A subject reason', null),
               (${w.orgId}, ${s.docB}, ${schedule.id}, current_date, 'anonymize', 'B private reason', null),
               (${w.orgId}, ${s.docB}, ${schedule.id}, current_date, 'anonymize', 'B history reason', now())`);
      for (const pendingOnly of [true, false]) {
        const visible = await listRetentionActions({ orgId: w.orgId, actorId: w.scoped, pendingOnly });
        assert.ok(visible.every((action) => action.documentId !== s.docB && !action.blockedReason?.includes("B private")), `pendingOnly=${pendingOnly}: B never lists`);
        assert.ok(visible.some((action) => action.documentId === s.docA), `pendingOnly=${pendingOnly}: A lists`);
      }
    },
  }),
  scopeRow({
    name: "in-session acknowledgment records exactly one transition and refuses terminal or signature documents",
    ...DOCS,
    seed: seedDocs,
    write: async (w, s) => {
      const setStatus = (id: string, status: string) => db.execute(sql`update hrm_documents set status = ${status} where org_id = ${w.orgId} and id = ${id}`);
      const ack = (documentId: string) => acknowledgeDocument({ orgId: w.orgId, actorId: w.admin, documentId });
      await setStatus(s.docA, "sent");
      const outcomes = await Promise.allSettled([ack(s.docA), ack(s.docA)]);
      assert.deepEqual(outcomes.map((o) => o.status).sort(), ["fulfilled", "rejected"], "concurrent acknowledgments: one wins");
      assert.equal(await docEvents(w, s.docA, "acknowledged"), 1);
      assert.equal((await docRow(w, s.docA)).status, "acknowledged");

      await setStatus(s.docB, "signed");
      const events = await docEvents(w, s.docB);
      await refusal(ack(s.docB), HrmDocumentsError, /only an open acknowledgment document/);
      await setStatus(s.docB, "sent");
      await db.execute(sql`update hrm_document_templates set acknowledgment_only = false where org_id = ${w.orgId} and id = ${s.templateId}`);
      await refusal(ack(s.docB), HrmDocumentsError, /requires a signature/);
      assert.equal(await docEvents(w, s.docB), events, "refused acknowledgments leave no audit event");
      assert.equal((await docRow(w, s.docB)).status, "sent");
    },
  }),
  scopeRow({
    name: "documents file only under a declared category, a matching employment, and the employment a template needs",
    ...DOCS,
    seed: seedDocs,
    write: async (w, s) => {
      const docs = () => countRows(sql`from hrm_documents where org_id = ${w.orgId}`);
      const before = await docs();
      await refusal(upload(w, { partyId: s.a.partyId, categoryKey: "typo-category" }), HrmDocumentsError, /not declared/);
      // Ben's employment named for Amy: the identities disagree.
      const crossLinked = { employmentId: s.b.employmentId, partyId: s.a.partyId };
      await refusal(generateDocument({ orgId: w.orgId, actorId: w.admin, templateId: s.templateId, ...crossLinked, title: "Cross-linked", today: TODAY }), HrmDocumentsError, /does not belong to this document subject/);
      await refusal(upload(w, { ...crossLinked, categoryKey: "contract" }), HrmDocumentsError, /does not belong to this document subject/);
      const needsEmployment = await template(w, w.admin, "Employment details template", "{{department}} / {{position_title}} / {{employment_start}}", ["department", "position_title", "employment_start"], false);
      await refusal(generateDocument({ orgId: w.orgId, actorId: w.admin, templateId: needsEmployment.id, partyId: s.a.partyId, title: "Missing employment", today: TODAY }), HrmDocumentsError, /needs employment details/);
      assert.equal(await docs(), before, "refused filings create no document rows");

      const stored = await upload(w, { partyId: s.a.partyId, categoryKey: "contract" });
      assert.equal(stored.categoryKey, "contract");
      assert.equal((await db.execute<{ category_key: string }>(sql`
        select category_key from hrm_documents where org_id = ${w.orgId} and id = ${stored.id}`)).rows[0]!.category_key, "contract");
    },
  }),
]);
