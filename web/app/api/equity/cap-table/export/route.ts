import { getTranslations } from 'next-intl/server'
import { z } from 'zod'
import { resolvePdfPageSetup } from '@openbooks/pdf'
import { loadCapTableView } from '@openbooks/engine/equity'
import { businessToday } from '@openbooks/engine/platform/business-date/module'
import { defineRoute } from '@/lib/api/route'
import { isoDate, uuidId } from '@/lib/api/json'
import { capTableExportData } from '@/lib/equity-cap-table-export'
import { csvResponse, pdfResponse, safeName, xlsxResponse } from '@/lib/export'
import { exportDataToCsv, exportDataToPdf, exportDataToXlsx, orgBranding } from '@/lib/report-pdf'
import { reportCsvOptions } from '@/lib/report-labels'
import { parseQuery } from '../../_schema'

export const runtime = 'nodejs'

const query = z.object({
  subsidiaryId: uuidId,
  asOf: isoDate(),
  by: z.enum(['class', 'holder']).default('class'),
  format: z.enum(['pdf', 'xlsx', 'csv']),
})

/** The legal entity's cap table as of a date, by class or by holder, as PDF, Excel or CSV. */
export const GET = defineRoute({
  permission: 'equity.read',
  feature: 'equity',
  handler: async ({ authz, request }) => {
    const parsed = parseQuery(request, query)
    if (!parsed.ok) return parsed.response
    const { subsidiaryId, asOf, by, format } = parsed.data
    const view = await loadCapTableView({ orgId: authz.user.orgId, actorId: authz.user.id, subsidiaryId, asOf })
    const t = await getTranslations('equity')
    const data = capTableExportData(view, by, {
      title: t('capTable.exportTitle', { entity: view.entity.name }),
      dateRange: t('capTable.exportAsOf', { date: asOf }),
      class: t('capTable.columns.class'),
      kind: (kind) => t(`classKind.${kind}`),
      holder: t('capTable.columns.holder'),
      authorized: t('capTable.columns.authorized'),
      outstanding: t('capTable.columns.outstanding'),
      asConverted: t('capTable.columns.asConverted'),
      awards: t('capTable.columns.awards'),
      pool: t('capTable.columns.pool'),
      fullyDiluted: t('capTable.columns.fullyDiluted'),
      outstandingPercent: t('capTable.columns.outstandingPercent'),
      fullyDilutedPercent: t('capTable.columns.fullyDilutedPercent'),
      options: t('capTable.columns.options'),
      rsus: t('capTable.columns.rsus'),
      warrants: t('capTable.columns.warrants'),
      totalOutstanding: t('capTable.totalOutstanding'),
      totalFullyDiluted: t('capTable.totalFullyDiluted'),
      poolUnallocated: t('capTable.poolUnallocated'),
    })
    const stamp = await businessToday(authz.user.orgId)
    const filename = safeName(`${view.entity.name}-cap-table-${by}-${asOf}`)
    if (format === 'csv') {
      const { sectionHeader } = await reportCsvOptions()
      return csvResponse(exportDataToCsv(data, { sectionHeader }), filename)
    }
    if (format === 'xlsx') {
      return xlsxResponse(await exportDataToXlsx(data, { reportName: data.title, dateRangeLabel: data.dateRangeLabel, generatedAt: new Date(`${stamp}T00:00:00Z`) }), filename)
    }
    const page = resolvePdfPageSetup({ paperSize: 'letter', orientation: 'landscape', marginMm: 12, density: 'compact' })
    return pdfResponse(await exportDataToPdf(data, await orgBranding(authz.user.orgId), page, { generatedAt: new Date(`${stamp}T00:00:00Z`) }), filename)
  },
})
