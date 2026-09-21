import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { renderPdfDocument, renderTemplate } from "@openbooks/pdf";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { HRM_FEATURE_KEY } from "../employment-read.ts";
import {
  loadActorPartyId,
  requireHrmDocumentsManage,
  requireHrmDocumentsRead,
} from "../authorization.ts";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { HrmDocumentsError } from "./errors.ts";
import { hashHrmToken, mintDocumentSignerToken, verifyDocumentSignerToken } from "./tokens.ts";
import { appendCabinetVersion, storeCabinetFile } from "./cabinet.ts";
import type { DocumentSignerRole } from "./templates.ts";

/**
 * HR-19 HR documents with e-sign.
 *
 * generate() merges a template through the declared merge fields
 * (resolved ONLY from the employment/person/org read services through
 * the allowlist below — a template key outside the allowlist is refused
 * at save and can never render null), renders the PDF through
 * packages/pdf, and stores it in the person's cabinet folder with grants
 * in the SAME transaction as the document row. upload() files an existing
 * file the same way. send() opens ordered signer rows with consumable
 * HMAC tokens and returns the delivery intents — the API route performs
 * the email/notification delivery web-side (the engine graph cannot reach
 * the inbox or scheduling modules), then the links stay valid until use.
 * view/sign/decline run through the token with no session; the final
 * signature appends the signed PDF (signature certificate page) as a new
 * file version. acknowledge() completes acknowledgment_only documents.
 * void() closes with a stored reason. Legal hold freezes retention.
 */

export const HRM_DOCUMENTS_FEATURE_KEY = "hrmDocuments";

/** Merge keys a template may declare, and where each resolves from. */
export const DOCUMENT_MERGE_FIELDS = [
  "employee_name",
  "employee_email",
  "department",
  "position_title",
  "manager_name",
  "employment_start",
  "org_name",
  "today_date",
] as const;

export type DocumentMergeField = (typeof DOCUMENT_MERGE_FIELDS)[number];

async function assertDocumentsFeature(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new HrmDocumentsError(
      "REFUSED",
      "documents are unavailable while the hrm feature is off — enable it under Company Settings → Features; existing documents are preserved",
    );
  }
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_DOCUMENTS_FEATURE_KEY))) {
    throw new HrmDocumentsError(
      "REFUSED",
      "documents are unavailable while the hrmDocuments feature is off — enable it under Company Settings → Features; existing documents are preserved",
    );
  }
}

export interface DocumentDTO {
  id: string;
  employmentId: string | null;
  partyId: string | null;
  templateId: string | null;
  categoryKey: string;
  title: string;
  fileId: string | null;
  status: string;
  sentAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  retainUntil: string | null;
  legalHold: boolean;
}

type DocumentRow = {
  id: string;
  employment_id: string | null;
  party_id: string | null;
  template_id: string | null;
  category_key: string;
  title: string;
  file_id: string | null;
  status: string;
  sent_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  retain_until: string | null;
  legal_hold: boolean;
};

const DOC_COLS = sql`
  select id, employment_id, party_id, template_id, category_key, title, file_id,
         status, sent_at::text as sent_at, completed_at::text as completed_at,
         expires_at::text as expires_at, retain_until::text as retain_until, legal_hold
    from hrm_documents`;

function toDTO(row: DocumentRow): DocumentDTO {
  return {
    id: row.id,
    employmentId: row.employment_id,
    partyId: row.party_id,
    templateId: row.template_id,
    categoryKey: row.category_key,
    title: row.title,
    fileId: row.file_id,
    status: row.status,
    sentAt: row.sent_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    retainUntil: row.retain_until,
    legalHold: row.legal_hold,
  };
}

export interface SignerDTO {
  id: string;
  ord: number;
  signerPartyId: string;
  role: DocumentSignerRole;
  status: string;
  signedAt: string | null;
  evidence: Record<string, unknown> | null;
  declineReason: string | null;
}

type SignerRow = {
  id: string;
  ord: number;
  signer_party_id: string;
  role: string;
  status: string;
  signed_at: string | null;
  evidence: unknown;
  decline_reason: string | null;
};

function toSignerDTO(row: SignerRow): SignerDTO {
  return {
    id: row.id,
    ord: row.ord,
    signerPartyId: row.signer_party_id,
    role: row.role as DocumentSignerRole,
    status: row.status,
    signedAt: row.signed_at,
    evidence: (row.evidence ?? null) as Record<string, unknown> | null,
    declineReason: row.decline_reason,
  };
}

async function recordEvent(
  exec: SqlExecutor,
  orgId: string,
  documentId: string,
  kind: string,
  actor: string | null,
): Promise<void> {
  const inserted = (await exec.execute<{ id: string }>(sql`
    insert into hrm_document_events (org_id, document_id, kind, actor)
    values (${orgId}, ${documentId}, ${kind}, ${actor})
    returning id
  `)).rows[0];
  if (!inserted) {
    throw new HrmDocumentsError(
      "REFUSED",
      "the document event was not stored — no row was written, so the action is refused rather than unwitnessed",
    );
  }
}

