import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { loadCustomerPulse } from '../../../../../lib/customer-pulse'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Pulse mixes CRM and receivables telemetry, so either read opens it.
  const crmGate = await guardPermission('crm.accounts.read')
  const gate = crmGate instanceof NextResponse ? await guardPermission('ar.read') : crmGate
  if (gate instanceof NextResponse) return gate

  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const data = await loadCustomerPulse(id, gate.user.orgId, gate.allowedSubsidiaryIds)
  if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 })

  return NextResponse.json(data)
}
