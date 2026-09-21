import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { requireHrmDocumentsManage, requireHrmDocumentsRead } from "../authorization.ts";
import { HrmDocumentsError } from "./errors.ts";

/**
 * HR-19 document categories: the org-declared Setup vocabulary
 * (hrm_document_categories) that template, document, and retention-schedule
 * category keys must name.
 *
 * Keys are validated by membership, not shape: saveTemplate and
 * saveSchedule refuse an undeclared key by name and point at Setup →
 * Workforce → Document Categories, which is the only screen that mints
 * keys. category_key columns stay text with no FK — a category deactivated
 * mid-life must not strand issued documents, so reads (retention matching,
 * filters) treat an unknown key as "no rule", while WRITES fail closed.
 */

export interface DocumentCategoryDTO {
  id: string;
  key: string;
  label: string;
  isActive: boolean;
}

type CategoryRow = {
  id: string;
  key: string;
  label: string;
  is_active: boolean;
};

function toDTO(row: CategoryRow): DocumentCategoryDTO {
  return { id: row.id, key: row.key, label: row.label, isActive: row.is_active };
}

export function validateCategoryKey(key: unknown): string {
  const clean = typeof key === "string" ? key.trim() : "";
  if (!clean) {
    throw new HrmDocumentsError(
      "VALIDATION",
      "category key is required — declare document categories under Setup → Workforce → Document Categories first",
    );
  }
  if (/\s/.test(clean)) {
    throw new HrmDocumentsError("VALIDATION", "category key must not contain whitespace — use a code like contract");
  }
  if (clean.length > 80) {
    throw new HrmDocumentsError("VALIDATION", "category key must be 80 characters or fewer");
  }
  return clean;
}

/** Fail closed: an authoring write naming an undeclared (or inactive) category is refused by name. */
export async function assertCategoryDeclared(
  exec: SqlExecutor,
  orgId: string,
  categoryKey: string,
): Promise<void> {
  const rows = (await exec.execute<{ id: string }>(sql`
    select id from hrm_document_categories
     where org_id = ${orgId} and key = ${categoryKey} and is_active
  `)).rows;
  if (rows.length === 0) {
    throw new HrmDocumentsError(
      "VALIDATION",
      `category ${JSON.stringify(categoryKey)} is not declared — declare it under Setup → Workforce → Document Categories first`,
    );
  }
}

export async function listCategories(query: {
  orgId: string;
  actorId: string;
  includeInactive?: boolean;
}): Promise<DocumentCategoryDTO[]> {
  await requireHrmDocumentsRead(db, query.orgId, query.actorId);
  const rows = (await db.execute<CategoryRow>(sql`
    select id, key, label, is_active
      from hrm_document_categories
     where org_id = ${query.orgId}
       ${query.includeInactive ? sql`` : sql`and is_active`}
     order by label
  `)).rows;
  return rows.map(toDTO);
}

export async function saveCategory(input: {
  orgId: string;
  actorId: string;
  categoryId?: string;
  key: unknown;
  label: unknown;
  isActive?: boolean;
}): Promise<DocumentCategoryDTO> {
  const key = validateCategoryKey(input.key);
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!label) throw new HrmDocumentsError("VALIDATION", "category label is required");
  return withOrgTransaction(input.orgId, async () => {
    await requireHrmDocumentsManage(db, input.orgId, input.actorId);
    if (input.categoryId) {
      const updated = (await db.execute<CategoryRow>(sql`
        update hrm_document_categories
           set key = ${key}, label = ${label}, is_active = ${input.isActive ?? true},
               updated_at = now(), updated_by = ${input.actorId}
         where org_id = ${input.orgId} and id = ${input.categoryId}
        returning id, key, label, is_active
      `)).rows[0];
      // Zero matched rows is a failure: unknown id or another org's row.
      if (!updated) {
        throw new HrmDocumentsError(
          "NOT_FOUND",
          "category is not visible in this organization — it may belong to another org, so the save is refused rather than forked",
        );
      }
      return toDTO(updated);
    }
    try {
      const inserted = (await db.execute<CategoryRow>(sql`
        insert into hrm_document_categories
          (org_id, key, label, is_active, created_by, updated_by)
        values (${input.orgId}, ${key}, ${label}, ${input.isActive ?? true},
                ${input.actorId}, ${input.actorId})
        returning id, key, label, is_active
      `)).rows[0];
      if (!inserted) {
        throw new HrmDocumentsError(
          "REFUSED",
          "the category insert matched no row — the save is refused, never a silent success",
        );
      }
      return toDTO(inserted);
    } catch (e) {
      if (e instanceof HrmDocumentsError) throw e;
      const chain: string[] = [];
      let cursor: unknown = e;
      while (cursor instanceof Error && chain.length < 5) {
        chain.push(cursor.message);
        const cause = (cursor as { cause?: unknown }).cause;
        cursor = cause instanceof Error ? cause : null;
      }
      if (/duplicate key|unique violation|23505|hrm_document_categories_org_key/i.test(chain.join("\n"))) {
        throw new HrmDocumentsError(
          "REFUSED",
          `category ${JSON.stringify(key)} is already declared — edit it instead of adding a second`,
        );
      }
      throw e;
    }
  });
}
