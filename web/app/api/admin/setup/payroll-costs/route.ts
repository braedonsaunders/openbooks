import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { postPayrollCostBatch, reconcilePayrollCostBatch, validatePayrollCostBatch } from '@openbooks/engine/src/payroll-cost.ts'

export const runtime = 'nodejs'

const EXAMPLE_ROWS: Record<string, string[][]> = {
  generic: [
    ['PAY-001', 'LINE-001', 'EMP-001', 'REG', 'gross_pay', '40', '1400.00', 'Regular employer cost'],
    ['PAY-001', 'LINE-002', 'EMP-001', 'TAX', 'employer_tax', '', '168.00', 'Employer payroll taxes'],
  ],
  construction_union: [
    ['PAY-001', 'LINE-001', 'EMP-001', 'JOURNEY', 'gross_pay', '40', '1800.00', 'Journeyperson wages'],
    ['PAY-001', 'LINE-002', 'EMP-001', 'HW', 'benefit', '', '320.00', 'Health and welfare fringe'],
    ['PAY-001', 'LINE-003', 'EMP-001', 'PENSION', 'benefit', '', '280.00', 'Union pension fringe'],
    ['PAY-001', 'LINE-004', 'EMP-001', 'WC', 'worker_comp', '', '126.00', 'Workers compensation'],
  ],
  professional_services: [
    ['PAY-001', 'LINE-001', 'EMP-001', 'SALARY', 'gross_pay', '40', '2500.00', 'Salary employer cost'],
    ['PAY-001', 'LINE-002', 'EMP-001', 'BENEFITS', 'benefit', '', '375.00', 'Employer benefits'],
  ],
}

export async function GET(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const template = new URL(req.url).searchParams.get('template') ?? 'generic'
  const rows = EXAMPLE_ROWS[template] ?? EXAMPLE_ROWS.generic
  const csv = [
    ['batchId', 'externalLineId', 'employeePartyId', 'payCode', 'component', 'hours', 'amount', 'memo'],
    ...rows,
  ].map((row) => row.map((cell) => `"${cell.replaceAll('"', '""')}"`).join(',')).join('\n')
  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="external-payroll-${template}.csv"`,
    },
  })
}

export async function POST(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const body = (await req.json().catch(() => ({}))) as { action?: string; batchId?: string }
  if (!body.batchId || !isUuid(body.batchId)) return NextResponse.json({ error: 'Invalid payroll batch' }, { status: 422 })
  try {
    if (body.action === 'validate') {
      return NextResponse.json(await validatePayrollCostBatch(gate.user.orgId, gate.user.id, body.batchId))
    }
    if (body.action === 'reconcile') {
      return NextResponse.json(await reconcilePayrollCostBatch(gate.user.orgId, gate.user.id, body.batchId))
    }
    if (body.action === 'post') {
      return NextResponse.json({ journalEntryId: await postPayrollCostBatch(gate.user.orgId, gate.user.id, body.batchId) })
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 422 })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 422 })
  }
}
