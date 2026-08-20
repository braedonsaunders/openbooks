import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { computeTaxReturn } from '@openbooks/engine/src/tax-return.ts'
import { guardPermission } from '../../../../../../lib/authz'
import {
  exportDataToCsv,
  exportDataToPdf,
  exportDataToXlsx,
  orgBranding,
  resolveLayout,
  type Translator,
} from '../../../../../../lib/report-pdf'
import { taxReturnExportData } from '../../../../../../lib/tax-filing'
import { renderTaxFormFacsimilePdf } from '../../../../../../lib/tax-form-facsimile'
import { taxReturnToJsonString } from '../../../../../../lib/tax-return-structured'
import { fillOfficialTaxPdf } from '../../../../../../lib/tax-official-pdf'
import { getFileBlob } from '../../../../../../lib/file-cabinet'
import { csvResponse, jsonResponse, pdfResponse, safeName, xlsxResponse } from '../../../../../../lib/export'
import { parseAdjustments } from '../tax-return-params'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Export a computed tax return as a facsimile PDF (or CSV / XLSX). */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const { code } = await params
  const p = new URL(req.url).searchParams
  const from = p.get('from')
  const to = p.get('to')
  const format = (p.get('format') ?? 'pdf').toLowerCase()
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: 'from and to dates (YYYY-MM-DD) are required' }, { status: 422 })
  }
  if (!['pdf', 'facsimile', 'json', 'xlsx', 'csv', 'official'].includes(format)) {
    return NextResponse.json({ error: 'invalid format' }, { status: 422 })
  }

  try {
    const t = (await getTranslations('tax')) as unknown as Translator
    const result = await computeTaxReturn(gate.user.orgId, code, from, to, parseAdjustments(p))
    const filename = `${safeName(code)}-${from}-${to}`

    // Official overlay: fill the tenant-uploaded government AcroForm and flatten.
    if (format === 'official') {
      const f = (await db.execute<{ official_pdf_file_id: string | null }>(sql`
        select official_pdf_file_id from tax_return_forms
         where org_id = ${gate.user.orgId} and code = ${code} limit 1`))
      const fileId = f.rows[0]?.official_pdf_file_id
      if (!fileId) return NextResponse.json({ error: 'no official PDF uploaded for this form' }, { status: 422 })
      const blob = await getFileBlob(gate.user.orgId, fileId, { userId: gate.user.id, isAdmin: true })
      if (!blob) return NextResponse.json({ error: 'official PDF not found' }, { status: 404 })
      const { bytes } = await fillOfficialTaxPdf(new Uint8Array(blob.bytes), result.boxes)
      return pdfResponse(Buffer.from(bytes), `${filename}-official`)
    }

    // Form-faithful facsimile: our own HTML replica of the government form,
    // printed to PDF — looks like the real return, works for every jurisdiction.
    if (format === 'facsimile') {
      const branding = await orgBranding()
      return pdfResponse(
        await renderTaxFormFacsimilePdf(result, { orgName: branding.orgName, primaryColor: branding.primaryColor }),
        `${filename}-facsimile`,
      )
    }

    // Structured export: the return's boxes as machine-readable JSON, grouped by
    // section — the deliverable for portal/JSON-filed returns (e.g. India GSTR).
    if (format === 'json') {
      return jsonResponse(taxReturnToJsonString(result), `${filename}-return`)
    }

    const data = taxReturnExportData(result, t)

    if (format === 'csv') {
      return csvResponse(exportDataToCsv(data, { sectionHeader: data.title }), filename)
    }
    if (format === 'xlsx') {
      return xlsxResponse(await exportDataToXlsx(data, { reportName: data.title, dateRangeLabel: data.dateRangeLabel }), filename)
    }
    const branding = await orgBranding()
    const { page, showSummary } = resolveLayout(null)
    return pdfResponse(await exportDataToPdf(data, branding, page, { showSummary }), filename)
  } catch (e: unknown) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'export failed' }, { status: 422 })
  }
}
