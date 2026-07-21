import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { resolveLaborRate, LaborRateError } from '@openbooks/engine/src/labor-rates.ts'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const requiredIds = ['employeePartyId', 'projectId'] as const
  for (const key of requiredIds) if (!isUuid(String(body[key] ?? ''))) return NextResponse.json({ error: `Invalid ${key}` }, { status: 422 })
  const workedOn = String(body.workedOn ?? '')
  const hours = String(body.hours ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workedOn) || !/^\d+(\.\d{1,4})?$/.test(hours) || Number(hours) <= 0) {
    return NextResponse.json({ error: 'Choose a work date and positive hours' }, { status: 422 })
  }
  const optionalId = (key: string) => body[key] && isUuid(String(body[key])) ? String(body[key]) : null
  try {
    return NextResponse.json(await resolveLaborRate({
      orgId: gate.user.orgId,
      employeePartyId: String(body.employeePartyId),
      projectId: String(body.projectId),
      itemId: optionalId('itemId'),
      timeTypeId: optionalId('timeTypeId'),
      departmentId: optionalId('departmentId'),
      locationId: optionalId('locationId'),
      workedOn,
      hours,
      isBillable: body.isBillable === true,
    }))
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message, code: error instanceof LaborRateError ? error.code : 'configuration' }, { status: 422 })
  }
}
