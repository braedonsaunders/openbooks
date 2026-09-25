import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { cancelPaymentRun } from "@openbooks/engine/src/payments/run-cancellation.ts";
import { paymentRunReadiness } from "@openbooks/engine/src/payments/run-readiness.ts";
import { subsidiaryVisibleFilter } from '../../../../../lib/subsidiaries'
import { isUuid } from '../../../../../lib/list-params'
import { parseJsonBody } from '../../../../../lib/api/json'
import { guardPaymentRunPermission, paymentErrorResponse } from '../../lib'

export const runtime = 'nodejs'

const cancelBody = z.object({
  reason: z.string().trim().min(1, 'a cancellation reason is required'),
})

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const gate = await guardPaymentRunPermission(id)
  if (gate instanceof NextResponse) return gate

  const run = (await db.execute<Record<string, unknown>>(sql`
    select r.*, a.number as bank_number, a.name as bank_name
      from payment_runs r
      left join accounts a on a.id = r.bank_account_id and a.org_id = r.org_id
     where r.id = ${id} and r.org_id = ${gate.user.orgId}
  `))
  if (!run.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })

  // One transaction for the whole response: every payee owner is locked for
  // share first, so a concurrent rehome blocks until these reads commit and
  // instructions and readiness verdicts cannot disagree. Payees outside the
  // caller's scope read as missing from both lists, like party bank reads.
  return withOrgTransaction(gate.user.orgId, async () => {
    const payees = (await db.execute<{ id: string }>(sql`
      select p.id from parties p
       where p.org_id = ${gate.user.orgId} and p.id in (
         select i.payee_party_id from payment_instructions i
          where i.payment_run_id = ${id} and i.org_id = ${gate.user.orgId}
       )
       ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, gate.allowedSubsidiaryIds, { orgWideNull: true })}
       for share of p
    `)).rows
    const visiblePayeeIds = gate.allowedSubsidiaryIds === null
      ? null
      : new Set(payees.map((payee) => payee.id))
    // Sequential: both statements share this transaction's single connection,
    // and the share locks above already serialize against rehome writers.
    const instructions = await db.execute<Record<string, unknown>>(sql`
      select i.id, i.amount, i.currency, i.status, p.display_name as payee,
             d.id as payment_document_id, d.document_number, d.status as payment_status
        from payment_instructions i
        join parties p on p.id = i.payee_party_id and p.org_id = i.org_id
        left join documents d on d.id = i.payment_document_id and d.org_id = i.org_id
       where i.payment_run_id = ${id} and i.org_id = ${gate.user.orgId}
         ${visiblePayeeIds === null ? sql`` : sql`and i.payee_party_id = any (${`{${[...visiblePayeeIds].join(",")}}`}::uuid[])`}
       order by p.display_name
    `)
    const readiness = await paymentRunReadiness(id, gate.user.orgId, visiblePayeeIds)

    return NextResponse.json({
      run: run.rows[0],
      instructions: (instructions as unknown as { rows: Record<string, unknown>[] }).rows,
      eftConfigured: readiness.eft.ok,
      eftMissing: readiness.eft.ok ? [] : readiness.eft.missing,
      blockers: readiness.blockers,
    })
  })
}

/** Cancel a draft/exported run: deletes its draft payments, keeps the audit row. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const gate = await guardPaymentRunPermission(id)
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(req, cancelBody)
  if (!parsed.ok) return parsed.response

  try {
    await cancelPaymentRun(id, gate.user.orgId, gate.user.id, parsed.data.reason)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
