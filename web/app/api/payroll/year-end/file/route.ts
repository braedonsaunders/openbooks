import { NextResponse } from 'next/server'
import { yearEndFiling } from '@openbooks/engine/src/payroll-filing-registry.ts'
import { PayrollPackError } from '@openbooks/engine/src/payroll/packs.ts'
import { PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'

export const dynamic = 'force-dynamic'

/**
 * GET ?country=&filing=&year=&… — the electronic file of ONE pack-declared
 * year-end filing (the CA pack's T4 XML or ROE Web XML today; whatever a
 * registered pack declares tomorrow). The filing is resolved through the
 * payroll filing registry, so this route knows no country and no format:
 * each filing parses its own extra parameters (the ROE reads `employees`)
 * and builds its own file.
 *
 * Fails closed (422) with every problem named — missing SINs, missing
 * transmitter configuration, a filing whose pack declares no electronic
 * file. An unknown country/filing pair is a 404 that names what IS declared.
 */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.run', 'payroll')
  if (gate instanceof NextResponse) return gate
  const url = new URL(req.url)
  const year = Number(url.searchParams.get('year'))
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    return NextResponse.json({ error: 'invalid year' }, { status: 422 })
  }
  try {
    const filing = yearEndFiling(
      url.searchParams.get('country') ?? '',
      url.searchParams.get('filing') ?? '',
    )
    if (!filing.download) {
      return NextResponse.json(
        { error: filing.downloadRefusal ?? `the ${filing.label} filing declares no electronic file` },
        { status: 422 },
      )
    }
    const params = Object.fromEntries(url.searchParams)
    const file = await filing.download.build(gate.user.orgId, year, params)
    return new NextResponse(file.body, {
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': `attachment; filename="${file.filename}"`,
      },
    })
  } catch (e) {
    if (e instanceof PayrollPackError) return NextResponse.json({ error: e.message }, { status: 404 })
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
