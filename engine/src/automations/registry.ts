import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import type { SubjectSnapshot } from "./evaluate.ts";

/**
 * HR-16 automation subject registry — the entities the engine may
 * read, trigger on, and (through a per-entity field allowlist) update.
 *
 * Declared in code and tested (registry.test.ts pins the entity list,
 * the allowlists, and that every loader resolves a fixture row). An
 * update_field action naming an entity or field outside the allowlist
 * is a hostile-loop refusal at author AND run time — never arbitrary
 * writes. Webhook targets come from an org-declared endpoint registry,
 * never a free-form URL on the action.
 *
 * Loaders run in the caller's RLS scope (request org context at hook
 * sites, withOrg in the tick) — they never set scope themselves.
 */

export type RegistryEntity = {
  /** Trigger/entity vocabulary name. */
  entity: string;
  /** Fields a condition may read or changed_to may watch. */
  readableFields: string[];
  /** Fields update_field may write — a subset, never arbitrary. */
  writableFields: string[];
  /** Scope attributes the rules matcher understands for this entity. */
  scopeFields: string[];
};

export const AUTOMATION_REGISTRY: RegistryEntity[] = [
  {
    entity: "employment",
    readableFields: ["status", "effective_from", "subsidiary_id", "department_id", "location_id", "position_id", "job_title", "manager_employment_id", "service_start"],
    // No writable fields: employment versions change only through the
    // governed change-request path (service + Flows approval + temporal
    // application). update_field on employment refuses with that remedy
    // rather than writing versions around every invariant.
    writableFields: [],
    scopeFields: ["subsidiaryId", "departmentId", "locationId", "workerType", "positionId"],
  },
  {
    entity: "position",
    readableFields: ["status", "department_id", "location_id", "fte", "filled_count", "headcount"],
    writableFields: [],
    scopeFields: ["subsidiaryId", "departmentId", "locationId"],
  },
  {
    entity: "leave_request",
    readableFields: ["status", "leave_type_id", "starts_on", "ends_on", "hours", "employment_id"],
    writableFields: [],
    scopeFields: ["subsidiaryId", "departmentId", "employmentId"],
  },
  {
    entity: "timesheet_week",
    readableFields: ["status", "week_start", "employee_party_id"],
    writableFields: [],
    scopeFields: ["departmentId", "employmentId"],
  },
  {
    entity: "expense_report",
    readableFields: ["status", "total", "currency", "submitted_by"],
    writableFields: [],
    scopeFields: ["departmentId"],
  },
  {
    entity: "document",
    readableFields: ["kind", "status", "signed", "template_key"],
    writableFields: [],
    scopeFields: [],
  },
  {
    entity: "requisition",
    readableFields: ["status", "position_id", "headcount", "filled_count"],
    writableFields: [],
    scopeFields: ["departmentId", "positionId"],
  },
  {
    entity: "application",
    readableFields: ["stage", "requisition_id"],
    writableFields: [],
    scopeFields: ["departmentId"],
  },
  {
    entity: "review",
    readableFields: ["status", "cycle_id", "overall_rating", "subject_employment_id"],
    writableFields: [],
    scopeFields: ["departmentId"],
  },
  {
    entity: "enrollment",
    readableFields: ["status", "plan_id", "employment_id"],
    writableFields: [],
    scopeFields: ["departmentId", "employmentId"],
  },
];

export function registryEntity(entity: string): RegistryEntity | null {
  return AUTOMATION_REGISTRY.find((entry) => entry.entity === entity) ?? null;
}

export function assertWritableField(entity: string, field: string): void {
  const entry = registryEntity(entity);
  if (!entry) {
    throw new AutomationRegistryError(
      `update_field names unknown entity '${entity}' (known: ${AUTOMATION_REGISTRY.map((e) => e.entity).join(", ")}) — use a registry entity`,
    );
  }
  if (!entry.writableFields.includes(field)) {
    const remedy = entity === "employment"
      ? "employment versions change only through a governed change request — file one instead"
      : `allowlisted fields only (${entry.writableFields.join(", ") || "no writable fields"}), never arbitrary writes`;
    throw new AutomationRegistryError(
      `update_field on ${entity}.${field} is refused: ${remedy}`,
    );
  }
}

export class AutomationRegistryError extends Error {}

