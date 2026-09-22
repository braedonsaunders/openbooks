import { z } from 'zod'
import { isUuid } from '../../../../lib/list-params'

const uuid = z.string().refine(isUuid, 'must be a valid id')
const nullableUuid = uuid.nullable().optional()

export const createProcessTemplateBody = z.object({
  kind: z.enum(['onboarding', 'offboarding', 'transfer']),
  name: z.string().trim().min(1).max(200),
  appliesTo: z.object({
    employerSubsidiaryId: nullableUuid,
    departmentId: nullableUuid,
  }).optional(),
})

export const updateProcessTemplateBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  appliesTo: z.object({
    employerSubsidiaryId: nullableUuid,
    departmentId: nullableUuid,
  }).optional(),
})

export const saveProcessTemplateStepBody = z.object({
  position: z.number().int().min(0),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(4000).nullable().optional(),
  ownerKind: z.enum(['manager', 'hr', 'employee', 'named_party']),
  ownerPartyId: nullableUuid,
  dueOffsetDays: z.number().int().min(-3650).max(3650),
  required: z.boolean(),
  evidenceKind: z.enum(['none', 'acknowledgement', 'attachment']),
})
