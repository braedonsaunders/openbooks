import { z } from 'zod'
import { isIsoCalendarDate } from '@openbooks/engine/platform/civil-date'
import { unprocessable } from '@/lib/api/responses'

const id = z.string().uuid()
const date = z.string().refine(isIsoCalendarDate, 'Choose a valid calendar date.')
const reason = z.string().trim().min(1, 'Supply the reason for this compensation change.').max(2000)
const revision = z.number().int().min(1)
const value = z.union([z.string().max(64), z.boolean()], { error: 'Supply exact decimal text or a boolean for this declared input.' })
const values = z.record(z.string().max(64), value).refine((record) => Object.keys(record).length <= 64, 'Supply at most 64 declared inputs.')
const type = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('scalar') }), z.strictObject({ kind: z.literal('hours') }), z.strictObject({ kind: z.literal('boolean') }),
  z.strictObject({ kind: z.literal('money'), currency: z.string().length(3) }),
  z.strictObject({ kind: z.literal('hourly_rate'), currency: z.string().length(3) }),
])
export const packageParams = z.strictObject({ id })
export const versionParams = z.strictObject({ id, versionId: id })
export const assignmentParams = z.strictObject({ id, assignmentId: id })
export const definitionSchema = z.strictObject({
  orgId: id, country: z.string().length(2), currency: z.string().length(3), partialPeriod: z.enum(['allow', 'refuse']),
  inputs: z.array(z.strictObject({ name: z.string().max(64), type, source: z.enum(['constant', 'assignment', 'period_gross', 'period_hours', 'hourly_wage']),
    value: value.optional(), minimum: z.string().max(64).optional(), maximum: z.string().max(64).optional() })).max(64),
  rules: z.array(z.strictObject({ key: z.string().max(64), componentId: id, expression: z.string().max(4096), condition: z.string().max(4096).nullable().optional(),
    proration: z.enum(['none', 'calendar_days']), rounding: z.strictObject({ scale: z.number().int().min(0).max(4),
      mode: z.enum(['half_away_from_zero', 'half_even', 'towards_zero']), maxWholeDigits: z.literal(15) }) })).min(1).max(64),
})
export const createPackageBody = z.strictObject({ subsidiaryId: id, code: z.string().trim().min(1).max(64), name: z.string().trim().min(1).max(160),
  description: z.string().max(2000).nullable().optional(), country: z.string().length(2), currency: z.string().length(3), reason })
export const updatePackageBody = z.strictObject({ expectedRevision: revision, name: z.string().trim().min(1).max(160), description: z.string().max(2000).nullable(), retire: z.boolean(), reason })
export const versionBody = z.strictObject({ versionId: id.optional(), expectedRevision: revision.optional(), effectiveFrom: date, effectiveTo: date.nullable(), definition: definitionSchema, reason })
export const submitBody = z.strictObject({ expectedRevision: revision, reason })
export const decisionBody = z.strictObject({ expectedRevision: revision, action: z.enum(['approve', 'reject']), reason })
export const assignmentBody = z.strictObject({ assignmentId: id.optional(), expectedRevision: revision.optional(), versionId: id, employmentId: id,
  effectiveFrom: date, effectiveTo: date.nullable(), inputs: values, reason })
export const assignmentActionBody = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('submit'), expectedRevision: revision, reason }),
  z.strictObject({ action: z.literal('cancel'), expectedRevision: revision, reason }),
  z.strictObject({ action: z.literal('end'), effectiveTo: date, expectedRevision: revision, reason }),
])
export const previewBody = z.strictObject({ context: z.strictObject({ periodStart: date, periodEnd: date, effectiveFrom: date, effectiveTo: date.nullable(),
  values, occupiedComponentIds: z.array(id).max(64), replacementComponentIds: z.array(id).max(64),
  suppliedComponentAmounts: z.record(id, z.string().max(64)).refine((record) => Object.keys(record).length <= 64, 'Supply at most 64 native component amounts.').optional() }) })

export function packageCreateKey(request: Request) {
  const key = request.headers.get('Idempotency-Key')?.trim()
  return id.safeParse(key).success ? key! : unprocessable('Supply a UUID Idempotency-Key for this create request; reopen the creation form to start a new request.', { status: 400 })
}
