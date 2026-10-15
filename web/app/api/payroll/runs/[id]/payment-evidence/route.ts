import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { PayrollError } from '@openbooks/engine/payroll/error'
import { readPayRunPaymentEvidence } from '@openbooks/engine/payroll/payment'

export const GET = defineRoute({
  permission: 'payroll.read', feature: 'payroll',
  params: z.object({ id: z.string().uuid().transform(value => value.toLowerCase()) }),
  handler: async ({ authz, params }) => {
    try {
      const evidence = await readPayRunPaymentEvidence({ orgId: authz.user.orgId, actorId: authz.user.id,
        documentId: params.id, allowedSubsidiaryIds: authz.allowedSubsidiaryIds })
      return NextResponse.json({ evidence })
    } catch (error) {
      if (!(error instanceof PayrollError)) throw error
      if (error.message === 'pay run not found') return notFound('record')
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
  },
})
