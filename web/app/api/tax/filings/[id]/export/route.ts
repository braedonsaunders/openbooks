import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import type { TaxReturnResult } from '@openbooks/engine/src/tax-returns/return.ts'
import { guardPermission, guardSubsidiaryScope } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { csvResponse, pdfResponse, safeName, xlsxResponse } from '../../../../../../lib/export'
import { taxReturnExportData } from '../../../../../../lib/tax-filing'
import { exportDataToCsv, exportDataToPdf, exportDataToXlsx, orgBranding, resolveLayout, type Translator } from '../../../../../../lib/report-pdf'

export const runtime = 'nodejs'

/** Export the frozen snapshot, never a recomputation of today's ledger. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const scopeDenied = guardSubsidiaryScope(gate, null)
  if (scopeDenied) return scopeDenied
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const format = new URL(req.url).searchParams.get('format')?.toLowerCase() ?? 'pdf'
  if (!['pdf', 'xlsx', 'csv'].includes(format)) return NextResponse.json({ error: 'invalid format' }, { status: 422 })

  const saved = (await db.execute<{
      form_code: string
      form_name: string
      period_from: string
      period_to: string
      submission_channel: string
      boxes: { lineCode: string; label: string; value: string; computed: boolean; editable: boolean }[]
      snapshot_hash: string
      version: number
      functional_currency: string | null
      translation: TaxReturnResult['translation']
      subsidiary_ids: string[] | null
      registration_id: string | null
      registration_number: string | null
    }>(sql`
    select form_code, form_name, period_from::text, period_to::text, submission_channel,
           boxes, snapshot_hash, version,
           functional_currency, translation, subsidiary_ids,
           registration_id, registration_number
      from tax_filings where id = ${id} and org_id = ${gate.user.orgId} limit 1`))
  const row = saved.rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  // Fail closed: a pre-snapshot filing whose currency the backfill could not
  // determine carries no honest denomination. Refuse the reprint with the
  // remedy (prepare a new version) rather than relabelling frozen boxes with
  // the org's current base currency.
  if (!row.functional_currency) {
    return NextResponse.json(
      { error: 'this filing predates frozen filing currency — prepare a new version to export it' },
      { status: 422 },
    )
  }
  const t = (await getTranslations('tax')) as unknown as Translator
  const result: TaxReturnResult = {
    formCode: row.form_code,
    formName: row.form_name,
    from: row.period_from,
    to: row.period_to,
    submissionChannel: row.submission_channel,
    watermark: t('history.snapshotWatermark', { hash: row.snapshot_hash }),
    // The reprint carries the posture frozen at prepare time (0265), never
    // live configuration: the registration that was certified, the
    // denomination the boxes were computed in, the scope that was summed.
    // A pre-snapshot (v1) row stores none of that, so it reprints with no
    // registration identity rather than a number that may have changed since,
    // and an empty scope rather than an invented one.
    registrationNumber: row.registration_number,
    functionalCurrency: row.functional_currency,
    subsidiaryIds: row.subsidiary_ids ?? [],
    registrationId: row.registration_id,
    translation: row.translation,
    boxes: row.boxes.map((box) => ({ ...box, pdfField: null })),
  }
  const data = taxReturnExportData(result, t)
  const stamp = await businessToday(gate.user.orgId)
  const filename = safeName(`${row.form_code}-${row.period_from}-${row.period_to}-v${row.version}-${stamp}`)
  if (format === 'csv') return csvResponse(exportDataToCsv(data, { sectionHeader: data.title }), filename)
  if (format === 'xlsx') return xlsxResponse(await exportDataToXlsx(data, {
    reportName: data.title,
    dateRangeLabel: data.dateRangeLabel,
    generatedAt: new Date(`${stamp}T00:00:00Z`),
  }), filename)
  const branding = await orgBranding(gate.user.orgId)
  const { page, showSummary } = resolveLayout(null)
  return pdfResponse(await exportDataToPdf(data, branding, page, {
    showSummary,
    generatedAt: new Date(`${stamp}T00:00:00Z`),
  }), filename)
}
