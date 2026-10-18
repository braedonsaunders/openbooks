import { z } from 'zod'

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export const identityBody = z.strictObject({
  deviceId: z.string().uuid(),
  sourceWorkerId: z.string().trim().min(1).max(160),
  workerPartyId: z.string().uuid(),
  employmentId: z.string().uuid().nullable().optional(),
  effectiveFrom: date,
  effectiveTo: date.nullable(),
  reason: z.string().trim().min(1).max(2000),
})
