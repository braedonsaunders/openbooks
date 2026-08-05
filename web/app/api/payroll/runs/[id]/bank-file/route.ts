import { NextResponse } from 'next/server'
import { buildPayRunBankFile, type PayRunBankFileFormat } from '@openbooks/engine/src/payroll-bank-file.ts'
import { PaymentError } from '@openbooks/engine/src/payments.ts'
import { PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * Direct-deposit bank file for a committed pay run — one payment per stub
 * from the employee's approved bank account. `?format=` picks the writer
 * (cpa005 default, nacha for US banking); the format rides the payments
 * machinery's originator settings, not the payroll country packs.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })

  const requested = new URL(req.url).searchParams.get('format')
  const format: PayRunBankFileFormat = requested === 'nacha' ? 'nacha' : 'cpa005'
  try {
    const file = await buildPayRunBankFile({ orgId: gate.user.orgId, documentId: id, format })
    return new NextResponse(file.content, {
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': `attachment; filename="${file.filename}"`,
      },
    })
  } catch (error) {
    if (error instanceof PayrollError || error instanceof PaymentError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    throw error
  }
}