/** Resolve a subject to its snapshot. Null when the record is gone. */
export async function loadSubjectSnapshot(
  orgId: string,
  entity: string,
  subjectId: string,
  previous?: Record<string, unknown> | null,
): Promise<SubjectSnapshot | null> {
  const entry = registryEntity(entity);
  if (!entry) {
    throw new AutomationRegistryError(
      `unknown automation entity '${entity}' — use one the registry declares`,
    );
  }
  switch (entity) {
    case "employment": {
      const rows = await db.execute<Record<string, unknown>>(sql`
        select v.status, v.effective_from,
               e.employer_subsidiary_id as subsidiary_id,
               e.service_start,
               a.position_id, a.department_id, a.location_id, a.job_title,
               r.manager_employment_id
          from worker_employments e
          join worker_employment_versions v
            on v.org_id = e.org_id and v.employment_id = e.id
           and v.recorded_until is null
           and v.effective_from <= current_date
           and (v.effective_to is null or v.effective_to > current_date)
          left join employment_assignment_versions a
            on a.org_id = e.org_id and a.employment_id = e.id
           and a.recorded_until is null
           and a.is_primary
           and a.effective_from <= current_date
           and (a.effective_to is null or a.effective_to > current_date)
          left join reporting_relationships r
            on r.org_id = e.org_id and r.employment_id = e.id
           and r.recorded_until is null and r.kind = 'line'
           and r.effective_from <= current_date
           and (r.effective_to is null or r.effective_to > current_date)
         where e.org_id = ${orgId} and e.id = ${subjectId}
         limit 1
      `);
      const row = rows.rows[0];
      if (!row) return null;
      return {
        entity,
        fields: pick(row, entry.readableFields),
        previous: previous ?? null,
        scope: {
          subsidiaryId: row["subsidiary_id"],
          departmentId: row["department_id"],
          locationId: row["location_id"],
          workerType: null,
          positionId: row["position_id"],
        },
      };
    }
    case "leave_request": {
      const rows = await db.execute<Record<string, unknown>>(sql`
        select r.id, r.status, r.leave_type_id, r.starts_on, r.ends_on, r.hours,
               r.employment_id, e.department_id, e.employer_subsidiary_id as subsidiary_id
          from hrm_leave_requests r
          left join employment_assignment_versions e
            on e.org_id = r.org_id and e.employment_id = r.employment_id
           and e.recorded_until is null and e.is_primary
           and e.effective_from <= current_date
           and (e.effective_to is null or e.effective_to > current_date)
         where r.org_id = ${orgId} and r.id = ${subjectId}
         limit 1
      `);
      const row = rows.rows[0];
      if (!row) return null;
      return {
        entity,
        fields: pick(row, entry.readableFields),
        previous: previous ?? null,
        scope: {
          subsidiaryId: row["subsidiary_id"],
          departmentId: row["department_id"],
          employmentId: row["employment_id"],
        },
      };
    }
    case "timesheet_week": {
      const rows = await db.execute<Record<string, unknown>>(sql`
        select id, status, week_start, employee_party_id
          from timesheet_weeks
         where org_id = ${orgId} and id = ${subjectId}
         limit 1
      `);
      const row = rows.rows[0];
      if (!row) return null;
      return {
        entity,
        fields: pick(row, entry.readableFields),
        previous: previous ?? null,
        scope: {},
      };
    }
    case "document": {
      const rows = await db.execute<Record<string, unknown>>(sql`
        select id, kind, status
          from documents
         where org_id = ${orgId} and id = ${subjectId}
         limit 1
      `);
      const row = rows.rows[0];
      if (!row) return null;
      return { entity, fields: pick(row, entry.readableFields), previous: previous ?? null, scope: {} };
    }
    default: {
      const table = genericEntityTable(entity);
      const rows = await db.execute<Record<string, unknown>>(sql`
        select * from ${sql.identifier(table)}
         where org_id = ${orgId} and id = ${subjectId}
         limit 1
      `);
      const row = rows.rows[0];
      if (!row) return null;
      return { entity, fields: pick(row, entry.readableFields), previous: previous ?? null, scope: {} };
    }
  }
}

function genericEntityTable(entity: string): string {
  switch (entity) {
    case "position":
      return "positions";
    case "expense_report":
      return "documents";
    case "requisition":
      return "hrm_requisitions";
    case "application":
      return "hrm_applications";
    case "review":
      return "hrm_reviews";
    case "enrollment":
      return "hrm_benefit_enrollments";
    default:
      throw new AutomationRegistryError(`no loader table for entity '${entity}'`);
  }
}

function pick(row: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = row[field] ?? null;
  return out;
}
