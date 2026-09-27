import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createDirectDebitRun } from '@openbooks/engine/src/payments/direct-debit.ts'
import { defineRoute } from '@/lib/api/route'
import { isoDate, parseJsonBody, uuidId } from '@/lib/api/json'
import { paymentErrorResponse } from '@/app/api/payments/lib'

export const runtime = 'nodejs'

const REQUIREMENTS = 'A profile and at least one invoice are required'

const directDebitRunBody = z.object({
  paymentBankProfileId: z
    .string({ error: REQUIREMENTS })
    .refine((v) => uuidId.safeParse(v).success, REQUIREMENTS),
  invoiceDocumentIds: z.array(uuidId, { error: REQUIREMENTS }).min(1, REQUIREMENTS),
  scheduledFor: isoDate().nullable().optional(),
})

export const POST = defineRoute({
  permission: 'ar.pay',
  feature: { none: 'Direct debit runs are governed by payment permissions and have no organization feature switch.' },
  handler: async ({ request: req, authz: gate }) => {
  const parsed = await parseJsonBody(req, directDebitRunBody)
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  try {
    return NextResponse.json(await createDirectDebitRun({
      orgId: gate.user.orgId,
      createdBy: gate.user.id,
      paymentBankProfileId: body.paymentBankProfileId,
      invoiceDocumentIds: body.invoiceDocumentIds,
      scheduledFor: body.scheduledFor ?? null,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    }))
  } catch (error) {
    return paymentErrorResponse(error)
  }
  },
})
