import { z } from 'zod'
export const ScopeBody = z.object({ departmentId: z.string().uuid().nullable(), family: z.enum(['project', 'production']), profileIds: z.array(z.string().uuid()).min(1).max(100), defaultProfileId: z.string().uuid().nullable(), reason: z.string(), expectedRevision: z.number().int().positive().optional() }).strict()
