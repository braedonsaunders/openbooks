import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { wipAnalytics, WipBillingError } from '../../../../lib/wip-billing'
import { guardWipBillingFeature } from '../../../../lib/wip-billing-gate'

export const runtime = 'nodejs'

export async function GET(req: Request) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const feature = await guardWipBillingFeature(gate.user.orgId)
  if (feature) return feature
  try {
    return NextResponse.json({ analytics: await wipAnalytics(gate.user.orgId, new URL(req.url).searchParams.get('asOf') ?? undefined) })
  } catch (error) {
    const status = error instanceof WipBillingError ? error.status : 500
    return NextResponse.json({ error: (error as Error).message }, { status })
  }
}
