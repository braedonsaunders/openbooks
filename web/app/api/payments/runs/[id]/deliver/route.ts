import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@openbooks/engine/src/db.ts'
import { deliverRunToSftp } from '@openbooks/engine/src/sftp/import-job.ts'
import { PaymentError } from '@openbooks/engine/src/payments.ts'
import { isUuid } from '../../../../../../lib/list-params'
import { parseJsonBody, uuidId } from '../../../../../../lib/api/json'
import { guardPaymentRunPermission } from '../../../lib'

export const runtime = 'nodejs'

const deliverBody = z.object({
  sftpServerId: z
    .string({ error: 'sftpServerId is required' })
    .refine((v) => uuidId.safeParse(v).success, 'sftpServerId is required'),
})

/** Active SFTP servers the run can be delivered to (picker for the run drawer). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const gate = await guardPaymentRunPermission(id)
  if (gate instanceof NextResponse) return gate
  const r = (await db.execute(sql`
    select s.id, s.name from payment_runs r join payment_bank_profiles p on p.id = r.payment_bank_profile_id and p.org_id = r.org_id
      join sftp_servers s on s.org_id = r.org_id and s.is_active and (p.sftp_server_id is null or p.sftp_server_id = s.id)
     where r.id = ${id} and r.org_id = ${gate.user.orgId} order by s.name
  `))
  return NextResponse.json({ servers: r.rows })
}

/** Deliver a payment run's bank file to an SFTP server's outbound folder: { sftpServerId }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const gate = await guardPaymentRunPermission(id)
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const parsed = await parseJsonBody(req, deliverBody)
  if (!parsed.ok) return parsed.response
  try {
    const res = await deliverRunToSftp(id, parsed.data.sftpServerId, user.orgId, user.id, new Date())
    return NextResponse.json({ ok: true, ...res })
  } catch (e) {
    if (e instanceof PaymentError) return NextResponse.json({ error: e.message }, { status: 422 })
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
