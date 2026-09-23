import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { validateFieldTimeSettings } from '@openbooks/engine/src/hrm/field-time/settings.ts'
import { FieldTimeError } from '@openbooks/engine/src/hrm/field-time/errors.ts'
import { fieldTimeSettingsBody, normalizeFieldTimeSettingsBody } from '../../../../lib/field-time/settings-body'

export const runtime = 'nodejs'

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status })
}

/**
 * Field-time rules (Timesheets setup): rounding, break, auto-close,
 * signature, equipment tolerance, photo. Stored on
 * orgs.settings->'fieldTime' — one source of truth, read by every
 * clock/crew path. Every rule is required; the service refuses without
 * them rather than guessing.
 */
export async function GET() {
  const gate = await guardFeaturePermission('time.manage', 'fieldTime')
  if (gate instanceof NextResponse) return gate
  const row = (await db.execute<{ settings: unknown }>(sql`
    select settings->'fieldTime' as settings from orgs where id = ${gate.user.orgId}`)).rows[0]
  return NextResponse.json({ settings: row?.settings ?? null })
}

export async function PUT(req: Request) {
  const gate = await guardFeaturePermission('time.manage', 'fieldTime')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  const parsedBody = await parseJsonBody(req, fieldTimeSettingsBody);
  if (!parsedBody.ok) return parsedBody.response;
  try {
    // validateFieldTimeSettings refuses missing or undeclared rules by
    // name before anything is stored — the settings write and the
    // service reads agree on exactly this shape. Explicit nulls arrive
    // normalized to absent (see settings-body), so a cleared rule gets
    // the same named refusal as a never-set one.
    const settings = validateFieldTimeSettings(normalizeFieldTimeSettingsBody(parsedBody.data))
    const moved = (await db.execute(sql`
      update orgs
         set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{fieldTime}', ${JSON.stringify({
           roundingIncrement: settings.rounding.incrementMinutes,
           roundingMode: settings.rounding.mode,
           unpaidBreakMinutes: settings.unpaidBreakMinutes,
           autoCloseHours: settings.autoCloseHours,
           signatureRequired: settings.signatureRequired,
           equipmentToleranceHours: settings.equipmentToleranceHours,
           photoRequired: settings.photoRequired,
         })}::jsonb),
             updated_at = now()
       where id = ${user.orgId}`)).rowCount ?? 0
    if (moved !== 1) return bad('The organization is unknown — reload and retry')
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof FieldTimeError) return bad(error.message)
    throw error
  }
}
