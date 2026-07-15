import { getTranslations } from 'next-intl/server'
import { Button } from '@openbooks/ui'
import { Download, FileText, Sheet } from 'lucide-react'

/**
 * Export buttons for a financial statement: PDF, Excel, CSV. Links are plain
 * <a> downloads to the statement export route, preserving the current filters
 * (from/to/asOf/dept/project/side) so the exported document matches what's on
 * screen.
 */
export async function StatementExport({
  kind,
  params,
}: {
  kind: string
  params: Record<string, string | undefined>
}) {
  const t = await getTranslations('reports.export')
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v)
  const base = `/api/reports/statement/${kind}/export`
  const pdf = `${base}?${new URLSearchParams({ format: 'pdf', ...Object.fromEntries(qs) })}`
  const xlsx = `${base}?${new URLSearchParams({ format: 'xlsx', ...Object.fromEntries(qs) })}`
  const csv = `${base}?${new URLSearchParams({ format: 'csv', ...Object.fromEntries(qs) })}`
  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" asChild>
        <a href={pdf}>
          <FileText size={15} /> {t('pdf')}
        </a>
      </Button>
      <Button variant="outline" asChild>
        <a href={xlsx}>
          <Sheet size={15} /> {t('xlsx')}
        </a>
      </Button>
      <Button variant="outline" asChild>
        <a href={csv}>
          <Download size={15} /> {t('csv')}
        </a>
      </Button>
    </div>
  )
}