async function loadDocument(
  exec: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<DocumentRow> {
  const row = (await exec.execute<DocumentRow>(sql`
    ${DOC_COLS} where org_id = ${orgId} and id = ${documentId}
  `)).rows[0];
  // Zero rows is a failure: unknown id or another org's document.
  if (!row) {
    throw new HrmDocumentsError("NOT_FOUND", "document is not visible in this organization");
  }
  return row;
}

async function loadSigners(exec: SqlExecutor, orgId: string, documentId: string): Promise<SignerRow[]> {
  return (await exec.execute<SignerRow>(sql`
    select id, ord, signer_party_id, role, status, signed_at::text as signed_at,
           evidence, decline_reason
      from hrm_document_signers
     where org_id = ${orgId} and document_id = ${documentId}
     order by ord
  `)).rows;
}

/** Resolve one party to its display name + email (person read service shape). */
async function loadPerson(
  exec: SqlExecutor,
  orgId: string,
  partyId: string,
): Promise<{ name: string; email: string | null }> {
  const row = (await exec.execute<{ name: string; email: string | null }>(sql`
    select coalesce(display_name, legal_name, 'Unnamed') as name, email
      from parties where org_id = ${orgId} and id = ${partyId}
  `)).rows[0];
  if (!row) {
    throw new HrmDocumentsError(
      "NOT_FOUND",
      "the document subject is not visible in this organization — issue documents only to people of this org",
    );
  }
  return row;
}

/**
 * Resolve the declared merge fields for a subject. Every key comes from a
 * named read below; a key outside DOCUMENT_MERGE_FIELDS can never reach
 * this function (templates.ts refuses it at save).
 */
export async function resolveMergeFields(
  exec: SqlExecutor,
  orgId: string,
  subject: { employmentId: string | null; partyId: string | null },
  today: string,
): Promise<{ [K in DocumentMergeField]: string }> {
  if (!subject.partyId) {
    throw new HrmDocumentsError(
      "REFUSED",
      "merge fields need a document subject — this document was anonymized by retention",
    );
  }
  const person = await loadPerson(exec, orgId, subject.partyId);
  const org = (await exec.execute<{ name: string }>(sql`
    select name from orgs where id = ${orgId}
  `)).rows[0];
  const values: { [K in DocumentMergeField]: string } = {
    employee_name: person.name,
    employee_email: person.email ?? "",
    department: "",
    position_title: "",
    manager_name: "",
    employment_start: "",
    org_name: org?.name ?? "",
    today_date: today,
  };
  if (subject.employmentId) {
    // Title and department live on the primary assignment version live
    // today (0184); the start date is the earliest live employment
    // version's effective_from.
    const emp = (await exec.execute<{
      department: string | null;
      title: string | null;
      start: string | null;
    }>(sql`
      select d.name as department, a.job_title as title,
             (select min(v.effective_from)::text
                from worker_employment_versions v
               where v.org_id = ${orgId} and v.employment_id = ${subject.employmentId}
                 and v.recorded_until is null) as start
        from employment_assignment_versions a
        left join departments d
          on d.org_id = a.org_id and d.id = a.department_id
       where a.org_id = ${orgId} and a.employment_id = ${subject.employmentId}
         and a.is_primary and a.recorded_until is null
         and a.effective_from <= current_date
         and (a.effective_to is null or a.effective_to > current_date)
       order by a.effective_from desc
       limit 1
    `)).rows[0];
    if (emp) {
      values.department = emp.department ?? "";
      values.position_title = emp.title ?? "";
      values.employment_start = emp.start ?? "";
    }
    const mgr = (await exec.execute<{ name: string }>(sql`
      select coalesce(p.display_name, p.legal_name, 'Unnamed') as name
        from reporting_relationships r
        join worker_employments m on m.org_id = r.org_id and m.id = r.manager_employment_id
        join parties p on p.org_id = r.org_id and p.id = m.worker_party_id
       where r.org_id = ${orgId} and r.employment_id = ${subject.employmentId}
         and r.kind = 'line' and r.recorded_until is null
         and (r.effective_to is null or r.effective_to > current_date)
       order by r.effective_from desc
       limit 1
    `)).rows[0];
    if (mgr) values.manager_name = mgr.name;
  }
  return values;
}

/** User login + email behind a party, for grants and delivery. */
async function loadPartyUser(
  exec: SqlExecutor,
  orgId: string,
  partyId: string,
): Promise<{ id: string; email: string } | null> {
  const row = (await exec.execute<{ id: string; email: string }>(sql`
    select id, email from users where org_id = ${orgId} and party_id = ${partyId} limit 1
  `)).rows[0];
  return row ?? null;
}

export interface DeliveryIntent {
  signerId: string;
  partyId: string;
  email: string | null;
  userId: string | null;
  token: string;
}

const SIGNER_TOKEN_TTL_MS = 30 * 24 * 3_600_000; // 30 days

export async function generateDocument(input: {
  orgId: string;
  actorId: string;
  templateId: string;
  employmentId?: string | null;
  partyId: string;
  title: string;
  expiresAt?: string | null;
  today: string;
  orgName?: string;
}): Promise<{ document: DocumentDTO; mergePreview: { [K in DocumentMergeField]: string } }> {
  const title = input.title.trim();
  if (!title) throw new HrmDocumentsError("VALIDATION", "document title is required");
  return withOrgTransaction(input.orgId, async () => {
    await requireHrmDocumentsManage(db, input.orgId, input.actorId);
    await assertDocumentsFeature(db, input.orgId);
    const tpl = (await db.execute<{
      id: string;
      category_key: string;
      body_template: string;
      merge_fields: unknown;
      requires_signature: boolean;
      signer_roles: unknown;
      acknowledgment_only: boolean;
      is_active: boolean;
    }>(sql`
      select id, category_key, body_template, merge_fields, requires_signature,
             signer_roles, acknowledgment_only, is_active
        from hrm_document_templates
       where org_id = ${input.orgId} and id = ${input.templateId}
    `)).rows[0];
    if (!tpl || !tpl.is_active) {
      throw new HrmDocumentsError(
        "NOT_FOUND",
        "template is not available in this organization — activate it under Setup before generating",
      );
    }
    const declared = Array.isArray(tpl.merge_fields)
      ? tpl.merge_fields.filter((f): f is string => typeof f === "string")
      : [];
    for (const key of declared) {
      if (!(DOCUMENT_MERGE_FIELDS as readonly string[]).includes(key)) {
        throw new HrmDocumentsError(
          "REFUSED",
          `template declares merge field ${JSON.stringify(key)} outside the resolvable allowlist — edit the template to use only ${DOCUMENT_MERGE_FIELDS.join(", ")}`,
        );
      }
    }
    if (input.employmentId) {
      const emp = (await db.execute<{ id: string }>(sql`
        select id from worker_employments where org_id = ${input.orgId} and id = ${input.employmentId}
      `)).rows[0];
      if (!emp) {
        throw new HrmDocumentsError(
          "NOT_FOUND",
          "employment is not visible in this organization and legal-entity scope",
        );
      }
    }
    const values = await resolveMergeFields(
      db,
      input.orgId,
      { employmentId: input.employmentId ?? null, partyId: input.partyId },
      input.today,
    );
    const merged = renderTemplate(tpl.body_template, values, { escapeHtml: false });
    const pdf = await renderPdfDocument({
      title,
      branding: { orgName: input.orgName ?? values.org_name },
      dateRangeLabel: input.today,
      generatedAt: new Date(),
      layout: { paperSize: "a4", orientation: "portrait", marginMm: 15, density: "standard" },
      summary: [{ label: "Subject", value: values.employee_name }],
      groups: [{ kind: "section", title: "Document", columns: [], rows: [[merged]] }],
    });
    const docId = (await db.execute<{ id: string }>(sql`
      insert into hrm_documents
        (org_id, employment_id, party_id, template_id, category_key, title,
         expires_at, created_by, updated_by)
      values (${input.orgId}, ${input.employmentId ?? null}, ${input.partyId},
              ${input.templateId}, ${tpl.category_key}, ${title},
              ${input.expiresAt ?? null}, ${input.actorId}, ${input.actorId})
      returning id
    `)).rows[0]!.id;
    const grants: string[] = [];
    const subjectUser = await loadPartyUser(db, input.orgId, input.partyId);
    if (subjectUser) grants.push(subjectUser.id);
    grants.push(input.actorId);
    const { fileId } = await storeCabinetFile(db, {
      orgId: input.orgId,
      recordTable: "hrm_documents",
      recordId: docId,
      groupLabel: "HR Documents",
      filename: `${title.replace(/[^\w\- ]+/g, "").trim().slice(0, 80) || "document"}.pdf`,
      contentType: "application/pdf",
      bytes: pdf,
      createdBy: input.actorId,
      viewerUserIds: grants,
    });
    const updated = (await db.execute<DocumentRow>(sql`
      update hrm_documents set file_id = ${fileId}, updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${docId}
      returning id, employment_id, party_id, template_id, category_key, title, file_id,
                status, sent_at::text as sent_at, completed_at::text as completed_at,
                expires_at::text as expires_at, retain_until::text as retain_until, legal_hold
    `)).rows[0]!;
    await recordEvent(db, input.orgId, docId, "created", input.actorId);
    return { document: toDTO(updated), mergePreview: values };
  });
}

/** File an existing file as the document's current version (upload path). */
export async function uploadDocument(input: {
  orgId: string;
  actorId: string;
  employmentId?: string | null;
  partyId: string;
  categoryKey: string;
  title: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
  expiresAt?: string | null;
}): Promise<DocumentDTO> {
  const title = input.title.trim();
  if (!title) throw new HrmDocumentsError("VALIDATION", "document title is required");
  const categoryKey = input.categoryKey.trim();
  if (!categoryKey) {
    throw new HrmDocumentsError(
      "VALIDATION",
      "category is required — declare document categories under Setup → Workforce → Document Categories first",
    );
  }
  if (input.bytes.length === 0) {
    throw new HrmDocumentsError("VALIDATION", "the uploaded file is empty — attach a file with content");
  }
  return withOrgTransaction(input.orgId, async () => {
    await requireHrmDocumentsManage(db, input.orgId, input.actorId);
    await assertDocumentsFeature(db, input.orgId);
    await loadPerson(db, input.orgId, input.partyId);
    const docId = (await db.execute<{ id: string }>(sql`
      insert into hrm_documents
        (org_id, employment_id, party_id, template_id, category_key, title,
         expires_at, created_by, updated_by)
      values (${input.orgId}, ${input.employmentId ?? null}, ${input.partyId},
              null, ${categoryKey}, ${title}, ${input.expiresAt ?? null},
              ${input.actorId}, ${input.actorId})
      returning id
    `)).rows[0]!.id;
    const grants: string[] = [input.actorId];
    const subjectUser = await loadPartyUser(db, input.orgId, input.partyId);
    if (subjectUser) grants.push(subjectUser.id);
    const { fileId } = await storeCabinetFile(db, {
      orgId: input.orgId,
      recordTable: "hrm_documents",
      recordId: docId,
      groupLabel: "HR Documents",
      filename: input.filename,
      contentType: input.contentType,
      bytes: input.bytes,
      createdBy: input.actorId,
      viewerUserIds: grants,
    });
    const updated = (await db.execute<DocumentRow>(sql`
      update hrm_documents set file_id = ${fileId}, updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${docId}
      returning id, employment_id, party_id, template_id, category_key, title, file_id,
                status, sent_at::text as sent_at, completed_at::text as completed_at,
                expires_at::text as expires_at, retain_until::text as retain_until, legal_hold
    `)).rows[0]!;
    await recordEvent(db, input.orgId, docId, "created", input.actorId);
    return toDTO(updated);
  });
}

export interface DocumentDetail extends DocumentDTO {
  signers: SignerDTO[];
  events: { kind: string; actor: string | null; recordedAt: string }[];
}

/** Resolve the signer parties for signer roles: employee = the subject,
 * manager = their line manager as of today, hr = the acting HR user. */
async function resolveRoleParty(
  exec: SqlExecutor,
  orgId: string,
  role: DocumentSignerRole,
  subject: { employmentId: string | null; partyId: string | null },
  actorId: string,
): Promise<string> {
  if (role === "employee") {
    if (!subject.partyId) {
      throw new HrmDocumentsError(
        "REFUSED",
        "this document was anonymized by retention — its subject link is gone, so no new signature can open",
      );
    }
    return subject.partyId;
  }
  if (role === "hr") {
    const hrParty = await loadActorPartyId(exec, orgId, actorId);
    if (!hrParty) {
      throw new HrmDocumentsError(
        "REFUSED",
        "the hr signer role needs the acting HR user to resolve to a person — sign in with a login linked to a person record",
      );
    }
    return hrParty;
  }
  if (!subject.employmentId) {
    throw new HrmDocumentsError(
      "REFUSED",
      "the manager signer role needs an employment context — generate the document for an employment, or drop the manager role from the template",
    );
  }
  const mgr = (await exec.execute<{ partyId: string }>(sql`
    select m.worker_party_id as "partyId"
      from reporting_relationships r
      join worker_employments m on m.org_id = r.org_id and m.id = r.manager_employment_id
     where r.org_id = ${orgId} and r.employment_id = ${subject.employmentId}
       and r.kind = 'line' and r.recorded_until is null
       and r.effective_from <= current_date
       and (r.effective_to is null or r.effective_to > current_date)
     order by r.effective_from desc
     limit 1
  `)).rows[0];
  if (!mgr) {
    throw new HrmDocumentsError(
      "REFUSED",
      "the manager signer role has no line manager as of today — assign a manager before sending, or drop the manager role from the template",
    );
  }
  return mgr.partyId;
}

/**
 * Send a draft document: open ordered signer rows with consumable tokens.
 * Returns delivery intents (signer, email, token) — the API route performs
 * the email/notification delivery web-side and the links stay valid until
 * used, voided, or expired.
 */
export async function sendDocument(input: {
  orgId: string;
  actorId: string;
  documentId: string;
}): Promise<{ document: DocumentDTO; deliveries: DeliveryIntent[] }> {
  return withOrgTransaction(input.orgId, async () => {
    await requireHrmDocumentsManage(db, input.orgId, input.actorId);
    await assertDocumentsFeature(db, input.orgId);
    const doc = await loadDocument(db, input.orgId, input.documentId);
    if (doc.status !== "draft") {
      throw new HrmDocumentsError(
        "REFUSED",
        `only draft documents send — this one is ${doc.status}, so re-issue it instead of re-sending`,
      );
    }
    const tplRoles: DocumentSignerRole[] = doc.template_id
      ? (((await db.execute<{ roles: unknown }>(sql`
          select signer_roles as roles from hrm_document_templates
           where org_id = ${input.orgId} and id = ${doc.template_id}
        `)).rows[0]?.roles ?? []) as DocumentSignerRole[])
      : [];
    const tpl = doc.template_id
      ? (await db.execute<{
          requires_signature: boolean;
          acknowledgment_only: boolean;
          is_active: boolean;
        }>(sql`
          select requires_signature, acknowledgment_only, is_active from hrm_document_templates
           where org_id = ${input.orgId} and id = ${doc.template_id}
        `)).rows[0]
      : null;
    if (tpl && !tpl.is_active) {
      throw new HrmDocumentsError("REFUSED", "the template is inactive — activate it before sending");
    }
    // Uploaded documents without a template default to a single employee
    // signature: an HR file nobody is asked to sign is indistinguishable
    // from one nobody saw.
    const roles = tpl ? (tpl.requires_signature ? tplRoles : []) : (["employee"] as DocumentSignerRole[]);
    const existing = await loadSigners(db, input.orgId, doc.id);
    if (existing.length > 0) {
      throw new HrmDocumentsError(
        "REFUSED",
        "signers are already open on this document — void it and re-issue instead of double-sending",
      );
    }
    const deliveries: DeliveryIntent[] = [];
    const expiresAt = new Date(Date.now() + SIGNER_TOKEN_TTL_MS);
    let ord = 0;
    for (const role of roles) {
      const partyId = await resolveRoleParty(
        db,
        input.orgId,
        role,
        { employmentId: doc.employment_id, partyId: doc.party_id },
        input.actorId,
      );
      const token = mintDocumentSignerToken(input.orgId, `${doc.id}:${ord}`, expiresAt);
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into hrm_document_signers
          (org_id, document_id, ord, signer_party_id, role, token_hash, created_by, updated_by)
        values (${input.orgId}, ${doc.id}, ${ord}, ${partyId}, ${role},
                ${hashHrmToken(token)}, ${input.actorId}, ${input.actorId})
        returning id
      `)).rows[0]!;
      const user = await loadPartyUser(db, input.orgId, partyId);
      const person = await loadPerson(db, input.orgId, partyId);
      deliveries.push({
        signerId: inserted.id,
        partyId,
        email: user?.email ?? person.email,
        userId: user?.id ?? null,
        token,
      });
      ord += 1;
    }
    const updated = (await db.execute<DocumentRow>(sql`
      update hrm_documents
         set status = 'sent', sent_at = now(), updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${doc.id}
      returning id, employment_id, party_id, template_id, category_key, title, file_id,
                status, sent_at::text as sent_at, completed_at::text as completed_at,
                expires_at::text as expires_at, retain_until::text as retain_until, legal_hold
    `)).rows[0]!;
    await recordEvent(db, input.orgId, doc.id, "sent", input.actorId);
    return { document: toDTO(updated), deliveries };
  });
}

/**
 * Manually nudge a sent document's open signers: re-mint each open
 * signer's token (the old link dies — a reminded signer who opens the
 * stale link meets the no-longer-available refusal and the fresh link
 * in their inbox), record the reminded events, and return the fresh
 * delivery intents. Refuses drafts (send them), terminal documents, and
 * documents with nobody left to nudge. One transaction per action.
 */
export async function remindDocument(input: {
  orgId: string;
  actorId: string;
  documentId: string;
}): Promise<{ document: DocumentDTO; deliveries: DeliveryIntent[] }> {
  return withOrgTransaction(input.orgId, async () => {
    await requireHrmDocumentsManage(db, input.orgId, input.actorId);
    await assertDocumentsFeature(db, input.orgId);
    const doc = await loadDocument(db, input.orgId, input.documentId);
    if (doc.status === "draft") {
      throw new HrmDocumentsError(
        "REFUSED",
        "this document never sent — send it instead of reminding signers who were never asked",
      );
    }
    if (!["sent", "viewed", "partially_signed"].includes(doc.status)) {
      throw new HrmDocumentsError(
        "REFUSED",
        `only open documents remind — this one is ${doc.status}, so re-issue it instead`,
      );
    }
    const open = (await loadSigners(db, input.orgId, doc.id)).filter((s) =>
      ["pending", "viewed"].includes(s.status),
    );
    if (open.length === 0) {
      throw new HrmDocumentsError(
        "REFUSED",
        "nobody is left to nudge — every signer answered or the document completed",
      );
    }
    const expiresAt = new Date(Date.now() + SIGNER_TOKEN_TTL_MS);
    const deliveries: DeliveryIntent[] = [];
    for (const signer of open) {
      const token = mintDocumentSignerToken(input.orgId, `${doc.id}:${signer.ord}`, expiresAt);
      const updated = (await db.execute<{ id: string }>(sql`
        update hrm_document_signers
           set token_hash = ${hashHrmToken(token)}, updated_at = now(), updated_by = ${input.actorId}
         where org_id = ${input.orgId} and id = ${signer.id}
        returning id
      `)).rows[0];
      // Zero matched rows is a failure: the signer answered mid-remind.
      if (!updated) continue;
      const user = await loadPartyUser(db, input.orgId, signer.signer_party_id);
      const person = await loadPerson(db, input.orgId, signer.signer_party_id);
      deliveries.push({
        signerId: signer.id,
        partyId: signer.signer_party_id,
        email: user?.email ?? person.email,
        userId: user?.id ?? null,
        token,
      });
      await recordDocumentReminded(db, input.orgId, signer.id);
    }
    if (deliveries.length === 0) {
      throw new HrmDocumentsError(
        "REFUSED",
        "every open signer answered while the reminder was sending — nothing was re-delivered",
      );
    }
    return { document: toDTO(doc), deliveries };
  });
}

async function assertTokenSigner(
  exec: SqlExecutor,
  token: string,
): Promise<{ orgId: string; doc: DocumentRow; signer: SignerRow; signers: SignerRow[] }> {
  const claims = verifyDocumentSignerToken(token);
  if (!claims) {
    throw new HrmDocumentsError("FORBIDDEN", "this signing link is invalid or expired — ask HR to re-send the document");
  }
  const signer = (await exec.execute<SignerRow>(sql`
    select s.id, s.ord, s.signer_party_id, s.role, s.status,
           s.signed_at::text as signed_at, s.evidence, s.decline_reason,
           s.document_id as document_id
      from hrm_document_signers s
     where s.token_hash = ${hashHrmToken(token)}
  `)).rows[0] as (SignerRow & { document_id: string }) | undefined;
  // No row for a valid HMAC is a failure: revoked, voided, or foreign.
  if (!signer) {
    throw new HrmDocumentsError(
      "FORBIDDEN",
      "this signing link is no longer available — the document may have been voided; ask HR to re-send it",
    );
  }
  if (signer.document_id !== claims.rowId.split(":")[0]) {
    throw new HrmDocumentsError("FORBIDDEN", "this signing link does not match its signer — ask HR to re-send the document");
  }
  const doc = await loadDocument(exec, claims.orgId, signer.document_id);
  if (doc.status === "voided" || doc.status === "expired" || doc.status === "deleted") {
    throw new HrmDocumentsError(
      "REFUSED",
      `this document is ${doc.status} and no longer takes signatures — ask HR to re-issue it`,
    );
  }
  if (doc.expires_at && new Date(doc.expires_at).getTime() < Date.now()) {
    throw new HrmDocumentsError(
      "REFUSED",
      "this signing link has passed the document expiry — ask HR to re-issue it",
    );
  }
  const signers = await loadSigners(exec, claims.orgId, doc.id);
  return { orgId: claims.orgId, doc, signer, signers };
}

function shaHex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function currentFileBytes(
  exec: SqlExecutor,
  orgId: string,
  fileId: string,
): Promise<{ bytes: Buffer; hash: string }> {
  const row = (await exec.execute<{ bytes: Buffer }>(sql`
    select b.bytes
      from files f
      join file_versions v on v.id = f.current_version_id
      join file_blobs b on b.version_id = v.id
     where f.id = ${fileId} and f.org_id = ${orgId}
  `)).rows[0];
  if (!row) {
    throw new HrmDocumentsError(
      "NOT_FOUND",
      "the document file is missing from the cabinet — regenerate the document instead of signing a ghost",
    );
  }
  const bytes: Buffer = row.bytes;
  return { bytes, hash: shaHex(bytes) };
}

/**
 * Read a document's current file through the token (no session). The
 * return names the viewer's own signer row (viewerSignerId) and whether
 * the document acknowledges rather than signs — signer party ids and
 * evidence never leave this return unmapped: public surfaces project
 * the timeline to ord/role/status/signedAt only.
 */
export async function readTokenDocument(
  token: string,
): Promise<{
  document: DocumentDTO;
  signers: SignerDTO[];
  viewerSignerId: string;
  acknowledgmentOnly: boolean;
  bytes: Buffer;
  contentType: string;
}> {
  const claims = verifyDocumentSignerToken(token);
  if (!claims) {
    throw new HrmDocumentsError("FORBIDDEN", "this signing link is invalid or expired — ask HR to re-send the document");
  }
  return withOrgTransaction(claims.orgId, async () => {
    const { doc, signer, signers } = await assertTokenSigner(db, token);
    if (signer.status === "pending") {
      const touched = (await db.execute<{ n: string }>(sql`
        update hrm_document_signers
           set status = 'viewed', updated_at = now()
         where org_id = ${claims.orgId} and id = ${signer.id} and status = 'pending'
        returning 1
      `)).rows.length;
      if (touched === 1) {
        await recordEvent(db, claims.orgId, doc.id, "viewed", null);
        if (doc.status === "sent") {
          await db.execute(sql`
            update hrm_documents set status = 'viewed', updated_at = now()
             where org_id = ${claims.orgId} and id = ${doc.id} and status = 'sent'
          `);
          doc.status = "viewed";
        }
      }
      signer.status = "viewed";
    }
    if (!doc.file_id) {
      throw new HrmDocumentsError("NOT_FOUND", "this document has no rendered file yet — ask HR to generate it");
    }
    const { bytes } = await currentFileBytes(db, claims.orgId, doc.file_id);
    const acknowledgmentOnly = doc.template_id
      ? ((await db.execute<{ acknowledgment_only: boolean }>(sql`
          select acknowledgment_only from hrm_document_templates
           where org_id = ${claims.orgId} and id = ${doc.template_id}
        `)).rows[0]?.acknowledgment_only ?? false)
      : false;
    return {
      document: toDTO(doc),
      signers: signers.map((s) => (s.id === signer.id ? { ...toSignerDTO(s), status: signer.status } : toSignerDTO(s))),
      viewerSignerId: signer.id,
      acknowledgmentOnly,
      bytes,
      contentType: "application/pdf",
    };
  });
}

/**
 * The shared signing core: order check, evidence stamp, partial/final
 * completion with the certificate page and the stored retention clock.
 * Both the token path and the own-session path run it inside their own
 * transaction and advisory lock — the stamp's conditional UPDATE is
 * what makes a raced second signature a refusal, never a double event.
 */
async function applySignature(
  exec: SqlExecutor,
  orgId: string,
  doc: DocumentRow,
  signer: SignerRow,
  signers: SignerRow[],
  name: string,
  ip: string | null,
  userAgent: string | null,
): Promise<DocumentDTO> {
    const earlierPending = signers.filter((s) => s.ord < signer.ord && s.status !== "signed");
    if (earlierPending.length > 0) {
      throw new HrmDocumentsError(
        "REFUSED",
        `signatures run in order — the ${earlierPending[0]!.role} signs before you; it activates when they have signed`,
      );
    }
    if (!doc.file_id) {
      throw new HrmDocumentsError("NOT_FOUND", "this document has no rendered file yet — ask HR to generate it");
    }
    const { bytes, hash } = await currentFileBytes(exec, orgId, doc.file_id);
    const evidence = {
      name,
      timestamp: new Date().toISOString(),
      ipHash: ip ? shaHex(ip) : null,
      userAgentHash: userAgent ? shaHex(userAgent) : null,
      documentHash: hash,
    };
    const stamped = (await exec.execute<{ n: string }>(sql`
      update hrm_document_signers
         set status = 'signed', signed_at = now(), evidence = ${JSON.stringify(evidence)}::jsonb,
             updated_at = now()
       where org_id = ${orgId} and id = ${signer.id} and status in ('pending', 'viewed')
      returning 1
    `)).rows.length;
    // Zero matched rows is a replay: someone consumed this link first.
    if (stamped === 0) {
      throw new HrmDocumentsError("REFUSED", "this link was just used — a signature is recorded once and never replayed");
    }
    await recordEvent(exec, orgId, doc.id, "signed", null);
    const remaining = signers.filter((s) => s.id !== signer.id && s.status !== "signed");
    if (remaining.length > 0) {
      await exec.execute(sql`
        update hrm_documents set status = 'partially_signed', updated_at = now()
         where org_id = ${orgId} and id = ${doc.id} and status in ('sent', 'viewed')
      `);
      return toDTO({ ...doc, status: "partially_signed" });
    }
    // Final signature: append the certificate page, complete, retain.
    const signedPdf = await appendSignaturePage(bytes, {
      title: doc.title,
      signatures: [...signers.filter((s) => s.id !== signer.id), { ...signer, status: "signed" }].map((s) => ({
        role: s.role,
        evidence: s.id === signer.id ? evidence : ((s.evidence ?? {}) as Record<string, unknown>),
      })),
    });
    await appendCabinetVersion(exec, orgId, doc.file_id, "application/pdf", signedPdf, null);
    const completed = (await exec.execute<DocumentRow>(sql`
      update hrm_documents
         set status = 'signed', completed_at = now(), updated_at = now()
       where org_id = ${orgId} and id = ${doc.id}
      returning id, employment_id, party_id, template_id, category_key, title, file_id,
                status, sent_at::text as sent_at, completed_at::text as completed_at,
                expires_at::text as expires_at, retain_until::text as retain_until, legal_hold
    `)).rows[0]!;
    const { applyCompletionRetention } = await import("./retention.ts");
    await applyCompletionRetention(exec, orgId, completed.id, null);
    return toDTO((await loadDocument(exec, orgId, completed.id)));
}

/**
 * Sign through the token. Signers act strictly in order: a signer whose
 * earlier signer is still pending is refused by name. The final signature
 * appends the signature certificate page to the PDF as a new file
 * version, completes the document, and stores retain_until.
 */
export async function signTokenDocument(input: {
  token: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<DocumentDTO> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new HrmDocumentsError("VALIDATION", "your name is required to sign");
  const claims = verifyDocumentSignerToken(input.token);
  if (!claims) {
    throw new HrmDocumentsError("FORBIDDEN", "this signing link is invalid or expired — ask HR to re-send the document");
  }
  return withOrgTransaction(claims.orgId, async () => {
    await db.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${"hrm-doc-sign:" + claims.orgId + ":" + claims.rowId}, 0))
    `);
    const { orgId, doc, signer, signers } = await assertTokenSigner(db, input.token);
    if (signer.status === "signed") {
      throw new HrmDocumentsError("REFUSED", "this link already signed — a signature is recorded once and never replayed");
    }
    if (signer.status === "declined") {
      throw new HrmDocumentsError("REFUSED", "this link recorded a decline — ask HR to re-issue the document to sign");
    }
    return applySignature(db, orgId, doc, signer, signers, name, input.ip ?? null, input.userAgent ?? null);
  });
}

/**
 * Sign in-session: the actor's own open signer row on their own
 * document. Resolves the actor to their party, refuses when they hold
 * no open signer row here (HR staff sign through the token link like
 * everyone else — this path never signs for another person), then
 * runs the shared core. Powers /me/documents inline signing: the
 * signing view is the public page rendered in-session.
 */
export async function signOwnDocument(input: {
  orgId: string;
  actorId: string;
  documentId: string;
  name: string;
}): Promise<DocumentDTO> {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new HrmDocumentsError("VALIDATION", "your name is required to sign");
  return withOrgTransaction(input.orgId, async () => {
    await db.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${"hrm-doc-sign:" + input.orgId + ":" + input.documentId}, 0))
    `);
    const doc = await loadDocument(db, input.orgId, input.documentId);
    const ownParty = await loadActorPartyId(db, input.orgId, input.actorId);
    if (!ownParty) {
      throw new HrmDocumentsError(
        "REFUSED",
        "your login is not linked to a person record — ask HR to link it before signing",
      );
    }
    const signers = await loadSigners(db, input.orgId, doc.id);
    const signer = signers.find((s) => s.signer_party_id === ownParty && ["pending", "viewed"].includes(s.status));
    if (!signer) {
      throw new HrmDocumentsError(
        "REFUSED",
        "you hold no open signature on this document — it may already be answered, or addressed to someone else",
      );
    }
    return applySignature(db, input.orgId, doc, signer, signers, name, null, null);
  });
}

/** Append a signature certificate page to the rendered PDF (pdf-lib). */
export async function appendSignaturePage(
  pdf: Buffer,
  input: {
    title: string;
    signatures: { role: string; evidence: Record<string, unknown> }[];
  },
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.load(pdf);
  const page = pdfDoc.addPage([595, 842]);
  const font = await pdfDoc.embedFont("Helvetica");
  const bold = await pdfDoc.embedFont("Helvetica-Bold");
  let y = 800;
  page.drawText("Signature certificate", { x: 50, y, size: 18, font: bold });
  y -= 24;
  page.drawText(input.title.slice(0, 90), { x: 50, y, size: 11, font });
  y -= 28;
  for (const sig of input.signatures) {
    const ev = sig.evidence;
    page.drawText(`${sig.role}: ${String(ev.name ?? "—")}`, { x: 50, y, size: 11, font: bold });
    y -= 16;
    page.drawText(`signed ${String(ev.timestamp ?? "—")}`, { x: 70, y, size: 9, font });
    y -= 14;
    page.drawText(`document sha256: ${String(ev.documentHash ?? "—").slice(0, 48)}`, {
      x: 70,
      y,
      size: 9,
      font,
    });
    y -= 22;
  }
  return Buffer.from(await pdfDoc.save());
}

/** Decline through the token with a reason. */
export async function declineTokenDocument(input: {
  token: string;
  reason: string;
}): Promise<DocumentDTO> {
  const reason = input.reason.trim().slice(0, 500);
  if (!reason) {
    throw new HrmDocumentsError("VALIDATION", "a decline reason is required — HR reads it to re-issue correctly");
  }
  const claims = verifyDocumentSignerToken(input.token);
  if (!claims) {
    throw new HrmDocumentsError("FORBIDDEN", "this signing link is invalid or expired — ask HR to re-send the document");
  }
  return withOrgTransaction(claims.orgId, async () => {
    const { orgId, doc, signer } = await assertTokenSigner(db, input.token);
    if (signer.status === "signed" || signer.status === "declined") {
      throw new HrmDocumentsError("REFUSED", "this link already answered — a decline is recorded once and never replayed");
    }
    const stamped = (await db.execute<{ n: string }>(sql`
      update hrm_document_signers
         set status = 'declined', decline_reason = ${reason}, updated_at = now()
       where org_id = ${orgId} and id = ${signer.id} and status in ('pending', 'viewed')
      returning 1
    `)).rows.length;
    if (stamped === 0) {
      throw new HrmDocumentsError("REFUSED", "this link was just used — an answer is recorded once and never replayed");
    }
    await recordEvent(db, orgId, doc.id, "declined", null);
    const updated = (await db.execute<DocumentRow>(sql`
      update hrm_documents set status = 'declined', updated_at = now()
       where org_id = ${orgId} and id = ${doc.id}
      returning id, employment_id, party_id, template_id, category_key, title, file_id,
                status, sent_at::text as sent_at, completed_at::text as completed_at,
                expires_at::text as expires_at, retain_until::text as retain_until, legal_hold
    `)).rows[0]!;
    return toDTO(updated);
  });
}

/**
 * Acknowledge an acknowledgment_only document — own session or token.
 * The token path reuses the employee signer row when the template opens
 * one; otherwise the subject acknowledges directly.
 */
export async function acknowledgeDocument(input: {
  orgId?: string;
  actorId?: string | null;
  token?: string;
  documentId?: string;
}): Promise<DocumentDTO> {
  if (input.token) {
    const claims = verifyDocumentSignerToken(input.token);
    if (!claims) {
      throw new HrmDocumentsError("FORBIDDEN", "this link is invalid or expired — ask HR to re-send the document");
    }
    return withOrgTransaction(claims.orgId, async () => {
      const { orgId, doc, signer } = await assertTokenSigner(db, input.token!);
      const tpl = doc.template_id
        ? (await db.execute<{ acknowledgment_only: boolean }>(sql`
            select acknowledgment_only from hrm_document_templates
             where org_id = ${orgId} and id = ${doc.template_id}
          `)).rows[0]
        : null;
      if (tpl && !tpl.acknowledgment_only) {
        throw new HrmDocumentsError(
          "REFUSED",
          "this document takes signatures, not acknowledgments — sign it through your link instead",
        );
      }
      if (signer.status === "signed") {
        throw new HrmDocumentsError("REFUSED", "this link already acknowledged — acknowledgment is recorded once");
      }
      await db.execute(sql`
        update hrm_document_signers set status = 'signed', signed_at = now(), updated_at = now(),
               evidence = ${JSON.stringify({ acknowledged: true, timestamp: new Date().toISOString() })}::jsonb
         where org_id = ${orgId} and id = ${signer.id}
      `);
      await recordEvent(db, orgId, doc.id, "acknowledged", null);
      const updated = (await db.execute<DocumentRow>(sql`
        update hrm_documents set status = 'acknowledged', completed_at = now(), updated_at = now()
         where org_id = ${orgId} and id = ${doc.id}
        returning id, employment_id, party_id, template_id, category_key, title, file_id,
                  status, sent_at::text as sent_at, completed_at::text as completed_at,
                  expires_at::text as expires_at, retain_until::text as retain_until, legal_hold
      `)).rows[0]!;
      const { applyCompletionRetention } = await import("./retention.ts");
      await applyCompletionRetention(db, orgId, updated.id, null);
      return toDTO(await loadDocument(db, orgId, updated.id));
    });
  }
  if (!input.documentId || !input.actorId || !input.orgId) {
    throw new HrmDocumentsError("VALIDATION", "acknowledgment needs the document or a signing link");
  }
  const orgId: string = input.orgId;
  const actorId: string = input.actorId;
  const documentId: string = input.documentId;
  return withOrgTransaction(orgId, async () => {
    const doc = await loadDocument(db, orgId, documentId);
    const ownParty = await loadActorPartyId(db, orgId, actorId);
    const isOwner = ownParty !== null && ownParty === doc.party_id;
    if (!isOwner) {
      await requireHrmDocumentsManage(db, orgId, actorId);
    } else if (!(await actorHasPermission(db, orgId, actorId, "hrm.self.read"))) {
      await requireHrmDocumentsManage(db, orgId, actorId);
    }
    if (doc.status === "acknowledged") {
      throw new HrmDocumentsError("REFUSED", "this document is already acknowledged");
    }
    await recordEvent(db, orgId, doc.id, "acknowledged", actorId);
    const updated = (await db.execute<DocumentRow>(sql`
      update hrm_documents set status = 'acknowledged', completed_at = now(),
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${doc.id}
      returning id, employment_id, party_id, template_id, category_key, title, file_id,
                status, sent_at::text as sent_at, completed_at::text as completed_at,
                expires_at::text as expires_at, retain_until::text as retain_until, legal_hold
    `)).rows[0]!;
    const { applyCompletionRetention } = await import("./retention.ts");
    await applyCompletionRetention(db, orgId, updated.id, actorId);
    return toDTO(await loadDocument(db, orgId, updated.id));
  });
}

/** Void with a stored reason. */
export async function voidDocument(input: {
  orgId: string;
  actorId: string;
  documentId: string;
  reason: string;
}): Promise<DocumentDTO> {
  const reason = input.reason.trim().slice(0, 500);
  if (!reason) {
    throw new HrmDocumentsError("VALIDATION", "a void reason is required — the events ledger keeps it as the audit trail");
  }
  return withOrgTransaction(input.orgId, async () => {
    await requireHrmDocumentsManage(db, input.orgId, input.actorId);
    await assertDocumentsFeature(db, input.orgId);
    const doc = await loadDocument(db, input.orgId, input.documentId);
    if (doc.status === "voided") throw new HrmDocumentsError("REFUSED", "this document is already voided");
    if (doc.status === "signed" || doc.status === "acknowledged") {
      throw new HrmDocumentsError(
        "REFUSED",
        `a completed document is history — issue a correction instead of voiding the ${doc.status} record`,
      );
    }
    if (doc.status === "deleted") throw new HrmDocumentsError("REFUSED", "a retention-deleted document cannot be voided");
    const updated = (await db.execute<DocumentRow>(sql`
      update hrm_documents
         set status = 'voided', void_reason = ${reason}, updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${doc.id}
      returning id, employment_id, party_id, template_id, category_key, title, file_id,
                status, sent_at::text as sent_at, completed_at::text as completed_at,
                expires_at::text as expires_at, retain_until::text as retain_until, legal_hold
    `)).rows[0]!;
    await recordEvent(db, input.orgId, doc.id, "voided", input.actorId);
    return toDTO(updated);
  });
}

/** Toggle the legal hold (freezes the retention tick while on). */
export async function setLegalHold(input: {
  orgId: string;
  actorId: string;
  documentId: string;
  hold: boolean;
}): Promise<DocumentDTO> {
  return withOrgTransaction(input.orgId, async () => {
    await requireHrmDocumentsManage(db, input.orgId, input.actorId);
    await assertDocumentsFeature(db, input.orgId);
    const doc = await loadDocument(db, input.orgId, input.documentId);
    const updated = (await db.execute<DocumentRow>(sql`
      update hrm_documents
         set legal_hold = ${input.hold}, updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${doc.id}
      returning id, employment_id, party_id, template_id, category_key, title, file_id,
                status, sent_at::text as sent_at, completed_at::text as completed_at,
                expires_at::text as expires_at, retain_until::text as retain_until, legal_hold
    `)).rows[0]!;
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${input.orgId}, 'hrm_documents', ${doc.id},
              ${input.hold ? "legal_hold_on" : "legal_hold_off"},
              ${JSON.stringify({ hold: input.hold })}::jsonb, ${input.actorId})
    `);
    return toDTO(updated);
  });
}

