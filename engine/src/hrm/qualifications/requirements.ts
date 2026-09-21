import { sql } from "drizzle-orm";
import {
  requireHrmCertificationsManage,
  requireHrmCertificationsRead,
} from "../authorization.ts";
import { HrmQualificationError } from "./errors.ts";
import {
  HRM_CERTIFICATIONS_FEATURE,
  assertQualificationsFeature,
  requireDate,
  requireId,
  runInCallerTransaction,
  type SqlExecutor,
} from "./shared.ts";

/**
 * Qualification requirements (HR-14, hrm_qualification_requirements):
 * what a project, equipment, position or classification demands.
 *
 * subject_id is polymorphic (no FK — one column names four parents), so
 * the service proves the caller can read the subject before storing a
 * requirement against it: a requirement on a subject the caller cannot
 * read is refused by name. block severity refuses the dispatch; warn
 * lets it through and records a warned event for display.
 */

export type RequirementSubjectKind = "project" | "equipment" | "position" | "classification";
export type RequirementSeverity = "block" | "warn";

const SUBJECT_KINDS: readonly RequirementSubjectKind[] = [
  "project",
  "equipment",
  "position",
  "classification",
];

const SEVERITIES: readonly RequirementSeverity[] = ["block", "warn"];

export interface QualificationRequirement {
  readonly id: string;
  readonly subjectKind: RequirementSubjectKind;
  readonly subjectId: string;
  readonly subjectName: string;
  readonly typeId: string;
  readonly typeCode: string;
  readonly typeName: string;
  readonly requiredFrom: string;
  readonly requiredTo: string | null;
  readonly severity: RequirementSeverity;
}

type RequirementRow = {
  id: string;
  subject_kind: RequirementSubjectKind;
  subject_id: string;
  subject_name: string;
  type_id: string;
  type_code: string;
  type_name: string;
  required_from: string;
  required_to: string | null;
  severity: RequirementSeverity;
};

function toRequirement(row: RequirementRow): QualificationRequirement {
  return {
    id: row.id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    typeId: row.type_id,
    typeCode: row.type_code,
    typeName: row.type_name,
    requiredFrom: row.required_from,
    requiredTo: row.required_to,
    severity: row.severity,
  };
}

/**
 * Prove the subject exists in this org and resolve its display name.
 * One country's project is another's equipment id — the kind decides
 * which table answers, and an unreadable subject is refused, never
 * stored against.
 */
export async function resolveSubject(
  exec: SqlExecutor,
  orgId: string,
  subjectKind: RequirementSubjectKind,
  subjectId: string,
): Promise<string> {
  let name: string | null = null;
  if (subjectKind === "project") {
    const rows = (await exec.execute<{ name: string }>(sql`
      select name from projects where org_id = ${orgId}::uuid and id = ${subjectId}::uuid
    `)).rows;
    name = rows[0]?.name ?? null;
  } else if (subjectKind === "equipment") {
    const rows = (await exec.execute<{ name: string }>(sql`
      select coalesce(name, serial_number, id::text) as name from equipment_units
       where org_id = ${orgId}::uuid and id = ${subjectId}::uuid
    `)).rows;
    name = rows[0]?.name ?? null;
  } else if (subjectKind === "position") {
    const rows = (await exec.execute<{ code: string }>(sql`
      select code from hrm_positions where org_id = ${orgId}::uuid and id = ${subjectId}::uuid
    `)).rows;
    name = rows[0]?.code ?? null;
  } else {
    const rows = (await exec.execute<{ code: string }>(sql`
      select code from hrm_work_classifications where org_id = ${orgId}::uuid and id = ${subjectId}::uuid
    `)).rows;
    name = rows[0]?.code ?? null;
  }
  if (!name) {
    throw new HrmQualificationError(
      `The ${subjectKind} was not found in this organization or you cannot read it — a requirement cannot be set on a subject outside your scope.`,
    );
  }
  return name;
}

