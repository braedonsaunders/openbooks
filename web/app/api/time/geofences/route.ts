import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { FieldTimeError } from '@openbooks/engine/src/hrm/field-time/errors.ts'

export const runtime = 'nodejs'

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status })
}

/** One circle and one polygon per project — never two sources of truth. */
async function refuseDuplicate(orgId: string, projectId: string, kind: string, exceptId?: string) {
  const dup = (await db.execute<{ id: string }>(sql`
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

const geofenceSchema = z.object({
  projectId: z.string().min(1),
  kind: z.enum(['circle', 'polygon']),
  center: pointSchema.nullable().optional(),
  radiusM: z.number().int().min(10).max(100000).nullable().optional(),
  polygon: z.array(pointSchema).min(3).max(64).nullable().optional(),
  isActive: z.boolean().optional(),
})

/** GET → active geofences (?projectId=). */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('time.manage', 'fieldTimeGeofence')
  if (gate instanceof NextResponse) return gate
  const url = new URL(req.url)
  const projectId = url.searchParams.get('projectId')
  const rows = (await db.execute(sql`
    select g.id::text as id, g.project_id::text as "projectId", p.name as "projectName",
           g.kind, g.center, g.radius_m as "radiusM", g.polygon, g.is_active as "isActive"
      from project_geofences g
      left join projects p on p.org_id = g.org_id and p.id = g.project_id
     where g.org_id = ${gate.user.orgId}
       ${projectId ? sql`and g.project_id = ${projectId}` : sql``}
     order by p.name, g.kind`)).rows
  return NextResponse.json({ geofences: rows })
}

/** POST → declare a geofence. PUT/PATCH with id edits; DELETE with id retires. */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('time.manage', 'fieldTimeGeofence')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>
  try {
    if (body.action === 'delete') {
      if (typeof body.id !== 'string' || !isUuid(body.id)) return bad('Delete needs the geofence id')
      const moved = (await db.execute(sql`
        delete from project_geofences where org_id = ${user.orgId} and id = ${body.id}`)).rowCount ?? 0
      if (moved !== 1) return bad('The geofence is unknown in this organization — reload and retry')
      return NextResponse.json({ ok: true })
    }
    const parsed = geofenceSchema.safeParse(body)
    if (!parsed.success) return bad('A geofence needs the project and circle or polygon shape')
    const fence = parsed.data
    if (!isUuid(fence.projectId)) return bad('Unknown project — pick it from the list')
    const project = (await db.execute(sql`select id from projects where org_id = ${user.orgId} and id = ${fence.projectId}`)).rows[0]
    if (!project) return bad('Unknown project — pick it from the list')
    if (fence.kind === 'circle' && (!fence.center || !fence.radiusM)) {
      return bad('A circle geofence needs a center and a radius in metres')
    }
    if (fence.kind === 'polygon' && !fence.polygon) {
      return bad('A polygon geofence needs at least three corners')
    }
    const id = typeof body.id === 'string' && isUuid(body.id) ? (body.id as string) : null
    await refuseDuplicate(user.orgId, fence.projectId, fence.kind, id ?? undefined)
    if (id) {
      const moved = (await db.execute(sql`
        update project_geofences
           set center = ${fence.center ? JSON.stringify(fence.center) : null}::jsonb,
               radius_m = ${fence.radiusM ?? null},
               polygon = ${fence.polygon ? JSON.stringify(fence.polygon) : null}::jsonb,
               is_active = ${fence.isActive !== false},
               updated_at = now(), updated_by = ${user.id}
         where org_id = ${user.orgId} and id = ${id}`)).rowCount ?? 0
      if (moved !== 1) return bad('The geofence is unknown in this organization — reload and retry')
      return NextResponse.json({ id })
    }
    const inserted = (await db.execute<{ id: string }>(sql`
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
    return NextResponse.json({ id: inserted.id })
  } catch (error) {
    if (error instanceof FieldTimeError) return bad(error.message)
    throw error
  }
}
