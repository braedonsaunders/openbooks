import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import {
  lockProjectForScope,
  ScopeNotFoundError,
  subsidiaryScopeAllows,
  subsidiaryVisibleFilter,
} from "../../organization/subsidiary-scope.ts";
import { FieldTimeError } from "./errors.ts";

export type GeofencePoint = { lat: number; lng: number };

export type ProjectGeofenceBody =
  | { action: "delete"; id: string }
  | {
      action?: "save";
      id?: string;
      projectId: string;
      kind: "circle" | "polygon";
      center?: GeofencePoint | null;
      radiusM?: number | null;
      polygon?: GeofencePoint[] | null;
      isActive?: boolean;
    };

type Scope = ReadonlySet<string> | null | undefined;

/** Validate the shape required by the selected geofence kind at every write boundary. */
export function assertProjectGeofenceShape(
  fence: Exclude<ProjectGeofenceBody, { action: "delete" }>,
): void {
  if (fence.kind === "circle" && (!fence.center || !fence.radiusM)) {
    throw new FieldTimeError(
      "geofence_shape_incomplete",
      "A circle geofence needs a center and a radius in metres",
    );
  }
  if (fence.kind === "polygon" && !fence.polygon) {
    throw new FieldTimeError(
      "geofence_shape_incomplete",
      "A polygon geofence needs at least three corners",
    );
  }
}

function effectiveScope(scope: Scope): ReadonlySet<string> | null {
  return scope === undefined ? new Set<string>() : scope;
}

export async function listProjectGeofences(
  orgId: string,
  projectId: string | null,
  allowedSubsidiaryIds: Scope,
) {
  const scope = effectiveScope(allowedSubsidiaryIds);
  return db.execute(
    sql`
    select g.id::text as id, g.project_id::text as "projectId", p.name as "projectName",
           g.kind, g.center, g.radius_m as "radiusM", g.polygon, g.is_active as "isActive"
      from project_geofences g
      left join projects p on p.org_id = g.org_id and p.id = g.project_id
     where g.org_id = ${orgId}
       ${projectId ? sql`and g.project_id = ${projectId}` : sql``}
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, scope)}
     order by p.name, g.kind`,
    "objects",
  );
}

/** Lock and recheck the project's subsidiary before retiring its geofence. */
export async function deleteProjectGeofence(input: {
  orgId: string;
  id: string;
  allowedSubsidiaryIds: Scope;
}): Promise<"ok" | "hidden" | "unknown"> {
  const scope = effectiveScope(input.allowedSubsidiaryIds);
  return db.transaction(async (tx) => {
    const row = (
      await tx.execute<{ subsidiaryId: string | null }>(
        sql`
      select p.subsidiary_id as "subsidiaryId"
        from project_geofences g
        left join projects p on p.org_id = g.org_id and p.id = g.project_id
       where g.org_id = ${input.orgId} and g.id = ${input.id}
       for update of g`,
        "objects",
      )
    )[0];
    if (!row) return "unknown";
    if (!subsidiaryScopeAllows(scope, row.subsidiaryId)) return "hidden";
    const moved =
      (
        await tx.execute<never>(sql`
      delete from project_geofences where org_id = ${input.orgId} and id = ${input.id}`)
      ).rowCount ?? 0;
    if (moved !== 1) {
      throw new FieldTimeError(
        "geofence_not_stored",
        "The geofence is unknown in this organization — reload and retry",
      );
    }
    return "ok";
  });
}

export async function saveProjectGeofence(input: {
  orgId: string;
  actorUserId: string;
  allowedSubsidiaryIds: Scope;
  fence: Exclude<ProjectGeofenceBody, { action: "delete" }>;
}): Promise<"hidden" | "project-unknown" | "fence-unknown" | { id: string }> {
  const scope = effectiveScope(input.allowedSubsidiaryIds);
  const unrestricted = scope === null;
  const { fence } = input;

  return db.transaction(async (tx) => {
    // Lock the target project before checking the saved fence to prevent scope changes between authorization and mutation.
    try {
      await lockProjectForScope(tx, input.orgId, fence.projectId, scope);
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return unrestricted ? "project-unknown" : "hidden";
      throw error;
    }

    if (fence.id) {
      const existing = (
        await tx.execute<{ subsidiaryId: string | null }>(
          sql`
        select p.subsidiary_id as "subsidiaryId"
          from project_geofences g
          left join projects p on p.org_id = g.org_id and p.id = g.project_id
         where g.org_id = ${input.orgId} and g.id = ${fence.id}
         for update of g`,
          "objects",
        )
      )[0];
      if (!existing) return unrestricted ? "fence-unknown" : "hidden";
      if (!subsidiaryScopeAllows(scope, existing.subsidiaryId)) return "hidden";
    }

    const duplicate = (
      await tx.execute<{ id: string }>(
        sql`
      select id from project_geofences
       where org_id = ${input.orgId} and project_id = ${fence.projectId} and kind = ${fence.kind}
         ${fence.id ? sql`and id <> ${fence.id}` : sql``} limit 1`,
        "objects",
      )
    )[0];
    if (duplicate) {
      throw new FieldTimeError(
        "geofence_duplicate",
        `This project already has an active ${fence.kind} geofence — edit it instead of adding a second one`,
      );
    }

    if (fence.id) {
      const moved =
        (
          await tx.execute<never>(sql`
        update project_geofences
           set center = ${fence.center ? JSON.stringify(fence.center) : null}::jsonb,
               radius_m = ${fence.radiusM ?? null},
               polygon = ${fence.polygon ? JSON.stringify(fence.polygon) : null}::jsonb,
               is_active = ${fence.isActive !== false},
               updated_at = now(), updated_by = ${input.actorUserId}
         where org_id = ${input.orgId} and id = ${fence.id}`)
        ).rowCount ?? 0;
      if (moved !== 1) {
        throw new FieldTimeError(
          "geofence_not_stored",
          "The geofence is unknown in this organization — reload and retry",
        );
      }
      return { id: fence.id };
    }

    const inserted = (
      await tx.execute<{ id: string }>(
        sql`
      insert into project_geofences
        (org_id, project_id, kind, center, radius_m, polygon, is_active, created_by, updated_by)
      values
        (${input.orgId}, ${fence.projectId}, ${fence.kind},
         ${fence.center ? JSON.stringify(fence.center) : null}::jsonb,
         ${fence.radiusM ?? null},
         ${fence.polygon ? JSON.stringify(fence.polygon) : null}::jsonb,
         ${fence.isActive !== false}, ${input.actorUserId}, ${input.actorUserId})
      returning id::text as id`,
        "objects",
      )
    )[0];
    if (!inserted)
      throw new FieldTimeError(
        "geofence_not_stored",
        "The geofence was not stored — no row was written; retry",
      );
    return { id: inserted.id };
  });
}
