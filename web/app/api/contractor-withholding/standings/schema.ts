import { z } from 'zod'
import { uuidId, isoDate } from '@/lib/api/json'
export const standingBody = z.object({
  subsidiaryId: uuidId.nullable().optional(),
  partyId: uuidId, schemeCode: z.string().trim().min(1), bandCode: z.string().trim().min(1),
  verificationReference: z.string().max(500).nullable().optional(), verifiedOn: isoDate().nullable().optional(),
  validFrom: isoDate(), validTo: isoDate().nullable().optional(),
  payeeReference: z.string().max(500).nullable().optional(), payeeTaxOffice: z.string().max(500).nullable().optional(),
  applyFromFirstPayment: z.boolean().optional(), notes: z.string().max(10000).nullable().optional(),
}).strict()
