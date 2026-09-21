import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { HRM_FEATURE_KEY } from "../employment-read.ts";
import { requireHrmDocumentsManage, requireHrmDocumentsRead } from "../authorization.ts";
import { HrmDocumentsError } from "./errors.ts";

/**
 * HR-19 document templates (Setup-style authoring in the service so the
 * Setup generic write path and the API share one validation).
 *
 * Categories are org-declared (a settings list), never an enum: the
 * service checks category_key is non-blank and leaves the vocabulary to
 * Setup. merge_fields declares the mustache keys the template may use;
 * every key must belong to DOCUMENT_MERGE_FIELDS (documents.ts) — an
 * undeclared key is refused at save, never resolved to null at render.
 * signer_roles is the ordered subset of [employee, manager, hr].
 * acknowledgment_only templates take no signatures at all.
 */

export const DOCUMENT_SIGNER_ROLES = ["employee", "manager", "hr"] as const;
export type DocumentSignerRole = (typeof DOCUMENT_SIGNER_ROLES)[number];

async function assertDocumentsFeature(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new HrmDocumentsError(
      "REFUSED",
      "documents are unavailable while the hrm feature is off — enable it under Company Settings → Features; existing documents are preserved",
    );
  }
  if (!(await lockAndCheckOrgFeature(exec, orgId, "hrmDocuments"))) {
    throw new HrmDocumentsError(
      "REFUSED",
      "documents are unavailable while the hrmDocuments feature is off — enable it under Company Settings → Features; existing documents are preserved",
    );
  }
}

export interface DocumentTemplateDTO {
  id: string;
  name: string;
  categoryKey: string;
  bodyTemplate: string;
  mergeFields: string[];
  requiresSignature: boolean;
  signerRoles: DocumentSignerRole[];
  acknowledgmentOnly: boolean;
  isActive: boolean;
}

type TemplateRow = {
  id: string;
  name: string;
  category_key: string;
  body_template: string;
  merge_fields: unknown;
  requires_signature: boolean;
  signer_roles: unknown;
  acknowledgment_only: boolean;
  is_active: boolean;
};

function toDTO(row: TemplateRow): DocumentTemplateDTO {
  const mergeFields = Array.isArray(row.merge_fields)
    ? row.merge_fields.filter((f): f is string => typeof f === "string")
    : [];
  const signerRoles = Array.isArray(row.signer_roles)
    ? row.signer_roles.filter((r): r is DocumentSignerRole =>
        r === "employee" || r === "manager" || r === "hr",
      )
    : [];
  return {
    id: row.id,
    name: row.name,
    categoryKey: row.category_key,
    bodyTemplate: row.body_template,
    mergeFields,
    requiresSignature: row.requires_signature,
    signerRoles,
    acknowledgmentOnly: row.acknowledgment_only,
    isActive: row.is_active,
  };
}

export function validateTemplateInput(input: {
  name: unknown;
  categoryKey: unknown;
  bodyTemplate: unknown;
  mergeFields: unknown;
  requiresSignature: unknown;
  signerRoles: unknown;
  acknowledgmentOnly: unknown;
}): {
  name: string;
  categoryKey: string;
  bodyTemplate: string;
  mergeFields: string[];
  requiresSignature: boolean;
  signerRoles: DocumentSignerRole[];
  acknowledgmentOnly: boolean;
} {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new HrmDocumentsError("VALIDATION", "template name is required");
  const categoryKey = typeof input.categoryKey === "string" ? input.categoryKey.trim() : "";
  if (!categoryKey) {
    throw new HrmDocumentsError(
      "VALIDATION",
      "category is required — declare document categories under Setup → Workforce → Document Categories first",
    );
  }
  const bodyTemplate = typeof input.bodyTemplate === "string" ? input.bodyTemplate : "";
  if (!bodyTemplate.trim()) throw new HrmDocumentsError("VALIDATION", "body template is required");
  if (!Array.isArray(input.mergeFields)) {
    throw new HrmDocumentsError("VALIDATION", "mergeFields must be the declared list of merge keys");
  }
  const mergeFields = input.mergeFields.map((f) => String(f));
  const signerRoles = Array.isArray(input.signerRoles) ? input.signerRoles.map((r) => String(r)) : [];
  for (const role of signerRoles) {
    if (role !== "employee" && role !== "manager" && role !== "hr") {
      throw new HrmDocumentsError(
        "VALIDATION",
        `signer role ${JSON.stringify(role)} is unknown — signer roles are ordered from employee, manager, hr`,
      );
    }
  }
  const acknowledgmentOnly = input.acknowledgmentOnly === true;
  const requiresSignature = input.requiresSignature === true;
  if (acknowledgmentOnly && (requiresSignature || signerRoles.length > 0)) {
    throw new HrmDocumentsError(
      "VALIDATION",
      "acknowledgment-only templates take no signatures — clear requiresSignature and signerRoles, or clear acknowledgmentOnly",
    );
  }
  if (requiresSignature && signerRoles.length === 0) {
    throw new HrmDocumentsError(
      "VALIDATION",
      "a template that requires signature must name its ordered signerRoles — at least employee",
    );
  }
  return {
    name,
    categoryKey,
    bodyTemplate,
    mergeFields,
    requiresSignature,
    signerRoles: signerRoles as DocumentSignerRole[],
    acknowledgmentOnly,
  };
}

