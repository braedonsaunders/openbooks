import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { computeTaxReturn } from '@openbooks/engine/src/tax-returns/return.ts'
import { guardPermission, guardSubsidiaryScope } from '../../../../../../lib/authz'
import { rendererUnavailableResponse } from '../../../../../../lib/api/pdf-renderer'
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
import { isMaskedFileContentError } from '../../../../../../lib/file-storage'
import { csvResponse, jsonResponse, pdfResponse, safeName, xlsxResponse } from '../../../../../../lib/export'
import { AdjustmentParamError, parseAdjustments } from '../tax-return-params'

export const runtime = 'nodejs'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Export a computed tax return as a facsimile PDF (or CSV / XLSX). */
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const scopeDenied = guardSubsidiaryScope(gate, null)
  if (scopeDenied) return scopeDenied
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

  let adjustments: Record<string, string>
  try {
    adjustments = parseAdjustments(p)
  } catch (e: unknown) {
    if (e instanceof AdjustmentParamError) {
      return NextResponse.json({ error: e.message }, { status: 400 })
    }
    throw e
  }
  try {
    const t = (await getTranslations('tax')) as unknown as Translator
    const result = await computeTaxReturn(gate.user.orgId, code, from, to, adjustments)
    const stamp = await businessToday(gate.user.orgId)
    const filename = `${safeName(code)}-${from}-${to}-${stamp}`

    // Official overlay: fill the tenant-uploaded government AcroForm and flatten.
    if (format === 'official') {
      const f = (await db.execute<{ official_pdf_file_id: string | null }>(sql`
        select official_pdf_file_id from tax_return_forms
         where org_id = ${gate.user.orgId} and code = ${code} limit 1`))
      const fileId = f.rows[0]?.official_pdf_file_id
      if (!fileId) return NextResponse.json({ error: 'no official PDF uploaded for this form' }, { status: 422 })
      let blob: Awaited<ReturnType<typeof getFileBlob>>
      try {
        blob = await getFileBlob(gate.user.orgId, fileId, { userId: gate.user.id, isAdmin: true })
      } catch (err) {
        // Masked-clone tombstone: refuse by name, never as a 422 export error.
        if (isMaskedFileContentError(err)) {
          return NextResponse.json({ error: (err as Error).message }, { status: 403 })
        }
        throw err
      }
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
      return xlsxResponse(await exportDataToXlsx(data, {
        reportName: data.title,
        dateRangeLabel: data.dateRangeLabel,
        generatedAt: new Date(`${stamp}T00:00:00Z`),
      }), filename)
    }
    const branding = await orgBranding()
    const { page, showSummary } = resolveLayout(null)
    return pdfResponse(await exportDataToPdf(data, branding, page, {
      showSummary,
      generatedAt: new Date(`${stamp}T00:00:00Z`),
    }), filename)
  } catch (e: unknown) {
    const rendererRefusal = rendererUnavailableResponse(e)
    if (rendererRefusal) return rendererRefusal
    return NextResponse.json({ error: e instanceof Error ? e.message : 'export failed' }, { status: 422 })
  }
}
