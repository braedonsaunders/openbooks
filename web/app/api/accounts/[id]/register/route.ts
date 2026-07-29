import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { accountRegister } from '../../../../../lib/reports'

export const runtime = 'nodejs'

const DATE = /^\d{4}-\d{2}-\d{2}$/
const PER_PAGE = 100

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('gl.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const query = new URL(request.url).searchParams
  const page = Math.max(1, Math.min(100_000, Number(query.get('page')) || 1))
  const from = query.get('from')
  const to = query.get('to')
  if ((from && !DATE.test(from)) || (to && !DATE.test(to))) {
    return NextResponse.json({ error: 'invalid_period' }, { status: 400 })
  }

  const result = await accountRegister(
    gate.user.orgId,
    id,
    PER_PAGE,
    (page - 1) * PER_PAGE,
    from || to ? { from: from || undefined, to: to || undefined } : undefined,
    gate.allowedSubsidiaryIds,
  )
  if (!result.account) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ...result, page, perPage: PER_PAGE })
}
