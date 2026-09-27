import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { parseJsonBody, uuidId } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { registerKiosk, revokeKiosk, setWorkerPin } from '@openbooks/engine/src/hrm/field-time/kiosk.ts'
import { FieldTimeError } from '@openbooks/engine/src/hrm/field-time/errors.ts'
import { ScopeNotFoundError, UnrestrictedScopeError } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { subsidiaryVisibleFilter } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status })
}

/** GET → kiosk devices (never token hashes — those never leave the vault). */
async function legacyGET(request: Request, ctx: { params: Promise<unknown> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  const { db } = await import('@openbooks/engine/src/platform/db.ts')
  const { sql } = await import('drizzle-orm')
  const visibleProject = gate.allowedSubsidiaryIds === null
    ? sql``
    : sql`and project_id is not null and exists (
        select 1 from projects p
         where p.org_id = time_kiosks.org_id and p.id = time_kiosks.project_id
           and ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds)}
      )`
  const rows = (await db.execute(sql`
    select id::text as id, name, location_id::text as "locationId",
           project_id::text as "projectId", pin_required as "pinRequired",
           photo_required as "photoRequired", last_seen_at::text as "lastSeenAt",
           is_active as "isActive"
      from time_kiosks where org_id = ${gate.user.orgId} ${visibleProject} order by name`)).rows
  return NextResponse.json({ kiosks: rows })
}

const REGISTER_NEEDS = 'Register needs a kiosk name'
const REVOKE_NEEDS = 'Revoke needs the kiosk id'
const PIN_NEEDS = 'Set-pin needs the worker and a PIN'

/** An optional reference that the picker may send back as '' or null. */
const optionalRef = z.union([uuidId, z.literal(''), z.null()]).optional()

const registerSchema = z.object({
  action: z.literal('register').optional(),
  name: z.string({ error: REGISTER_NEEDS }).min(1, REGISTER_NEEDS).max(120),
  locationId: optionalRef,
  projectId: optionalRef,
  pinRequired: z.boolean().optional(),
  photoRequired: z.boolean().optional(),
})

/**
 * One body for the three device actions. Register carries no action
 * because the kiosk list POSTs a kiosk; revoke and set-pin name
 * themselves. Each branch declares its own refusal so the setup screen
 * shows the operator what is missing.
 */
const kioskBody = z.union([
  z.object({ action: z.literal('revoke'), kioskId: z.string({ error: REVOKE_NEEDS }).refine((v) => isUuid(v), REVOKE_NEEDS) }),
  z.object({
    action: z.literal('set-pin'),
    employeePartyId: z.string({ error: PIN_NEEDS }).refine((v) => isUuid(v), PIN_NEEDS),
    pin: z.string({ error: PIN_NEEDS }).min(1, PIN_NEEDS),
  }),
  registerSchema,
])

/**
 * POST register {name,...} → the kiosk plus its raw device token, shown
 * once and never stored. POST revoke {kioskId} retires the link.
 * POST set-pin {employeePartyId, pin} sets or resets a worker PIN.
 */
async function legacyPOST(req: Request, ctx: { params: Promise<unknown> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  const { user } = gate

  const parsedBody = await parseJsonBody(req, kioskBody, { status: 422 });
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  try {
    if (body.action === 'revoke') {
      await revokeKiosk({ orgId: user.orgId, kioskId: body.kioskId, actorUserId: user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds })
      return NextResponse.json({ ok: true })
    }
    if (body.action === 'set-pin') {
      await setWorkerPin({ orgId: user.orgId, actorUserId: user.id, employeePartyId: body.employeePartyId, pin: body.pin, allowedSubsidiaryIds: gate.allowedSubsidiaryIds })
      return NextResponse.json({ ok: true })
    }
    const input = body
    const { kiosk, token } = await registerKiosk({
      orgId: user.orgId,
      actorUserId: user.id,
      name: input.name,
      locationId: input.locationId || null,
      projectId: input.projectId || null,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      pinRequired: input.pinRequired,
      photoRequired: input.photoRequired,
    })
    // The raw token leaves here once. Lose it and revoke + re-register:
    // it is hashed in storage and cannot be shown again.
    return NextResponse.json({ kiosk, token })
  } catch (error) {
    if (error instanceof FieldTimeError) return bad(error.message)
    if (error instanceof ScopeNotFoundError) return bad('not found', 404)
    if (error instanceof UnrestrictedScopeError) return bad('requires unrestricted subsidiary access', 403)
    throw error
  }
}

export const GET = defineRoute({
  permission: 'time.kiosk.manage', feature: 'fieldTime',

  handler: ({ request, params, authz }) => legacyGET(request, { params: Promise.resolve(params) }, authz),
});

export const POST = defineRoute({
  permission: 'time.kiosk.manage', feature: 'fieldTime',

  handler: ({ request, params, authz }) => legacyPOST(request, { params: Promise.resolve(params) }, authz),
});