export async function listDocuments(query: {
  orgId: string;
  actorId: string;
  partyId?: string;
  status?: string;
  categoryKey?: string;
  limit?: number;
}): Promise<DocumentDTO[]> {
  await requireHrmDocumentsRead(db, query.orgId, query.actorId);
  const rows = (await db.execute<DocumentRow>(sql`
    ${DOC_COLS}
     where org_id = ${query.orgId}
       ${query.partyId ? sql`and party_id = ${query.partyId}` : sql``}
       ${query.status ? sql`and status = ${query.status}` : sql``}
       ${query.categoryKey ? sql`and category_key = ${query.categoryKey}` : sql``}
     order by created_at desc
     limit ${Math.min(Math.max(query.limit ?? 50, 1), 200)}
  `)).rows;
  return rows.map(toDTO);
}

/** Own documents for the Me surface (hrm.self.read, fenced to own party). */
export async function listOwnDocuments(query: {
  orgId: string;
  actorId: string;
}): Promise<{ documents: DocumentDTO[]; partyId: string }> {
  if (!(await actorHasPermission(db, query.orgId, query.actorId, "hrm.self.read"))) {
    // HR readers use the manage list; self-service without the grant sees
    // nothing rather than everything.
    await requireHrmDocumentsRead(db, query.orgId, query.actorId);
    return { documents: await listDocuments(query), partyId: "" };
  }
  const partyId = await loadActorPartyId(db, query.orgId, query.actorId);
  if (!partyId) {
    throw new HrmDocumentsError(
      "REFUSED",
      "your login is not linked to a person record — ask HR to link it before opening your documents",
    );
  }
  const rows = (await db.execute<DocumentRow>(sql`
    ${DOC_COLS}
     where org_id = ${query.orgId} and party_id = ${partyId}
       and status != 'deleted'
     order by created_at desc
     limit 100
  `)).rows;
  return { documents: rows.map(toDTO), partyId };
}

