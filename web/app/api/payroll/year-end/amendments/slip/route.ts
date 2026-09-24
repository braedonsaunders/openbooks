import { NextResponse } from 'next/server'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { PayrollPackError } from '@openbooks/engine/src/payroll/packs.ts'
import { PayrollError } from '@openbooks/engine/src/payroll/error.ts'
import { filingCorrectionSlip } from '@openbooks/engine/src/payroll/yearend-amendments.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { rendererUnavailableResponse } from '../../../../../../lib/api/pdf-renderer'
import { payrollYearRefusal } from '../../../../../../lib/payroll-year'
import { pdfResponse, safeName } from '../../../../../../lib/export'
import { payrollSlipFacsimile } from '../../../../../../lib/payroll-slip-facsimile'
import { renderTaxFormFacsimilePdf } from '../../../../../../lib/tax-form-facsimile'
import { orgBranding } from '../../../../../../lib/report-pdf'
import { guardPayrollFilingRowIds } from '../../../subsidiary-scope'

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
  const yearRaw = url.searchParams.get('year')
  const yearRefusal = payrollYearRefusal(yearRaw)
  if (yearRefusal !== null) {
    return NextResponse.json({ error: yearRefusal }, { status: 422 })
  }
  const year = Number(yearRaw)
  const row = url.searchParams.get('row') ?? ''
  if (!row) return NextResponse.json({ error: 'row is required' }, { status: 422 })
  const revision = url.searchParams.get('revision') ?? 'amended'
  if (revision !== 'amended' && revision !== 'cancelled') {
    return NextResponse.json(
      { error: 'revision must be amended or cancelled' },
      { status: 422 },
    )
  }
  const country = url.searchParams.get('country') ?? ''
  const filing = url.searchParams.get('filing') ?? ''
  const denied = await guardPayrollFilingRowIds(gate, country, filing, [row], year)
  if (denied) return denied
  try {
    const slip = await filingCorrectionSlip(
      gate.user.orgId,
      country,
      filing,
      year,
      row,
      revision,
      gate.allowedSubsidiaryIds ?? undefined,
    )
    const branding = await orgBranding()
    if ((url.searchParams.get('format') ?? 'json') === 'pdf') {
      const { result, layout } = payrollSlipFacsimile(slip, year, branding.baseCurrency)
      return pdfResponse(
        await renderTaxFormFacsimilePdf(
          result,
          { orgName: branding.orgName, primaryColor: branding.primaryColor },
          layout,
        ),
        `${safeName(slip.formCode)}-${year}-${safeName(row)}-${await businessToday(gate.user.orgId)}`,
      )
    }
    return NextResponse.json({ slip, orgName: branding.orgName, currency: branding.baseCurrency })
  } catch (e) {
    if (e instanceof PayrollPackError) return NextResponse.json({ error: e.message }, { status: 404 })
    if (e instanceof PayrollError) return NextResponse.json({ error: e.message }, { status: 422 })
    const rendererRefusal = rendererUnavailableResponse(e)
    if (rendererRefusal) return rendererRefusal
    throw e
  }
}
