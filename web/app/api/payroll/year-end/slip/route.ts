import { NextResponse } from 'next/server'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { yearEndFiling } from '@openbooks/engine/src/payroll-filing-registry.ts'
import { PayrollPackError } from '@openbooks/engine/src/payroll/packs.ts'
import { PayrollError } from '@openbooks/engine/src/payroll-run.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { pdfResponse, safeName } from '../../../../../lib/export'
import { payrollSlipFacsimile } from '../../../../../lib/payroll-slip-facsimile'
import { renderTaxFormFacsimilePdf } from '../../../../../lib/tax-form-facsimile'
import { orgBranding } from '../../../../../lib/report-pdf'
import { guardPayrollFilingRowIds } from '../../subsidiary-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET ?country=&filing=&year=&row=[&format=pdf] — ONE population row of a
 * pack-declared year-end filing rendered as its statutory slip, through the
 * registry's slip declaration. Like the file route, this route knows no
 * country and no form: the filing builds its own box data, and the shared
 * facsimile pathway renders it (JSON for the drawer, Chromium PDF for the
 * download). Wage data — payroll.read.
 *
 * Fails closed: a filing with no slip declaration is a named 422, a builder
 * refusal (no pay schedule, unknown year caps) is a 422 in the builder's own
 * words, an unknown country/filing pair is a 404 naming what IS declared.
 */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const url = new URL(req.url)
  const year = Number(url.searchParams.get('year'))
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    return NextResponse.json({ error: 'invalid year' }, { status: 422 })
  }
  const row = url.searchParams.get('row') ?? ''
  if (!row) return NextResponse.json({ error: 'row is required' }, { status: 422 })
  const country = url.searchParams.get('country') ?? ''
  const filingKey = url.searchParams.get('filing') ?? ''
  const denied = await guardPayrollFilingRowIds(gate, country, filingKey, [row])
  if (denied) return denied
  try {
    const filing = yearEndFiling(
      country,
      filingKey,
    )
    if (!filing.slip) {
      return NextResponse.json(
        { error: `the ${filing.label} filing declares no slip render` },
        { status: 422 },
      )
    }
    const slip = await filing.slip.build(gate.user.orgId, year, row)
    const branding = await orgBranding()
    if ((url.searchParams.get('format') ?? 'json') === 'pdf') {
      const { result, layout } = payrollSlipFacsimile(slip, year)
      return pdfResponse(
        await renderTaxFormFacsimilePdf(
          result,
          { orgName: branding.orgName, primaryColor: branding.primaryColor },
          layout,
        ),
        `${safeName(slip.formCode)}-${year}-${safeName(row)}-${await businessToday(gate.user.orgId)}`,
      )
    }
    return NextResponse.json({ slip, orgName: branding.orgName })
  } catch (e) {
    if (e instanceof PayrollPackError) return NextResponse.json({ error: e.message }, { status: 404 })
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
