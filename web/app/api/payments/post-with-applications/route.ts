import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  postPaymentWithApplications,
  type AllocationInput,
  type PaymentKind,
} from '@openbooks/engine/src/payments.ts'
import { can, getAuthz } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { paymentErrorResponse, paymentPermission } from '../lib'

export const runtime = 'nodejs'

/**
 * Explicit "Pay & post": posts the payment document through the kernel and
 * applies it to the selected open items atomically (auto-reversal on
 * application failure — see engine/src/payments.ts).
 */
export async function POST(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = (await req.json()) as { documentId?: string; allocations?: AllocationInput[] }
  if (!body.documentId || !isUuid(body.documentId)) {
    return NextResponse.json({ error: 'documentId is required' }, { status: 400 })
  }

  const r = (await db.execute(sql`
    select kind from documents
     where id = ${body.documentId} and kind in ('vendor_payment', 'customer_payment')
       and org_id = ${authz.user.orgId}
  `)) as unknown as { rows: { kind: PaymentKind }[] }
  if (!r.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const perm = paymentPermission(r.rows[0].kind)
  if (!can(authz, perm)) {
    return NextResponse.json({ error: `missing permission: ${perm}` }, { status: 403 })
  }

  try {
    const result = await postPaymentWithApplications(body.documentId, body.allocations, authz.user.id)
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