const SELECT_COLS = sql`
  select id, name, category_key, body_template, merge_fields, requires_signature,
         signer_roles, acknowledgment_only, is_active
    from hrm_document_templates`;

export async function listTemplates(query: {
  orgId: string;
  actorId: string;
  includeInactive?: boolean;
}): Promise<DocumentTemplateDTO[]> {
  await requireHrmDocumentsRead(db, query.orgId, query.actorId);
  const rows = (await db.execute<TemplateRow>(sql`
    ${SELECT_COLS}
     where org_id = ${query.orgId}
       ${query.includeInactive ? sql`` : sql`and is_active`}
     order by name
  `)).rows;
  return rows.map(toDTO);
}

export async function getTemplate(query: {
  orgId: string;
  actorId: string;
  templateId: string;
}): Promise<DocumentTemplateDTO> {
  await requireHrmDocumentsRead(db, query.orgId, query.actorId);
  const row = (await db.execute<TemplateRow>(sql`
    ${SELECT_COLS}
     where org_id = ${query.orgId} and id = ${query.templateId}
  `)).rows[0];
  if (!row) {
    throw new HrmDocumentsError("NOT_FOUND", "template is not visible in this organization");
  }
  return toDTO(row);
}

export async function saveTemplate(input: {
  orgId: string;
  actorId: string;
  templateId?: string;
  name: unknown;
  categoryKey: unknown;
  bodyTemplate: unknown;
  mergeFields: unknown;
  requiresSignature: unknown;
  signerRoles: unknown;
  acknowledgmentOnly: unknown;
  isActive?: boolean;
}): Promise<DocumentTemplateDTO> {
  const valid = validateTemplateInput(input);
  return withOrgTransaction(input.orgId, async () => {
    await requireHrmDocumentsManage(db, input.orgId, input.actorId);
    await assertDocumentsFeature(db, input.orgId);
    if (input.templateId) {
      const updated = (await db.execute<TemplateRow>(sql`
        update hrm_document_templates
           set name = ${valid.name}, category_key = ${valid.categoryKey},
               body_template = ${valid.bodyTemplate},
               merge_fields = ${JSON.stringify(valid.mergeFields)}::jsonb,
               requires_signature = ${valid.requiresSignature},
               signer_roles = ${JSON.stringify(valid.signerRoles)}::jsonb,
               acknowledgment_only = ${valid.acknowledgmentOnly},
               is_active = ${input.isActive ?? true},
               updated_at = now(), updated_by = ${input.actorId}
         where org_id = ${input.orgId} and id = ${input.templateId}
        returning id, name, category_key, body_template, merge_fields, requires_signature,
                  signer_roles, acknowledgment_only, is_active
      `)).rows[0];
      // Zero matched rows is a failure: unknown id or another org's row.
      if (!updated) {
        throw new HrmDocumentsError(
          "NOT_FOUND",
          "template is not visible in this organization — it may belong to another org, so the save is refused rather than forked",
        );
      }
      return toDTO(updated);
    }
    const inserted = (await db.execute<TemplateRow>(sql`
      insert into hrm_document_templates
        (org_id, name, category_key, body_template, merge_fields, requires_signature,
         signer_roles, acknowledgment_only, is_active, created_by, updated_by)
      values (${input.orgId}, ${valid.name}, ${valid.categoryKey}, ${valid.bodyTemplate},
              ${JSON.stringify(valid.mergeFields)}::jsonb, ${valid.requiresSignature},
              ${JSON.stringify(valid.signerRoles)}::jsonb, ${valid.acknowledgmentOnly},
              ${input.isActive ?? true}, ${input.actorId}, ${input.actorId})
      returning id, name, category_key, body_template, merge_fields, requires_signature,
                signer_roles, acknowledgment_only, is_active
    `)).rows[0];
    if (!inserted) {
      throw new HrmDocumentsError(
        "REFUSED",
        "the template insert matched no row — the save is refused, never a silent success",
      );
    }
    return toDTO(inserted);
  });
}
