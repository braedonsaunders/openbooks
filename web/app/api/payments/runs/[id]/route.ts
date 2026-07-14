import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { cancelPaymentRun, paymentRunReadiness } from '@openbooks/engine/src/payments.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { paymentErrorResponse } from '../../lib'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ap.pay')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const run = (await db.execute(sql`
    select r.*, a.number as bank_number, a.name as bank_name
      from payment_runs r
      left join accounts a on a.id = r.bank_account_id
     where r.id = ${id} and r.org_id = ${gate.user.orgId}
  `)) as unknown as { rows: Record<string, unknown>[] }
  if (!run.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const [instructions, readiness] = await Promise.all([
    db.execute(sql`
      select i.id, i.amount, i.currency, i.status, p.display_name as payee,
             d.id as payment_document_id, d.document_number, d.status as payment_status
        from payment_instructions i
        join parties p on p.id = i.payee_party_id
        left join documents d on d.id = i.payment_document_id
       where i.payment_run_id = ${id}
       order by p.display_name
    `) as unknown as Promise<{ rows: Record<string, unknown>[] }>,
    paymentRunReadiness(id, gate.user.orgId),
  ])

  return NextResponse.json({
    run: run.rows[0],
    instructions: (instructions as unknown as { rows: Record<string, unknown>[] }).rows,
    eftConfigured: readiness.eft.ok,
    eftMissing: readiness.eft.ok ? [] : readiness.eft.missing,
    blockers: readiness.blockers,
  })
}

/** Cancel a draft/exported run: deletes its draft payments, keeps the audit row. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('ap.pay')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  try {
    await cancelPaymentRun(id, gate.user.orgId)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
