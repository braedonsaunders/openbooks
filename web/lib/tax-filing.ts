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
  const netBox =
    result.boxes.find((b) => b.lineCode === '113C') ??
    result.boxes.find((b) => b.lineCode === '109')
  const summary = [] as ExportData['summary']
  // Tax boxes are exact numeric(19,4) strings from the filing engine. Keep
  // them as strings and mark them as money so every export renderer receives
  // the statutory value without an IEEE-754 round-trip.
  if (netBox) summary.push({ label: netBox.label, value: netBox.value, money: true })
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
        rows: result.boxes.map((b) => [b.lineCode, b.label, b.value] as (string | number)[]),
        money: [false, false, true],
        align: ['left', 'left', 'right'],
      },
    ],
  }
}
