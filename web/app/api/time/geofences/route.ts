import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  lockProjectForScope,
  ScopeNotFoundError,
  subsidiaryVisibleFilter,
} from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { guardSubsidiaryScope, type Authz } from '../../../../lib/authz'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { FieldTimeError } from '@openbooks/engine/src/hrm/field-time/errors.ts'

export const runtime = 'nodejs'

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status })
}

/** Record-level scope denials answer exactly like not-found (a uniform 404). */
function hidden() {
  return NextResponse.json({ error: 'not found' }, { status: 404 })
}

type SqlExecutor = Pick<typeof db, 'execute'>

/** One circle and one polygon per project — never two sources of truth. */
async function refuseDuplicate(exec: SqlExecutor, orgId: string, projectId: string, kind: string, exceptId?: string) {
  const dup = (await exec.execute<{ id: string }>(sql`
    select id from project_geofences
     where org_id = ${orgId} and project_id = ${projectId} and kind = ${kind}
       ${exceptId ? sql`and id <> ${exceptId}` : sql``} limit 1`)).rows[0]
  if (dup) {
    throw new FieldTimeError(
      'geofence_duplicate',
      `This project already has an active ${kind} geofence — edit it instead of adding a second one`,
    )
  }
}

const pointSchema = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })

const SHAPE_NEEDS = 'A geofence needs the project and circle or polygon shape'
const UNKNOWN_PROJECT = 'Unknown project — pick it from the list'
const DELETE_NEEDS = 'Delete needs the geofence id'

const geofenceSchema = z.object({
  action: z.literal('save').optional(),
  id: z.string().refine((v) => isUuid(v), 'Unknown geofence — reload and retry').optional(),
  projectId: z.string({ error: SHAPE_NEEDS }).refine((v) => isUuid(v), UNKNOWN_PROJECT),
  kind: z.enum(['circle', 'polygon'], { error: SHAPE_NEEDS }),
  center: pointSchema.nullable().optional(),
  radiusM: z.number().int().min(10).max(100000).nullable().optional(),
  polygon: z.array(pointSchema).min(3).max(64).nullable().optional(),
  isActive: z.boolean().optional(),
})

/**
 * Save or retire. Delete names itself; a save carries the shape. The
 * circle/polygon completeness checks stay in the handler so each one
 * names the missing part rather than failing the whole union.
 */
const geofenceBody = z.union([
  z.object({
    action: z.literal('delete'),
    id: z.string({ error: DELETE_NEEDS }).refine((v) => isUuid(v), DELETE_NEEDS),
  }),
  geofenceSchema,
])

/** GET → active geofences (?projectId=), visible only under the caller's subsidiaries. */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('time.manage', 'fieldTimeGeofence')
  if (gate instanceof NextResponse) return gate
  const url = new URL(req.url)
  const projectId = url.searchParams.get('projectId')
  // Only an explicit null is unrestricted — an absent (undefined) scope
  // fails closed to an empty set. Nullish coalescing would collapse null
  // into the empty set, so the undefined check is explicit.
  const scopedGateForGet: Authz =
    gate.allowedSubsidiaryIds === undefined
      ? { ...gate, allowedSubsidiaryIds: new Set<string>() }
      : gate
  const scope = scopedGateForGet.allowedSubsidiaryIds
  // A fence belongs to its project's legal entity: a caller restricted to
  // one subsidiary never enumerates another's fences. A fence whose project
  // row is gone carries no subsidiary and fails closed for restricted
  // callers, exactly like the save/delete record gate below.
  const rows = (await db.execute(sql`
    select g.id::text as id, g.project_id::text as "projectId", p.name as "projectName",
           g.kind, g.center, g.radius_m as "radiusM", g.polygon, g.is_active as "isActive"
      from project_geofences g
      left join projects p on p.org_id = g.org_id and p.id = g.project_id
     where g.org_id = ${gate.user.orgId}
       ${projectId ? sql`and g.project_id = ${projectId}` : sql``}
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, scope)}
     order by p.name, g.kind`)).rows
  return NextResponse.json({ geofences: rows })
}

