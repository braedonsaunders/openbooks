import { sql } from "drizzle-orm";
import {
  requireHrmCertificationsManage,
  requireHrmCertificationsRead,
} from "../authorization.ts";
import { HrmQualificationError } from "./errors.ts";
import {
  HRM_CERTIFICATIONS_FEATURE,
  assertQualificationsFeature,
  requireId,
  requireText,
  runInCallerTransaction,
  type SqlExecutor,
} from "./shared.ts";

/**
 * Qualification taxonomy (HR-14, hrm_qualification_types): org-declared
 * codes through Setup. category is one of the six base values or an
 * org-declared extra from hrm_qualification_settings — the service
 * validates first so the refusal names the Setup path, and the storage
 * trigger guards writers that bypass the service.
 */

export const BASE_CATEGORIES = [
  "certification",
  "license",
  "training",
  "medical",
  "clearance",
  "other",
] as const;

export type BaseCategory = (typeof BASE_CATEGORIES)[number];

export interface QualificationType {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly category: string;
  readonly issuingBody: string | null;
  readonly validityMonths: number | null;
  readonly renewalLeadDays: number;
  readonly requiresEvidence: boolean;
  readonly isActive: boolean;
}

export interface QualificationSettings {
  readonly extraCategories: readonly string[];
  readonly alertLeadDays: readonly number[];
}

export const DEFAULT_ALERT_LEAD_DAYS = [30, 14, 7, 1] as const;

type TypeRow = {
  id: string;
  code: string;
  name: string;
  category: string;
  issuing_body: string | null;
  validity_months: number | null;
  renewal_lead_days: number;
  requires_evidence: boolean;
  is_active: boolean;
};

function toType(row: TypeRow): QualificationType {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    issuingBody: row.issuing_body,
    validityMonths: row.validity_months,
    renewalLeadDays: row.renewal_lead_days,
    requiresEvidence: row.requires_evidence,
    isActive: row.is_active,
  };
}

const TYPE_COLS = sql`id, code, name, category, issuing_body, validity_months, renewal_lead_days, requires_evidence, is_active`;

export async function loadSettings(exec: SqlExecutor, orgId: string): Promise<QualificationSettings> {
  const rows = (await exec.execute<{ extra_categories: string[]; alert_lead_days: number[] }>(sql`
    select extra_categories, alert_lead_days from hrm_qualification_settings
     where org_id = ${orgId}::uuid
  `)).rows;
  const row = rows[0];
  if (!row) return { extraCategories: [], alertLeadDays: [...DEFAULT_ALERT_LEAD_DAYS] };
  return {
    extraCategories: [...(row.extra_categories ?? [])],
    alertLeadDays: [...(row.alert_lead_days ?? [...DEFAULT_ALERT_LEAD_DAYS])],
  };
}

async function assertCategoryDeclared(
  exec: SqlExecutor,
  orgId: string,
  category: string,
): Promise<void> {
  if ((BASE_CATEGORIES as readonly string[]).includes(category)) return;
  const settings = await loadSettings(exec, orgId);
  if (!settings.extraCategories.includes(category)) {
    throw new HrmQualificationError(
      `Qualification category "${category}" is not declared for this organization — declare it under Company Settings → HRM → Qualification categories, or use one of ${BASE_CATEGORIES.join(", ")}.`,
    );
  }
}

export async function listQualificationTypes(
  exec: SqlExecutor,
  input: { orgId: string; actorId: string; includeInactive?: boolean },
): Promise<QualificationType[]> {
  const orgId = requireId(input.orgId, "orgId");
  requireId(input.actorId, "actorId");
  await requireHrmCertificationsRead(exec, orgId, input.actorId);
  await assertQualificationsFeature(exec, orgId, HRM_CERTIFICATIONS_FEATURE, "Qualification types");
  const rows = (await exec.execute<TypeRow>(sql`
    select ${TYPE_COLS} from hrm_qualification_types
     where org_id = ${orgId}::uuid
       and (${input.includeInactive === true}::boolean or is_active)
     order by code
  `)).rows;
  return rows.map(toType);
}

export interface CreateQualificationTypeInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly code: string;
  readonly name: string;
  readonly category: string;
  readonly issuingBody?: string | null;
  readonly validityMonths?: number | null;
  readonly renewalLeadDays?: number;
  readonly requiresEvidence?: boolean;
}

