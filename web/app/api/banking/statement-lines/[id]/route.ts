import { NextResponse } from 'next/server'
import { excludeStatementLine, restoreStatementLine } from '@openbooks/engine/src/banking.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { bankingErrorResponse } from '../../util'

export const runtime = 'nodejs'

/** Toggle a statement line's exclusion: { action: 'exclude' | 'restore' }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('banking.reconcile')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as { action?: string; reason?: string }
  try {
    if (body.action === 'exclude') {
      await excludeStatementLine(id, String(body.reason ?? ''), { orgId: user.orgId, userId: user.id })
    }
    else if (body.action === 'restore') await restoreStatementLine(id, { orgId: user.orgId, userId: user.id })
    else return NextResponse.json({ error: 'action must be "exclude" or "restore"' }, { status: 400 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return bankingErrorResponse(e)
  }
}