/** POST → declare a geofence. PUT/PATCH with id edits; DELETE with id retires. */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('time.manage', 'fieldTimeGeofence')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  // Only an explicit null is unrestricted — an absent (undefined) scope
  // fails closed to an empty set, so a caller that forgot to resolve the
  // actor's scope sees and writes nothing rather than everything. The
  // undefined check is explicit: nullish coalescing would collapse the
  // unrestricted null into the empty set.
  const scopedGate: Authz =
    gate.allowedSubsidiaryIds === undefined
      ? { ...gate, allowedSubsidiaryIds: new Set<string>() }
      : gate
  const scope = scopedGate.allowedSubsidiaryIds
  const unrestricted = scope === null

  const parsedBody = await parseJsonBody(req, geofenceBody, { status: 422 });
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  try {
    if (body.action === 'delete') {
      const outcome = await db.transaction(async (tx) => {
        // Lock the fence and recheck scope inside the write transaction, so
        // a concurrent project rehome cannot move the delete onto another
        // subsidiary between the check and the write.
        const row = (await tx.execute<{ subsidiaryId: string | null }>(sql`
          select p.subsidiary_id as "subsidiaryId"
            from project_geofences g
            left join projects p on p.org_id = g.org_id and p.id = g.project_id
           where g.org_id = ${user.orgId} and g.id = ${body.id}
           for update of g`)).rows[0]
        if (!row) return 'unknown' as const
        if (guardSubsidiaryScope(scopedGate, row.subsidiaryId)) return 'hidden' as const
        const moved = (await tx.execute(sql`
          delete from project_geofences where org_id = ${user.orgId} and id = ${body.id}`)).rowCount ?? 0
        if (moved !== 1) {
          throw new FieldTimeError('geofence_not_stored', 'The geofence is unknown in this organization — reload and retry')
        }
        return 'ok' as const
      })
      if (outcome === 'ok') return NextResponse.json({ ok: true })
      if (outcome === 'hidden') return hidden()
      return bad('The geofence is unknown in this organization — reload and retry')
    }
    const fence = body
    if (fence.kind === 'circle' && (!fence.center || !fence.radiusM)) {
      return bad('A circle geofence needs a center and a radius in metres')
    }
    if (fence.kind === 'polygon' && !fence.polygon) {
      return bad('A polygon geofence needs at least three corners')
    }
    const id = fence.id ?? null
    const outcome = await db.transaction(async (tx) => {
      // Scope the TARGET project first and under its row lock: missing and
      // hidden answer the same 404 for a restricted caller, so probing a
      // project id never oracles whether another subsidiary uses it. An
      // unrestricted caller keeps the existing unknown-project remedy.
      try {
        await lockProjectForScope(tx, user.orgId, fence.projectId, scope)
      } catch (error) {
        if (error instanceof ScopeNotFoundError) return unrestricted ? 'project-unknown' as const : 'hidden' as const
        throw error
      }
      if (id) {
        // An edit is fenced on BOTH ends: the saved fence's existing
        // project must already be visible, and the declared projectId was
        // just proven visible above — so neither the fence's home nor a
        // probed id can oracle another subsidiary's projects.
        const existing = (await tx.execute<{ subsidiaryId: string | null }>(sql`
          select p.subsidiary_id as "subsidiaryId"
            from project_geofences g
            left join projects p on p.org_id = g.org_id and p.id = g.project_id
           where g.org_id = ${user.orgId} and g.id = ${id}
           for update of g`)).rows[0]
        if (!existing) return unrestricted ? 'fence-unknown' as const : 'hidden' as const
        if (guardSubsidiaryScope(scopedGate, existing.subsidiaryId)) return 'hidden' as const
      }
      await refuseDuplicate(tx, user.orgId, fence.projectId, fence.kind, id ?? undefined)
      if (id) {
        const moved = (await tx.execute(sql`
          update project_geofences
             set center = ${fence.center ? JSON.stringify(fence.center) : null}::jsonb,
                 radius_m = ${fence.radiusM ?? null},
                 polygon = ${fence.polygon ? JSON.stringify(fence.polygon) : null}::jsonb,
                 is_active = ${fence.isActive !== false},
                 updated_at = now(), updated_by = ${user.id}
           where org_id = ${user.orgId} and id = ${id}`)).rowCount ?? 0
        if (moved !== 1) {
          throw new FieldTimeError('geofence_not_stored', 'The geofence is unknown in this organization — reload and retry')
        }
        return { id } as const
      }
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into project_geofences
          (org_id, project_id, kind, center, radius_m, polygon, is_active, created_by, updated_by)
        values
          (${user.orgId}, ${fence.projectId}, ${fence.kind},
           ${fence.center ? JSON.stringify(fence.center) : null}::jsonb,
           ${fence.radiusM ?? null},
           ${fence.polygon ? JSON.stringify(fence.polygon) : null}::jsonb,
           ${fence.isActive !== false}, ${user.id}, ${user.id})
        returning id::text as id`)).rows[0]
      if (!inserted) throw new FieldTimeError('geofence_not_stored', 'The geofence was not stored — no row was written; retry')
      return { id: inserted.id } as const
    })
    if (typeof outcome === 'string') {
      if (outcome === 'hidden') return hidden()
      if (outcome === 'project-unknown') return bad(UNKNOWN_PROJECT)
      return bad('The geofence is unknown in this organization — reload and retry')
    }
    return NextResponse.json({ id: outcome.id })
  } catch (error) {
    if (error instanceof FieldTimeError) return bad(error.message)
    throw error
  }
}