export async function getDocumentDetail(query: {
  orgId: string;
  actorId: string;
  documentId: string;
}): Promise<DocumentDetail> {
  await requireHrmDocumentsRead(db, query.orgId, query.actorId);
  const doc = await loadDocument(db, query.orgId, query.documentId);
  const signers = await loadSigners(db, query.orgId, doc.id);
  const events = (await db.execute<{ kind: string; actor: string | null; recordedAt: string }>(sql`
    select kind, actor, recorded_at::text as "recordedAt"
      from hrm_document_events
     where org_id = ${query.orgId} and document_id = ${doc.id}
     order by recorded_at
  `)).rows;
  return { ...toDTO(doc), signers: signers.map(toSignerDTO), events };
}

/** Signers still waiting past the reminder threshold (the daily job reads this). */
export async function dueReminderSigners(
  exec: SqlExecutor,
  orgId: string,
  olderThanDays: number,
): Promise<{ signerId: string; documentId: string; partyId: string; title: string; sentAt: string }[]> {
  return (await exec.execute<{
    signerId: string;
    documentId: string;
    partyId: string;
    title: string;
    sentAt: string;
  }>(sql`
    select s.id as "signerId", d.id as "documentId", s.signer_party_id as "partyId",
           d.title, d.sent_at::text as "sentAt"
      from hrm_document_signers s
      join hrm_documents d on d.org_id = s.org_id and d.id = s.document_id
     where s.org_id = ${orgId} and s.status in ('pending', 'viewed')
       and d.status in ('sent', 'viewed', 'partially_signed')
       and d.sent_at < now() - (${olderThanDays} || ' days')::interval
       and (d.expires_at is null or d.expires_at > now())
       and not exists (
         select 1 from hrm_document_events e
          where e.org_id = s.org_id and e.document_id = d.id and e.kind = 'reminded'
            and e.recorded_at > now() - (${olderThanDays} || ' days')::interval
       )
     order by d.sent_at
     limit 200
  `)).rows;
}