export async function createQualificationType(
  exec: SqlExecutor,
  input: CreateQualificationTypeInput,
): Promise<QualificationType> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  return runInCallerTransaction(exec, async (tx) => {
    await requireHrmCertificationsManage(tx, orgId, actorId);
    await assertQualificationsFeature(tx, orgId, HRM_CERTIFICATIONS_FEATURE, "Qualification types");
    const code = requireText(input.code, "code");
    const name = requireText(input.name, "name");
    const category = requireText(input.category, "category");
    await assertCategoryDeclared(tx, orgId, category);
    const validityMonths = input.validityMonths ?? null;
    if (validityMonths !== null && (!Number.isInteger(validityMonths) || validityMonths <= 0)) {
      throw new HrmQualificationError(
        "validity_months must be a positive whole number of months, or null for a qualification that does not expire.",
      );
    }
    const renewalLeadDays = input.renewalLeadDays ?? 30;
    if (!Number.isInteger(renewalLeadDays) || renewalLeadDays < 0) {
      throw new HrmQualificationError("renewal_lead_days must be a non-negative whole number of days.");
    }
    try {
      const rows = (await tx.execute<TypeRow>(sql`
        insert into hrm_qualification_types
          (org_id, code, name, category, issuing_body, validity_months,
           renewal_lead_days, requires_evidence, created_by, updated_by)
        values (${orgId}::uuid, ${code}, ${name}, ${category},
                ${input.issuingBody ?? null}, ${validityMonths},
                ${renewalLeadDays}, ${input.requiresEvidence ?? false}::boolean,
                ${actorId}::uuid, ${actorId}::uuid)
        returning ${TYPE_COLS}
      `)).rows;
      const created = rows[0];
      if (!created) throw new HrmQualificationError("The qualification type was not stored — no row was written; retry the action.");
      return toType(created);
    } catch (error) {
      if (error instanceof Error && /duplicate key|unique/i.test(error.message)) {
        throw new HrmQualificationError(
          `Qualification code "${code}" is already declared — reuse it instead of declaring it twice.`,
        );
      }
      throw error;
    }
  });
}

export interface UpdateQualificationTypeInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly typeId: string;
  readonly name?: string;
  readonly category?: string;
  readonly issuingBody?: string | null;
  readonly validityMonths?: number | null;
  readonly renewalLeadDays?: number;
  readonly requiresEvidence?: boolean;
  readonly isActive?: boolean;
}

/**
 * Retire or correct a type. History is preserved: deactivation hides the
 * type from new records but held qualifications keep resolving (their
 * type row stays readable); code is immutable.
 */
export async function updateQualificationType(
  exec: SqlExecutor,
  input: UpdateQualificationTypeInput,
): Promise<QualificationType> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const typeId = requireId(input.typeId, "typeId");
  return runInCallerTransaction(exec, async (tx) => {
    await requireHrmCertificationsManage(tx, orgId, actorId);
    await assertQualificationsFeature(tx, orgId, HRM_CERTIFICATIONS_FEATURE, "Qualification types");
    const name = input.name === undefined ? undefined : requireText(input.name, "name");
    const category = input.category === undefined ? undefined : requireText(input.category, "category");
    if (category !== undefined) await assertCategoryDeclared(tx, orgId, category);
    if (input.validityMonths !== undefined) {
      const v = input.validityMonths;
      if (v !== null && (!Number.isInteger(v) || v <= 0)) {
        throw new HrmQualificationError(
          "validity_months must be a positive whole number of months, or null for a qualification that does not expire.",
        );
      }
    }
    if (input.renewalLeadDays !== undefined) {
      const l = input.renewalLeadDays;
      if (!Number.isInteger(l) || l < 0) {
        throw new HrmQualificationError("renewal_lead_days must be a non-negative whole number of days.");
      }
    }
    const rows = (await tx.execute<TypeRow>(sql`
      update hrm_qualification_types set
        name = coalesce(${name ?? null}, name),
        category = coalesce(${category ?? null}, category),
        issuing_body = case when ${input.issuingBody !== undefined}::boolean
          then ${input.issuingBody ?? null} else issuing_body end,
        validity_months = case when ${input.validityMonths !== undefined}::boolean
          then ${input.validityMonths ?? null} else validity_months end,
        renewal_lead_days = coalesce(${input.renewalLeadDays ?? null}, renewal_lead_days),
        requires_evidence = case when ${input.requiresEvidence !== undefined}::boolean
          then ${input.requiresEvidence ?? false}::boolean else requires_evidence end,
        is_active = case when ${input.isActive !== undefined}::boolean
          then ${input.isActive ?? true}::boolean else is_active end,
        updated_by = ${actorId}::uuid, updated_at = now()
       where org_id = ${orgId}::uuid and id = ${typeId}::uuid
       returning ${TYPE_COLS}
    `)).rows;
    const updated = rows[0];
    // A write that matches zero rows is a failure, not a success: under
    // RLS an unscoped update silently matches nothing and reports success.
    if (!updated) {
      throw new HrmQualificationError(
        "The qualification type was not found in this organization — it may belong to another org or have been removed; refresh the taxonomy and try again.",
      );
    }
    return toType(updated);
  });
}

