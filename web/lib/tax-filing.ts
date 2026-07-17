import 'server-only'
import type { ExportData, Translator } from './report-pdf'
import type { TaxReturnResult } from '@openbooks/engine/src/tax-return.ts'

/**
 * Shape a computed tax return into the shared ExportData so it flows through the
 * same PDF / Excel / CSV pipeline as every financial statement. The facsimile is
 * a faithful working copy of the government form — its boxes in order — carrying
 * the jurisdiction's not-for-filing notice where the law requires one.
 */
export function taxReturnExportData(result: TaxReturnResult, t: Translator): ExportData {
  const netBox = result.boxes.find((b) => b.lineCode === '113') ?? result.boxes.find((b) => b.lineCode === '109')
  const summary = [] as ExportData['summary']
  if (netBox) summary.push({ label: netBox.label, value: Number(netBox.value) })
  if (result.watermark) summary.push({ label: t('notice'), value: result.watermark })

  return {
    title: result.formName,
    dateRangeLabel: t('period', { from: result.from, to: result.to }),
    summary,
    groups: [
      {
        kind: 'results',
        title: result.formName,
        columns: [t('columns.line'), t('columns.description'), t('columns.amount')],
        rows: result.boxes.map((b) => [b.lineCode, b.label, Number(b.value)] as (string | number)[]),
        align: ['left', 'left', 'right'],
      },
    ],
  }
}