/**
 * Record a reminder send on an open signer (the daily job calls this
 * AFTER delivering, so the reminded event witnesses an actual send).
 * The advisory lock serializes concurrent duty replicas; the conditional
 * update makes a raced second delivery a no-op, never a double event.
 */
export async function recordDocumentReminded(
  exec: SqlExecutor,
  orgId: string,
  signerId: string,
): Promise<boolean> {
  await exec.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${"hrm-doc-remind:" + orgId + ":" + signerId}, 0))
  `);
  const row = (await exec.execute<{ document_id: string }>(sql`
    select document_id from hrm_document_signers
     where org_id = ${orgId} and id = ${signerId} and status in ('pending', 'viewed')
  `)).rows[0];
  if (!row) return false;
  await recordEvent(exec, orgId, row.document_id, "reminded", null);
  return true;
}

/** Read a document's current bytes for download (HR gate or owner). */
export async function readDocumentFile(query: {
  orgId: string;
  actorId: string;
  documentId: string;
}): Promise<{ bytes: Buffer; filename: string }> {
  const doc = await loadDocument(db, query.orgId, query.documentId);
  try {
    await requireHrmDocumentsRead(db, query.orgId, query.actorId);
  } catch {
    const ownParty = await loadActorPartyId(db, query.orgId, query.actorId);
    if (
      ownParty !== doc.party_id ||
      !(await actorHasPermission(db, query.orgId, query.actorId, "hrm.self.read"))
    ) {
      throw new HrmDocumentsError(
        "FORBIDDEN",
        "this document belongs to someone else — ask HR for access instead",
      );
    }
  }
  if (!doc.file_id) throw new HrmDocumentsError("NOT_FOUND", "this document has no file yet");
  const { bytes } = await currentFileBytes(db, query.orgId, doc.file_id);
  return { bytes, filename: `${(doc.title ?? "document").replace(/[^\w\- ]+/g, "").trim().slice(0, 80) || "document"}.pdf` };
}