export interface DeclareCategoryInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly category: string;
}

/** Extend the org's category vocabulary through Setup (stored in settings). */
export async function declareCategory(
  exec: SqlExecutor,
  input: DeclareCategoryInput,
): Promise<QualificationSettings> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const category = requireText(input.category, "category");
  if ((BASE_CATEGORIES as readonly string[]).includes(category)) {
    throw new HrmQualificationError(
      `"${category}" is already a built-in category — declare only genuinely new vocabulary here.`,
    );
  }
  return runInCallerTransaction(exec, async (tx) => {
    await requireHrmCertificationsManage(tx, orgId, actorId);
    await assertQualificationsFeature(tx, orgId, HRM_CERTIFICATIONS_FEATURE, "Qualification categories");
    await tx.execute(sql`
      insert into hrm_qualification_settings (org_id, extra_categories, created_by, updated_by)
      values (${orgId}::uuid, array[${category}]::text[], ${actorId}::uuid, ${actorId}::uuid)
      on conflict (org_id) do update set
        extra_categories = (
          select array_agg(distinct c order by c)
            from unnest(hrm_qualification_settings.extra_categories || excluded.extra_categories) as c
        ),
        updated_by = ${actorId}::uuid, updated_at = now()
    `);
    // On conflict the row already exists for this org, so the upsert
    // above always leaves exactly one settings row: the conflict arm is
    // the expected steady state, not a dropped write.
    return loadSettings(tx, orgId);
  });
}

export interface SetAlertScheduleInput {
  readonly orgId: string;
  readonly actorId: string;
  /** Whole-day lead times, e.g. [30, 14, 7, 1]. */
  readonly leadDays: readonly number[];
}

/** Replace the org's default expiry-alert schedule (Setup). */
export async function setAlertSchedule(
  exec: SqlExecutor,
  input: SetAlertScheduleInput,
): Promise<QualificationSettings> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  if (input.leadDays.length === 0) {
    throw new HrmQualificationError("The alert schedule needs at least one lead day — expiry alerts with no schedule would silently never fire.");
  }
  for (const d of input.leadDays) {
    if (!Number.isInteger(d) || d <= 0) {
      throw new HrmQualificationError("Every alert lead day must be a positive whole number of days before expiry.");
    }
  }
  const schedule = [...new Set(input.leadDays)].sort((a, b) => b - a);
  return runInCallerTransaction(exec, async (tx) => {
    await requireHrmCertificationsManage(tx, orgId, actorId);
    await assertQualificationsFeature(tx, orgId, HRM_CERTIFICATIONS_FEATURE, "Alert schedule");
    await tx.execute(sql`
      insert into hrm_qualification_settings (org_id, alert_lead_days, created_by, updated_by)
      values (${orgId}::uuid, ${sql.raw(`array[${schedule.map((d) => `${d}`).join(",")}]::integer[]`)}, ${actorId}::uuid, ${actorId}::uuid)
      on conflict (org_id) do update set
        alert_lead_days = excluded.alert_lead_days,
        updated_by = ${actorId}::uuid, updated_at = now()
    `);
    return loadSettings(tx, orgId);
  });
}
