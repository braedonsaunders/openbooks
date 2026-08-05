import { NextResponse } from 'next/server'
import { buildT4Xml } from '@openbooks/engine/src/payroll-t4xml.ts'
import { PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'

export const dynamic = 'force-dynamic'

/**
 * GET ?year= — the CRA T4 Internet File Transfer XML (T619 + slips +
 * summary). Fails closed (422) naming missing SINs / BN / transmitter
 * config. Validate against the CRA schema for the filing year before
 * transmitting.
 */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const year = Number(new URL(req.url).searchParams.get('year'))
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    return NextResponse.json({ error: 'invalid year' }, { status: 422 })
  }
  try {
    const file = await buildT4Xml(gate.user.orgId, year)
    return new NextResponse(file.xml, {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${file.filename}"`,
      },
    })
  } catch (e) {
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
