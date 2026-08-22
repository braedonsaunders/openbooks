import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import type { TaxReturnResult } from '@openbooks/engine/src/tax-return.ts'
import { guardPermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { csvResponse, pdfResponse, safeName, xlsxResponse } from '../../../../../../lib/export'
import { taxReturnExportData } from '../../../../../../lib/tax-filing'
import { exportDataToCsv, exportDataToPdf, exportDataToXlsx, orgBranding, resolveLayout, type Translator } from '../../../../../../lib/report-pdf'

export const runtime = 'nodejs'

/** Export the frozen snapshot, never a recomputation of today's ledger. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
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
    }>(sql`
    select form_code, form_name, period_from::text, period_to::text, submission_channel,
           boxes, snapshot_hash, version
      from tax_filings where id = ${id} and org_id = ${gate.user.orgId} limit 1`))
  const row = saved.rows[0]
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const t = (await getTranslations('tax')) as unknown as Translator
  const result: TaxReturnResult = {
    formCode: row.form_code,
    formName: row.form_name,
    from: row.period_from,
    to: row.period_to,
    submissionChannel: row.submission_channel,
    watermark: t('history.snapshotWatermark', { hash: row.snapshot_hash }),
    boxes: row.boxes.map((box) => ({ ...box, pdfField: null })),
  }
  const data = taxReturnExportData(result, t)
  const stamp = await businessToday(gate.user.orgId)
  const filename = safeName(`${row.form_code}-${row.period_from}-${row.period_to}-v${row.version}-${stamp}`)
  if (format === 'csv') return csvResponse(exportDataToCsv(data, { sectionHeader: data.title }), filename)
  if (format === 'xlsx') return xlsxResponse(await exportDataToXlsx(data, { reportName: data.title, dateRangeLabel: data.dateRangeLabel }), filename)
  const branding = await orgBranding(gate.user.orgId)
  const { page, showSummary } = resolveLayout(null)
  return pdfResponse(await exportDataToPdf(data, branding, page, { showSummary }), filename)
}
