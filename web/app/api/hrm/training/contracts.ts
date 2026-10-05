import { z } from 'zod'
import { isIsoCalendarDate } from '@openbooks/engine/platform/civil-date'
import { unprocessable } from '@/lib/api/responses'

const id = z.string().uuid()
const text = (max: number) => z.string().trim().min(1).max(max)
const reason = text(2000)
const whole = (label: string, minimum: number, maximum: number) => {
  const message = `${label} must be a whole number from ${minimum} to ${maximum}; enter a value within that range.`
  return z.number({ error: message }).int(message).min(minimum, message).max(maximum, message)
}
const revision = whole('Record revision', 1, Number.MAX_SAFE_INTEGER)
const date = z.string().refine(isIsoCalendarDate, 'Choose a real calendar date.')
export const courseParams = z.strictObject({ courseId: id })
export const sessionParams = z.strictObject({ sessionId: id })
export const participantParams = z.strictObject({ participantId: id })
export const courseBody = z.strictObject({
  subsidiaryId: id,
  code: text(64),
  version: whole('Course version', 1, Number.MAX_SAFE_INTEGER),
  name: text(160),
  description: z.string().max(2000).nullable(),
  effectiveFrom: date,
  effectiveTo: date.nullable(),
  qualificationTypeId: id.nullable(),
  minimumAttendancePercent: whole('Minimum attendance percentage', 0, 100),
  passingScore: whole('Passing score', 0, 100).nullable(),
  reason,
})
export const courseAction = z.strictObject({
  action: z.enum(['approve', 'retire', 'cancel']),
  expectedRevision: revision,
  reason,
})
export const sessionBody = z.strictObject({
  name: text(160),
  location: text(500),
  startsAt: text(64),
  endsAt: text(64),
  timeZone: text(128),
  capacity: whole('Session capacity', 1, 10000),
  reason,
})
export const sessionAction = z.strictObject({
  action: z.enum(['schedule', 'start', 'complete', 'cancel']),
  expectedRevision: revision,
  reason,
})
export const invitationBody = z.strictObject({ employmentId: id, reason })
export const responseBody = z.strictObject({
  action: z.enum(['accept', 'decline', 'cancel']),
  expectedRevision: revision,
  reason,
})
export const selfResponseBody = responseBody.extend({ action: z.enum(['accept', 'decline']) })
export const completionBody = z.strictObject({
  expectedRevision: revision,
  attendanceSeconds: whole('Attendance seconds', 0, 2678400),
  score: whole('Assessment score', 0, 100).nullable(),
  evidenceFileId: id.nullable(),
  existingQualificationId: id.nullable(),
  notes: z.string().max(5000).nullable(),
  reason,
})
export const voidBody = z.strictObject({ expectedRevision: revision, reason })
export const feedbackBody = z.strictObject({
  rating: whole('Feedback rating', 1, 5),
  comments: z.string().max(5000).nullable(),
  supersedesId: id.nullable(),
  reason,
})

export function trainingCreateKey(request: Request) {
  const key = request.headers.get('Idempotency-Key')?.trim()
  return id.safeParse(key).success
    ? key!
    : unprocessable('Supply a UUID Idempotency-Key; reopen the creation form to start a new request.', { status: 400 })
}
