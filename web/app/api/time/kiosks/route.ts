import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { registerKiosk, revokeKiosk, setWorkerPin } from '@openbooks/engine/src/hrm/field-time/kiosk.ts'
import { FieldTimeError } from '@openbooks/engine/src/hrm/field-time/errors.ts'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status })
}

/** GET → kiosk devices (never token hashes — those never leave the vault). */
export async function GET() {
  const gate = await guardFeaturePermission('time.kiosk.manage', 'fieldTimeKiosk')
  if (gate instanceof NextResponse) return gate
  const { db } = await import('@openbooks/engine/src/platform/db.ts')
  const { sql } = await import('drizzle-orm')
  const rows = (await db.execute(sql`
    select id::text as id, name, location_id::text as "locationId",
           project_id::text as "projectId", pin_required as "pinRequired",
           photo_required as "photoRequired", last_seen_at::text as "lastSeenAt",
           is_active as "isActive"
      from time_kiosks where org_id = ${gate.user.orgId} order by name`)).rows
  return NextResponse.json({ kiosks: rows })
}

const registerSchema = z.object({
  name: z.string().min(1).max(120),
  locationId: z.string().nullable().optional(),
  projectId: z.string().nullable().optional(),
  pinRequired: z.boolean().optional(),
  photoRequired: z.boolean().optional(),
})

const pinSchema = z.object({
  employeePartyId: z.string().min(1),
  pin: z.string().min(1),
})

/**
 * POST register {name,...} → the kiosk plus its raw device token, shown
 * once and never stored. POST revoke {kioskId} retires the link.
 * POST set-pin {employeePartyId, pin} sets or resets a worker PIN.
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('time.kiosk.manage', 'fieldTimeKiosk')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>
  try {
    if (body.action === 'revoke') {
      if (typeof body.kioskId !== 'string' || !isUuid(body.kioskId)) return bad('Revoke needs the kiosk id')
      await revokeKiosk(user.orgId, body.kioskId, user.id)
      return NextResponse.json({ ok: true })
    }
    if (body.action === 'set-pin') {
      const parsed = pinSchema.safeParse(body)
      if (!parsed.success || !isUuid(parsed.data.employeePartyId)) return bad('Set-pin needs the worker and a PIN')
      await setWorkerPin({ orgId: user.orgId, actorUserId: user.id, employeePartyId: parsed.data.employeePartyId, pin: parsed.data.pin })
      return NextResponse.json({ ok: true })
    }
    const parsed = registerSchema.safeParse(body)
    if (!parsed.success) return bad('Register needs a kiosk name')
    const input = parsed.data
    if (input.locationId != null && input.locationId !== '' && !isUuid(input.locationId)) return bad('Unknown location — pick it from the list')
    if (input.projectId != null && input.projectId !== '' && !isUuid(input.projectId)) return bad('Unknown project — pick it from the list')
    const { kiosk, token } = await registerKiosk({
      orgId: user.orgId,
      actorUserId: user.id,
      name: input.name,
      locationId: input.locationId ?? null,
      projectId: input.projectId ?? null,
      pinRequired: input.pinRequired,
      photoRequired: input.photoRequired,
    })
    // The raw token leaves here once. Lose it and revoke + re-register:
    // it is hashed in storage and cannot be shown again.
    return NextResponse.json({ kiosk, token })
  } catch (error) {
    if (error instanceof FieldTimeError) return bad(error.message)
    throw error
  }
}