function subjectNameSql(kind: RequirementSubjectKind): ReturnType<typeof sql> {
  if (kind === "project") return sql`(select p.name from projects p where p.org_id = r.org_id and p.id = r.subject_id)`;
  if (kind === "equipment") {
    return sql`(select coalesce(e.name, e.serial_number, e.id::text) from equipment_units e where e.org_id = r.org_id and e.id = r.subject_id)`;
  }
  if (kind === "position") return sql`(select p.code from hrm_positions p where p.org_id = r.org_id and p.id = r.subject_id)`;
  return sql`(select c.code from hrm_work_classifications c where c.org_id = r.org_id and c.id = r.subject_id)`;
}

export interface SetRequirementInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly subjectKind: RequirementSubjectKind;
  readonly subjectId: string;
  readonly typeId: string;
  readonly requiredFrom?: string;
  readonly requiredTo?: string | null;
  readonly severity?: RequirementSeverity;
}

/**
 * Declare (or re-declare) a requirement. Re-declaring the same
 * (subject, type) edits the window/severity in place — the upsert is
 * the expected steady state for an authoring surface, not a dropped
 * write, and the row comes back so the caller sees what is stored.
 */
export async function setRequirement(
  exec: SqlExecutor,
  input: SetRequirementInput,
): Promise<QualificationRequirement> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  if (!SUBJECT_KINDS.includes(input.subjectKind)) {
    throw new HrmQualificationError(
      `Unknown requirement subject ${String(input.subjectKind)} — use one of ${SUBJECT_KINDS.join(", ")}.`,
    );
  }
  const subjectId = requireId(input.subjectId, "subjectId");
  const typeId = requireId(input.typeId, "typeId");
  const requiredFrom = input.requiredFrom === undefined ? null : requireDate(input.requiredFrom, "requiredFrom");
  const requiredTo = input.requiredTo === undefined || input.requiredTo === null ? null : requireDate(input.requiredTo, "requiredTo");
  if (requiredFrom && requiredTo && requiredTo < requiredFrom) {
    throw new HrmQualificationError(
      `required_to ${requiredTo} is before required_from ${requiredFrom} — a requirement cannot end before it starts.`,
    );
  }
  const severity = input.severity ?? "block";
  if (!SEVERITIES.includes(severity)) {
    throw new HrmQualificationError(`Unknown severity ${String(severity)} — use one of ${SEVERITIES.join(", ")}.`);
  }
  return runInCallerTransaction(exec, async (tx) => {
    await requireHrmCertificationsManage(tx, orgId, actorId);
    await assertQualificationsFeature(tx, orgId, HRM_CERTIFICATIONS_FEATURE, "Qualification requirements");
    const subjectName = await resolveSubject(tx, orgId, input.subjectKind, subjectId);
    const type = (await tx.execute<{ id: string; code: string }>(sql`
      select id, code from hrm_qualification_types
       where org_id = ${orgId}::uuid and id = ${typeId}::uuid and is_active
    `)).rows[0];
    if (!type) {
      throw new HrmQualificationError(
        "The qualification type is not declared (or is retired) in this organization — declare it under Company Settings → HRM → Qualification types first.",
      );
    }
    const savedId = (await tx.execute<{ id: string }>(sql`
      insert into hrm_qualification_requirements
        (org_id, subject_kind, subject_id, type_id, required_from, required_to,
         severity, created_by, updated_by)
      values (${orgId}::uuid, ${input.subjectKind}, ${subjectId}::uuid, ${typeId}::uuid,
              coalesce(${requiredFrom}::date, current_date), ${requiredTo}::date,
              ${severity}, ${actorId}::uuid, ${actorId}::uuid)
      on conflict (org_id, subject_kind, subject_id, type_id) do update set
        required_from = excluded.required_from,
        required_to = excluded.required_to,
        severity = excluded.severity,
        updated_by = ${actorId}::uuid, updated_at = now()
      returning id
    `)).rows[0]?.id;
    // The upsert always stores exactly one row: the conflict arm is the
    // expected re-declaration path, so a missing id is a failure.
    if (!savedId) throw new HrmQualificationError("The requirement was not stored — no row was written; retry the action.");
    const typeName = (await tx.execute<{ name: string }>(sql`
      select name from hrm_qualification_types where org_id = ${orgId}::uuid and id = ${typeId}::uuid
    `)).rows[0]?.name ?? type.code;
    const saved = (await tx.execute<RequirementRow>(sql`
      select r.id, r.subject_kind, r.subject_id::text,
             r.required_from::text, r.required_to::text, r.severity,
             r.type_id::text as type_id
        from hrm_qualification_requirements r
       where r.org_id = ${orgId}::uuid and r.id = ${savedId}::uuid
    `)).rows[0];
    // The row was just written in this transaction: unreadable means the
    // transaction itself is broken, never a silent success.
    if (!saved) throw new HrmQualificationError("The requirement was stored but cannot be read back — retry the action.");
    return toRequirement({ ...saved, type_code: type.code, type_name: typeName, subject_name: subjectName });
  });
}

