import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { myClockDay, resolveOwnParty } from '@openbooks/engine/src/hrm/field-time/reads.ts'
import { recordClockEvent, replayClockEvents, type RecordClockInput } from '@openbooks/engine/src/hrm/field-time/clock.ts'
import { FieldTimeError } from '@openbooks/engine/src/hrm/field-time/errors.ts'

export const runtime = 'nodejs'

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status })
}

function fieldTime(error: unknown) {
  if (error instanceof FieldTimeError) return bad(error.message)
  throw error
}

const geoSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).nullable().optional(),
})

const eventSchema = z.object({
  kind: z.enum(['clock_in', 'clock_out', 'break_start', 'break_end', 'switch']),
  occurredAt: z.string().min(1),
  deviceId: z.string().max(120).nullable().optional(),
  projectId: z.string().nullable().optional(),
  projectTaskId: z.string().nullable().optional(),
  costCodeRef: z.string().max(80).nullable().optional(),
  geo: geoSchema.nullable().optional(),
  photoFileId: z.string().nullable().optional(),
  clientEventId: z.string().min(1),
})

/** GET → own clock status, today's pairs, and the offline replay hint. */
export async function GET() {
  const gate = await guardFeaturePermission('time.clock', 'fieldTime')
  if (gate instanceof NextResponse) return gate
  try {
    const day = await myClockDay(gate.user.orgId, gate.user.id)
    return NextResponse.json(day)
  } catch (error) {
    return fieldTime(error)
  }
}

/**
 * POST a single clock event, or { events: [...] } to replay an offline
 * queue. Replay returns per-event results — one bad event never sinks
 * the rest, and a replayed id returns the original recording.
 */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('time.clock', 'fieldTime')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const orgId = user.orgId

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Record<string, unknown>
  try {
    // The clock is self: the employee always resolves from the login,
    // never from client input — another worker's party id reads as
    // missing here, not as permission to clock for them.
    const employeePartyId = await resolveOwnParty(orgId, user.id)

    if (Array.isArray(body.events)) {
      if (body.events.length > 200) return bad('Replay batches hold at most 200 events')
      const parsed = z.array(eventSchema).safeParse(body.events)
      if (!parsed.success) return bad('Each replayed event needs kind, occurredAt and clientEventId')
      const inputs: RecordClockInput[] = parsed.data.map((event) => toInput(orgId, user.id, employeePartyId, event))
      const results = await replayClockEvents(inputs)
      return NextResponse.json({ results })
    }

    const parsed = eventSchema.safeParse(body)
    if (!parsed.success) return bad('The clock event needs kind, occurredAt and clientEventId')
    const result = await recordClockEvent(toInput(orgId, user.id, employeePartyId, parsed.data))
    return NextResponse.json(result)
  } catch (error) {
    return fieldTime(error)
  }
}

function toInput(
  orgId: string,
  actorUserId: string,
  employeePartyId: string,
  event: z.infer<typeof eventSchema>,
): RecordClockInput {
  for (const [key, value] of [
    ['projectId', event.projectId],
    ['projectTaskId', event.projectTaskId],
    ['photoFileId', event.photoFileId],
  ] as const) {
    if (value != null && value !== '' && !isUuid(value)) {
      throw new FieldTimeError('invalid_ref', `The clock event's ${key} is not a valid id — pick it from the picker and retry`)
    }
  }
  if (!isUuid(event.clientEventId) && !/^[0-9a-f-]{36}$/i.test(event.clientEventId)) {
    throw new FieldTimeError('invalid_client_event', 'The clock event carries no offline id — retry with a client-generated UUID so replay stays idempotent')
  }
  return {
    orgId,
    actorUserId,
    employeePartyId,
    kind: event.kind,
    occurredAt: event.occurredAt,
    deviceId: event.deviceId ?? null,
    source: 'mobile',
    projectId: event.projectId ?? null,
    projectTaskId: event.projectTaskId ?? null,
    costCodeRef: event.costCodeRef?.trim() ? event.costCodeRef.trim() : null,
    geo: event.geo ?? null,
    photoFileId: event.photoFileId ?? null,
    clientEventId: event.clientEventId,
  }
}
