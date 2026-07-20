import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { loadRelatedTransactionDrawerData } from '../../../../components/related-transaction-drawer'

export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const KIND = /^[a-z][a-z0-9_]{0,63}$/

export async function GET(request: Request) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const url = new URL(request.url)
  const id = url.searchParams.get('id') ?? ''
  const kind = url.searchParams.get('kind') ?? ''
  const formLayoutId = url.searchParams.get('form') || undefined
  if (!UUID.test(id) || !KIND.test(kind) || (formLayoutId && !UUID.test(formLayoutId))) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }
  const data = await loadRelatedTransactionDrawerData({ id, kind, authz: gate, formLayoutId })
  return data ? NextResponse.json(data) : NextResponse.json({ error: 'not_found' }, { status: 404 })
}