export interface RemoveRequirementInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly requirementId: string;
}

export async function removeRequirement(exec: SqlExecutor, input: RemoveRequirementInput): Promise<void> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const requirementId = requireId(input.requirementId, "requirementId");
  return runInCallerTransaction(exec, async (tx) => {
    await requireHrmCertificationsManage(tx, orgId, actorId);
    await assertQualificationsFeature(tx, orgId, HRM_CERTIFICATIONS_FEATURE, "Qualification requirements");
    const rows = (await tx.execute<{ id: string }>(sql`
      delete from hrm_qualification_requirements
       where org_id = ${orgId}::uuid and id = ${requirementId}::uuid
       returning id
    `)).rows;
    // A write that matches zero rows is a failure, not a success.
    if (!rows[0]) {
      throw new HrmQualificationError(
        "The requirement was not found in this organization — it may belong to another org or have been removed; refresh and try again.",
      );
    }
  });
}

export interface ListRequirementsInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly subjectKind?: RequirementSubjectKind;
  readonly subjectId?: string;
}

/** HR reads all; anyone else reads through the certifications read grant only. */
export async function listRequirements(
  exec: SqlExecutor,
  input: ListRequirementsInput,
): Promise<QualificationRequirement[]> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  await requireHrmCertificationsRead(exec, orgId, actorId);
  await assertQualificationsFeature(exec, orgId, HRM_CERTIFICATIONS_FEATURE, "Qualification requirements");
  const kind = input.subjectKind ?? null;
  if (kind !== null && !SUBJECT_KINDS.includes(kind)) {
    throw new HrmQualificationError(`Unknown requirement subject ${String(kind)} — use one of ${SUBJECT_KINDS.join(", ")}.`);
  }
  const subjectId = input.subjectId ?? null;
  // One query per subject kind (four at most): subject_id is polymorphic
  // with no FK, so each kind resolves its display name from its own table.
  const out: QualificationRequirement[] = [];
  const kinds = kind ? [kind] : [...SUBJECT_KINDS];
  for (const k of kinds) {
    const rows = (await exec.execute<RequirementRow>(sql`
      select r.id, r.subject_kind, r.subject_id::text,
             ${subjectNameSql(k)} as subject_name,
             r.type_id::text as type_id, t.code as type_code, t.name as type_name,
             r.required_from::text, r.required_to::text, r.severity
        from hrm_qualification_requirements r
        join hrm_qualification_types t
          on t.org_id = r.org_id and t.id = r.type_id
       where r.org_id = ${orgId}::uuid and r.subject_kind = ${k}
         and (${subjectId}::uuid is null or r.subject_id = ${subjectId}::uuid)
       order by r.subject_id, t.code
    `)).rows;
    for (const row of rows) {
      if (!row.subject_name) continue;
      out.push(toRequirement(row));
    }
  }
  return out;
}
