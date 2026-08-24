import { type NextRequest, NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission, guardSubsidiaryScope } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { loadRelatedTransactionDrawerData } from '../../../../../components/related-transaction-drawer'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authz = await guardPermission('parties.read')
  if (authz instanceof NextResponse) return authz

  const { id: partyId } = await params
  const transactionId = request.nextUrl.searchParams.get('transaction')
  const kind = request.nextUrl.searchParams.get('kind')
  const formLayoutId = request.nextUrl.searchParams.get('form') ?? undefined
  if (!isUuid(partyId) || !transactionId || !isUuid(transactionId) || !kind) {
    return NextResponse.json({ error: 'invalid transaction selection' }, { status: 400 })
  }

  // The party is the record boundary (the loader separately enforces the
  // transaction's own subsidiary + org scope).
  const scope = (await db.execute<{ subsidiaryId: string | null }>(
    sql`select subsidiary_id as "subsidiaryId" from parties where id = ${partyId} and org_id = ${authz.user.orgId}`,
  ))
  if (!scope.rows[0]) return NextResponse.json({ error: 'transaction not found' }, { status: 404 })
  const denied = guardSubsidiaryScope(authz, scope.rows[0].subsidiaryId, { orgWideNull: true })
  if (denied) return denied

  const data = await loadRelatedTransactionDrawerData({
    id: transactionId,
    kind,
    partyId,
    authz,
    formLayoutId,
  })
  if (!data) return NextResponse.json({ error: 'transaction not found' }, { status: 404 })
  return NextResponse.json(data)
}
