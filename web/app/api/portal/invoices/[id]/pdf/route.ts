import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { db, withOrgContext } from '@openbooks/engine/platform/database'
import { businessToday } from '@openbooks/engine/platform/business-date'
import { assertPortalDocument, resolvePortalSession } from '@openbooks/engine/portal'
import { rendererUnavailableResponse } from '@/lib/api/pdf-renderer'
import { unexpectedServerError } from '@/lib/api/unexpected'
import { pdfResponse, safeName } from '@/lib/export'
import { isUuid } from '@/lib/list-params'
import { PDF_RECORD_TYPE_BY_KEY } from '@/lib/pdf-templates/catalog'
import { mergeAndPrintPdf } from '@/lib/pdf-templates/render'
import { resolvePdfTemplate } from '@/lib/pdf-templates/store'
import { loadPdfRecordValues } from '@/lib/pdf-templates/values'

export const runtime = 'nodejs'

const pdfParams = z.object({ id: z.string() })

/**
 * Public: print one customer invoice through the org's template designer
 * output. The session token scopes the invoice — customer A names customer
 * B's invoice id and reads a 404.
 */
export const GET = defineRoute({
  public: 'token',
  params: pdfParams,
  handler: async ({ request, params }) => {
    const url = new URL(request.url)
    const session = await resolvePortalSession(url.searchParams.get('sessionToken') ?? '')
    if (!session) return NextResponse.json({ error: 'record not found' }, { status: 404 })
    if (!isUuid(params.id)) return NextResponse.json({ error: 'record not found' }, { status: 404 })
    const meta = PDF_RECORD_TYPE_BY_KEY['customer_invoice']
    if (!meta) return NextResponse.json({ error: 'unknown record type' }, { status: 400 })
    const invoice = await withOrgContext(session.orgId, () =>
      assertPortalDocument(db, session.orgId, session.partyId, params.id).catch(() => null))
    if (!invoice || invoice.kind !== 'customer_invoice') {
      return NextResponse.json({ error: 'record not found' }, { status: 404 })
    }
    const templateId = url.searchParams.get('template')
    if (templateId !== null && !isUuid(templateId)) {
      return NextResponse.json({ error: 'template not found' }, { status: 404 })
    }
    const [tpl, record] = await Promise.all([
      resolvePdfTemplate(session.orgId, 'customer_invoice', templateId),
      loadPdfRecordValues('customer_invoice', session.orgId, params.id, null),
    ])
    if (!tpl) return NextResponse.json({ error: 'template not found' }, { status: 404 })
    if (!record) return NextResponse.json({ error: 'record not found' }, { status: 404 })
    try {
      const pdf = await mergeAndPrintPdf(tpl, record.values)
      const stamp = await withOrgContext(session.orgId, () => businessToday(session.orgId))
      const response = pdfResponse(pdf, safeName(`${meta.docTitle} ${record.reference}-${stamp}`))
      if (tpl.provenance.templateId) response.headers.set('x-pdf-template-id', tpl.provenance.templateId)
      if (tpl.provenance.revision !== null) response.headers.set('x-pdf-template-revision', String(tpl.provenance.revision))
      response.headers.set('x-pdf-template-hash', tpl.provenance.contentHash)
      return response
    } catch (e) {
      const rendererRefusal = rendererUnavailableResponse(e)
      if (rendererRefusal) return rendererRefusal
      return unexpectedServerError('portal-invoice-pdf', e)
    }
  },
})
