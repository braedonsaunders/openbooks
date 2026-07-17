import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { resolveDefinitionToExportData } from '../../../../../lib/report-run'
import { exportDataToPdf, orgBranding, resolveLayout, type Translator } from '../../../../../lib/report-pdf'
import { resolvePeriod } from '../../../../../lib/periods'
import { parseReportQuery } from '../../../../../lib/report-filters'

export const runtime = 'nodejs'

/**
 * Internal report render endpoint — the background worker calls this to turn a
 * definition into a PDF (report rendering lives in web/lib; the worker can't
 * import it). Not a user route: authenticated by a shared internal token and
 * given orgId + definitionId explicitly.
 *
 *   GET /api/internal/reports/render?orgId=&definitionId=&<report params>
 */
export async function GET(req: Request) {
  const expected = process.env.OPENBOOKS_INTERNAL_TOKEN || ''
  const provided = req.headers.get('x-internal-token') || ''
  if (!expected || provided !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const p = url.searchParams
  const orgId = p.get('orgId')
  const definitionId = p.get('definitionId')
  if (!orgId || !definitionId) {
    return NextResponse.json({ error: 'orgId and definitionId are required' }, { status: 422 })
  }

  try {
    const t = (await getTranslations('reports')) as unknown as Translator
    const q = parseReportQuery(p)
    const period = await resolvePeriod(q.period, { customFrom: p.get('from') ?? undefined, customTo: p.get('to') ?? undefined })
    const data = await resolveDefinitionToExportData(orgId, definitionId, p, { orgId, t, period, query: q })
    const branding = await orgBranding()
    const { page, showSummary } = resolveLayout(null)
    const pdf = await exportDataToPdf(data, branding, page, { showSummary })
    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store' },
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'render failed' }, { status: 422 })
  }
}
