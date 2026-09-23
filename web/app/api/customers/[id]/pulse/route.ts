import { NextResponse } from 'next/server'
import { can, getAuthz } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { loadCustomerPulse, pulseSectionsFor } from '../../../../../lib/customer-pulse'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  // The pulse is a combined payload across domains, so EITHER-read no longer
  // opens the whole response: each section is gated by its own permission
  // (AR/credit/payments on ar.read, pipeline/activity on
  // crm.accounts.read, project rollup on projects.read) and sections the
  // caller cannot see are omitted. The route still requires at least one of
  // the three — a caller with none gets a 403 naming the remedy.
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const sections = pulseSectionsFor((perm) => can(authz, perm))
  if (!sections) {
    return NextResponse.json(
      { error: 'missing permission: crm.accounts.read, ar.read or projects.read' },
      { status: 403 },
    )
  }

  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const data = await loadCustomerPulse(id, authz.user.orgId, authz.allowedSubsidiaryIds, sections)
  if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 })

  return NextResponse.json(data)
}
