import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { clearPossibleDuplicateFlag, excludeStatementLine, restoreStatementLine } from '@openbooks/engine/src/banking/banking.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { bankingErrorResponse } from '../../util'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

/** Toggle a statement line's exclusion or clear its possible-duplicate flag. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const { id } = await params
  if (!isUuid(id)) return notFound("record")
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as { action?: string; reason?: string }
  try {
    if (body.action === 'exclude') {
      await excludeStatementLine(id, String(body.reason ?? ''), {
        orgId: user.orgId,
        userId: user.id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      })
    }
    else if (body.action === 'restore')
      await restoreStatementLine(id, {
        orgId: user.orgId,
        userId: user.id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      })
    else if (body.action === 'clear-duplicate')
      await clearPossibleDuplicateFlag(id, {
        orgId: user.orgId,
        userId: user.id,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      })
    else return NextResponse.json({ error: 'action must be "exclude", "restore" or "clear-duplicate"' }, { status: 400 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return bankingErrorResponse(e)
  }
}
