import { NextResponse } from 'next/server'
import { PAYROLL_BANK_FILE_EXPORT_DISABLED_MESSAGE } from '@openbooks/engine/src/payroll-bank-file.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * Fail-closed alpha gate. Payroll bank bytes must not be generated until the
 * immutable artifact, approval, and delivery-audit workflow is implemented.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  return NextResponse.json(
    { error: PAYROLL_BANK_FILE_EXPORT_DISABLED_MESSAGE },
    { status: 409, headers: { 'Cache-Control': 'no-store' } },
  )
}
