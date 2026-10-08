import { z } from 'zod'
export const resourceRecipientBody = z.strictObject({
  boardId: z.string().uuid(),
  equipmentUnitId: z.string().uuid().nullable(),
  resourceLocationId: z.string().uuid().nullable(),
  partyId: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
  isActive: z.boolean(),
})
