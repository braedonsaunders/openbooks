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

  // A run is visible only when every bill it pays is inside the caller's
  // subsidiary scope — the same boundary guardPaymentRunPermission enforces
  // per run. Null-subsidiary sources fail closed.
  let scopeFilter = sql``
  if (gate.allowedSubsidiaryIds) {
    const ids = [...gate.allowedSubsidiaryIds]
    scopeFilter = ids.length === 0
      ? sql` and not exists (
              select 1 from payment_run_items ri0
               where ri0.payment_run_id = r.id and ri0.org_id = r.org_id and ri0.status <> 'cancelled')`
      : sql` and not exists (
              select 1
                from payment_run_items ri0
                join documents d0 on d0.id = ri0.source_document_id and d0.org_id = ri0.org_id
               where ri0.payment_run_id = r.id and ri0.org_id = r.org_id and ri0.status <> 'cancelled'
                 and (d0.subsidiary_id is null or not (d0.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[]))))`
  }

  const runs = (await db.execute<Record<string, unknown>>(sql`
    select r.id, r.run_number, r.status, r.method, r.scheduled_for, r.exported_at, r.created_at,
           a.number as bank_number, a.name as bank_name,
           count(i.id) filter (where i.status <> 'cancelled') as instruction_count,
           coalesce(sum(i.amount) filter (where i.status <> 'cancelled'), 0) as total
      from payment_runs r
      left join accounts a on a.id = r.bank_account_id and a.org_id = r.org_id
      left join payment_instructions i on i.payment_run_id = r.id and i.org_id = r.org_id
     where r.org_id = ${gate.user.orgId}${scopeFilter}
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

  // Every selected bill is a record being read into the run: restricted
  // callers may only select bills inside their subsidiary scope. Bills that
  // do not resolve in this org fail closed identically.
  if (gate.allowedSubsidiaryIds) {
    const selected = [...new Set(body.billDocumentIds)]
    const rows = (await db.execute<{ id: string; subsidiaryId: string | null }>(sql`
      select id, subsidiary_id as "subsidiaryId" from documents
       where org_id = ${user.orgId} and id = any(${`{${selected.join(',')}}`}::uuid[])
    `))
    const inScope = rows.rows.filter(
      (row) => row.subsidiaryId !== null && gate.allowedSubsidiaryIds!.has(row.subsidiaryId),
    )
    if (inScope.length !== selected.length) {
      return NextResponse.json({ error: 'not found' }, { status: 404 })
    }
  }

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
