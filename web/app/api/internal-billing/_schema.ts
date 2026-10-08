import { z } from 'zod'

const id = z.string().uuid().nullable().optional()
const decimal = z.string().nullable().optional()

/** The internal billing document contract shared by create and save. */
export const internalBillingBody = z.object({
  ruleCode: z.string().min(1),
  documentDate: z.string().nullable().optional(),
  subsidiaryId: id,
  departmentId: id,
  projectId: id,
  locationId: id,
  classId: id,
  referenceNumber: z.string().nullable().optional(),
  memo: z.string().nullable().optional(),
  lines: z.array(z.object({
    itemId: id,
    description: z.string().nullable().optional(),
    quantity: decimal,
    rate: decimal,
    amount: decimal,
    subsidiaryId: id,
    departmentId: id,
    projectId: id,
    locationId: id,
    classId: id,
    isBillable: z.boolean().nullable().optional(),
    billRate: decimal,
  }).strict()).min(1).max(500),
}).strict()
