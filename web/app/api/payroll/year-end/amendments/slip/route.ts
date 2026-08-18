import { NextResponse } from 'next/server'
import { PayrollPackError } from '@openbooks/engine/src/payroll/packs.ts'
import { PayrollError } from '@openbooks/engine/src/payroll-error.ts'
import { filingCorrectionSlip } from '@openbooks/engine/src/payroll-yearend-amendments.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { pdfResponse, safeName } from '../../../../../../lib/export'
import { payrollSlipFacsimile } from '../../../../../../lib/payroll-slip-facsimile'
import { renderTaxFormFacsimilePdf } from '../../../../../../lib/tax-form-facsimile'
import { orgBranding } from '../../../../../../lib/report-pdf'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET ?country=&filing=&year=&row=&revision=[&format=pdf] — ONE row's
 * CORRECTION rendered as its statutory form, through the pack's own
 * declaration and the same form-faithful facsimile pathway every slip prints
 * through: the CRA's amended T4, the IRS's Form W-2c or Form 941-X.
 *
 * The route knows no country and no form. A pack that cannot produce a
 * correction refuses here, by name, in its own words (422).
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
  const revision = url.searchParams.get('revision') ?? 'amended'
  if (revision !== 'amended' && revision !== 'cancelled') {
    return NextResponse.json(
      { error: 'revision must be amended or cancelled' },
      { status: 422 },
    )
  }
  try {
    const slip = await filingCorrectionSlip(
      gate.user.orgId,
      url.searchParams.get('country') ?? '',
      url.searchParams.get('filing') ?? '',
      year,
      row,
      revision,
    )
    const branding = await orgBranding()
    if ((url.searchParams.get('format') ?? 'json') === 'pdf') {
      const { result, layout } = payrollSlipFacsimile(slip, year)
      return pdfResponse(
        await renderTaxFormFacsimilePdf(
          result,
          { orgName: branding.orgName, primaryColor: branding.primaryColor },
          layout,
        ),
        `${safeName(slip.formCode)}-${year}-${safeName(row)}`,
      )
    }
    return NextResponse.json({ slip, orgName: branding.orgName })
  } catch (e) {
    if (e instanceof PayrollPackError) return NextResponse.json({ error: e.message }, { status: 404 })
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    throw e
  }
}
