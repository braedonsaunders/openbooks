import { type NextRequest, NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
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
