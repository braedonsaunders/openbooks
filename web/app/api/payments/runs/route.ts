import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/db.ts'
import { createPaymentRun } from '@openbooks/engine/src/payments.ts'
import { guardPermission } from '../../../../lib/authz'
import { isoDate, parseJsonBody, uuidId } from '../../../../lib/api/json'
import { paymentErrorResponse } from '../lib'

export const runtime = 'nodejs'

const createRunBody = z.object({
  paymentBankProfileId: z
    .string({ error: 'paymentBankProfileId is required' })
    .refine((v) => uuidId.safeParse(v).success, 'paymentBankProfileId is required'),
  billDocumentIds: z
    .array(uuidId, { error: 'select at least one bill' })
    .min(1, 'select at least one bill'),
  scheduledFor: isoDate().nullable().optional(),
  selectionCriteria: z.record(z.string(), z.unknown()).optional(),
})

export async function GET() {
  const gate = await guardPermission('ap.pay')
  if (gate instanceof NextResponse) return gate

  const runs = (await db.execute<Record<string, unknown>>(sql`
    select r.id, r.run_number, r.status, r.method, r.scheduled_for, r.exported_at, r.created_at,
           a.number as bank_number, a.name as bank_name,
           count(i.id) filter (where i.status <> 'cancelled') as instruction_count,
           coalesce(sum(i.amount) filter (where i.status <> 'cancelled'), 0) as total
      from payment_runs r
      left join accounts a on a.id = r.bank_account_id and a.org_id = r.org_id
      left join payment_instructions i on i.payment_run_id = r.id and i.org_id = r.org_id
     where r.org_id = ${gate.user.orgId}
     group by r.id, a.number, a.name
     order by r.created_at desc
     limit 200
  `))
  return NextResponse.json({ runs: runs.rows })
}

/** Create a payment run from selected posted, open vendor bills. */
export async function POST(req: Request) {
  const gate = await guardPermission('ap.pay')
  if (gate instanceof NextResponse) return gate
  const user = gate.user

  const parsed = await parseJsonBody(req, createRunBody)
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  try {
    const run = await createPaymentRun({
      orgId: user.orgId,
      createdBy: user.id,
      paymentBankProfileId: body.paymentBankProfileId,
      billDocumentIds: body.billDocumentIds,
      scheduledFor: body.scheduledFor ?? null,
      selectionCriteria: body.selectionCriteria ?? {},
    })
    return NextResponse.json(run)
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
