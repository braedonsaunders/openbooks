import { parseJsonBody } from "@/lib/api/json";
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
  if (error instanceof FieldTimeError) {
    // A reused offline id with a different payload is a client conflict,
    // not a validation failure.
    if (error.code === 'client_event_conflict') return NextResponse.json({ error: error.message }, { status: 409 })
    return bad(error.message)
  }
  throw error
}

const geoSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).nullable().optional(),
})

const SINGLE_NEEDS = 'The clock event needs kind, occurredAt and clientEventId'

const eventSchema = z.object({
  kind: z.enum(['clock_in', 'clock_out', 'break_start', 'break_end', 'switch'], { error: SINGLE_NEEDS }),
  occurredAt: z.string({ error: SINGLE_NEEDS }).min(1, SINGLE_NEEDS),
  deviceId: z.string().max(120).nullable().optional(),
  projectId: z.string().nullable().optional(),
  projectTaskId: z.string().nullable().optional(),
  costCodeRef: z.string().max(80).nullable().optional(),
  geo: geoSchema.nullable().optional(),
  photoFileId: z.string().nullable().optional(),
  clientEventId: z.string({ error: SINGLE_NEEDS }).min(1, SINGLE_NEEDS),
})

const REPLAY_NEEDS = 'Each replayed event needs kind, occurredAt and clientEventId'
const REPLAY_CAP = 'Replay batches hold at most 200 events'

/**
 * One body, two shapes: a single event, or { events: [...] } from the
 * offline queue. The replay cap is declared here because a queue that
 * grew past it is a client bug the worker must see, not a truncation.
 */
const clockBody = z.union([
  z.object({ events: z.array(eventSchema, { error: REPLAY_NEEDS }).max(200, REPLAY_CAP) }),
  eventSchema,
])

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

  const parsedBody = await parseJsonBody(req, clockBody, { status: 422 });
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  try {
    // The clock is self: the employee always resolves from the login,
    // never from client input — another worker's party id reads as
    // missing here, not as permission to clock for them.
    const employeePartyId = await resolveOwnParty(orgId, user.id)

    if ('events' in body) {
      const inputs: RecordClockInput[] = body.events.map((event) => toInput(orgId, user.id, employeePartyId, event))
      const results = await replayClockEvents(inputs)
      return NextResponse.json({ results })
    }

    const result = await recordClockEvent(toInput(orgId, user.id, employeePartyId, body))
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
