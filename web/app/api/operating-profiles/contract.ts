import { z } from 'zod'
export const ProfileBody = z.object({
  code: z.string(), name: z.string(), definition: z.unknown(), reason: z.string(),
  isActive: z.boolean().optional(),
  expectedVersion: z.number().int().nonnegative().optional(),
}).strict()
