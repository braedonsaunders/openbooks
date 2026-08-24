import type { ReportRunResult } from '@openbooks/reports'
import type { PaperGroup } from '../PaperView'
import type { ReportDrillTarget } from '../../../../lib/report-drill'

const NUMERIC_CELL = /^-?[\d,]+(\.\d+)?$/

/**
 * Preserve every engine-authored rendering hint while adding viewer-only
 * aggregate drills. In particular, `cellLinks` is the authoritative native
 * record target for detail rows; it must reach PaperView unchanged so the
 * existing transaction drawer owns navigation.
 *
 * Pure and side-effect free so the report suites can execute it directly
 * under the repo's `*.test.ts` gates without pulling a React component
 * graph (see paper-groups coverage in ResultView.test.ts).
 */
export function resultGroupsForPaper(
  result: ReportRunResult,
  drillTarget: ReportDrillTarget,
): PaperGroup[] {
  return result.groups.map((group) => ({
    title: group.title,
    subtitle: group.subtitle,
    columns: group.columns,
    rows: group.rows,
    money: group.money,
    align: group.align,
    totalRows: group.totalRows,
    cellLinks: group.cellLinks,
    drills: group.kind === 'summary' && group.rowKeys && drillTarget.kind === 'custom'
      ? group.rows.map((row, ri) => {
          const scope = group.rowKeys?.[ri]
          if (!scope) return row.map(() => undefined)
          return row.map((cell) =>
            (typeof cell === 'number' || (typeof cell === 'string' && NUMERIC_CELL.test(cell.trim())))
              ? { ...drillTarget, filter: scope }
              : undefined,
          )
        })
      : undefined,
    isEmpty: group.isEmpty,
  }))
}
