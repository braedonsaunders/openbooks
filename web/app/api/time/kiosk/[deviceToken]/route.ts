import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { isUuid } from '../../../../../lib/list-params'
import { identifyByPin, kioskClockEvent, resolveKioskByToken } from '@openbooks/engine/src/hrm/field-time/kiosk.ts'
import { FieldTimeError } from '@openbooks/engine/src/hrm/field-time/errors.ts'

export const runtime = 'nodejs'

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status })
}

/**
 * Device-token kiosk routes — no session. The bearer token in the path
 * authenticates the DEVICE; every action re-verifies the worker PIN
 * (rate-limited with lockout in the service). Unknown or retired
 * tokens 404 like any hidden module.
 */
async function kiosk(deviceToken: string) {
  try {
    return await resolveKioskByToken(deviceToken)
  } catch (error) {
    if (error instanceof FieldTimeError) return bad(error.message, 404)
    throw error
  }
}

const identifySchema = z.object({
  action: z.literal('identify'),
  employeePartyId: z.string().min(1),
  pin: z.string().min(1),
})

const eventSchema = z.object({
  action: z.literal('event'),
  employeePartyId: z.string().min(1),
  pin: z.string().min(1),
  kind: z.enum(['clock_in', 'clock_out', 'break_start', 'break_end', 'switch']),
  occurredAt: z.string().min(1),
  projectId: z.string().nullable().optional(),
  projectTaskId: z.string().nullable().optional(),
  costCodeRef: z.string().max(80).nullable().optional(),
  geo: z.object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracyM: z.number().min(0).nullable().optional(),
  }).nullable().optional(),
  photoFileId: z.string().nullable().optional(),
  clientEventId: z.string().min(1),
})

/** GET → public kiosk descriptor (name, project pinning, switches). */
export async function GET(_req: Request, ctx: { params: Promise<{ deviceToken: string }> }) {
  const { deviceToken } = await ctx.params
  const found = await kiosk(deviceToken)
  if (found instanceof NextResponse) return found
  return NextResponse.json({
    name: found.name,
    projectId: found.projectId,
    pinRequired: found.pinRequired,
    photoRequired: found.photoRequired,
  })
}

const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
const PHOTO_MAX_BYTES = 10 * 1024 * 1024

/**
 * Multipart photo capture from the kiosk tile: the device token (not a
 * login) authorizes the write into the org's field-time folder, and the
 * clock service verifies the file belongs to the org on the event.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ deviceToken: string }> }) {
  const { deviceToken } = await ctx.params
  const found = await kiosk(deviceToken)
  if (found instanceof NextResponse) return found
  const form = await req.formData().catch(() => null)
  if (!form) return bad('expected multipart/form-data', 400)
  const file = form.get('file')
  if (!(file instanceof File)) return bad('A photo file is required — capture a photo and retry', 400)
  const contentType = file.type.split(';')[0]!.trim().toLowerCase()
  if (!PHOTO_TYPES.has(contentType)) return bad(`Unsupported photo type ${contentType || 'unknown'} — use JPEG, PNG, WebP or HEIC`, 415)
  if (file.size > PHOTO_MAX_BYTES || file.size === 0) return bad('The photo must be non-empty and under 10 MB', 413)
  try {
    const { ensureOrgClockPhotoFolder } = await import('@openbooks/engine/src/hrm/field-time/photos.ts')
    const { createFile } = await import('../../../../../lib/file-cabinet')
    const folderId = await ensureOrgClockPhotoFolder(found.orgId)
    const meta = await createFile({
      orgId: found.orgId,
      folderId,
      filename: file.name || 'kiosk-photo',
      contentType,
      bytes: Buffer.from(await file.arrayBuffer()),
      createdBy: null,
    })
    return NextResponse.json({ fileId: meta.id }, { status: 201 })
  } catch (error) {
    if (error instanceof FieldTimeError) return bad(error.message)
    throw error
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ deviceToken: string }> }) {
  const { deviceToken } = await ctx.params
  const found = await kiosk(deviceToken)
  if (found instanceof NextResponse) return found

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>
  try {
    if (body.action === 'identify') {
      const parsed = identifySchema.safeParse(body)
      if (!parsed.success || !isUuid(parsed.data.employeePartyId)) return bad('Identify needs the worker and a PIN')
      await identifyByPin({ kiosk: found, employeePartyId: parsed.data.employeePartyId, pin: parsed.data.pin })
      return NextResponse.json({ ok: true })
    }
    if (body.action === 'event') {
      const parsed = eventSchema.safeParse(body)
      if (!parsed.success) return bad('The kiosk event needs the worker, PIN, kind, occurredAt and clientEventId')
      const event = parsed.data
      if (!isUuid(event.employeePartyId)) return bad('Unknown worker — search by name and retry')
      // The PIN is verified on every event: a kiosk left unattended never
      // stays signed in as the last worker.
      await identifyByPin({ kiosk: found, employeePartyId: event.employeePartyId, pin: event.pin })
      for (const [key, value] of [
        ['projectId', event.projectId],
        ['projectTaskId', event.projectTaskId],
        ['photoFileId', event.photoFileId],
      ] as const) {
        if (value != null && value !== '' && !isUuid(value)) {
          throw new FieldTimeError('invalid_ref', `The kiosk event's ${key} is not a valid id — pick it from the picker and retry`)
        }
      }
      const result = await kioskClockEvent({
        kiosk: found,
        employeePartyId: event.employeePartyId,
        kind: event.kind,
        occurredAt: event.occurredAt,
        projectId: event.projectId ?? null,
        projectTaskId: event.projectTaskId ?? null,
        costCodeRef: event.costCodeRef?.trim() ? event.costCodeRef.trim() : null,
        geo: event.geo ?? null,
        photoFileId: event.photoFileId ?? null,
        clientEventId: event.clientEventId,
      })
      return NextResponse.json(result)
    }
    return bad('Unknown kiosk action — use identify or event')
  } catch (error) {
    if (error instanceof FieldTimeError) return bad(error.message)
    throw error
  }
}

