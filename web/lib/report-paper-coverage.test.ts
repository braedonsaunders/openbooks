import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function source(relativePath: string): string {
  return readFileSync(join(webRoot, relativePath), 'utf8')
}

test('every in-app report result uses the shared paper surface', () => {
  const directReportPages = [
    'app/(app)/reports/aging/page.tsx',
    'app/(app)/reports/balance-sheet/page.tsx',
    'app/(app)/reports/budget/page.tsx',
    'app/(app)/reports/cash-flow/page.tsx',
    'app/(app)/reports/general-ledger/page.tsx',
    'app/(app)/reports/journal/page.tsx',
    'app/(app)/reports/orders/page.tsx',
    'app/(app)/reports/partners/page.tsx',
    'app/(app)/reports/pnl/page.tsx',
    'app/(app)/reports/project-profitability/page.tsx',
    'app/(app)/reports/registers/page.tsx',
    'app/(app)/reports/statements/[partyId]/page.tsx',
    'app/(app)/reports/trial-balance/page.tsx',
  ]

  for (const page of directReportPages) {
    const pageSource = source(page)
    assert.match(pageSource, /<(?:ReportPaper|PaperView|ProjectProfitabilityTable)\b/, `${page} must render the shared report paper`)
    assert.doesNotMatch(
      pageSource,
      /import\s*\{[^}]*\bTable\b[^}]*\}\s*from '@openbooks\/ui'/s,
      `${page} must not use the application list-table chrome`,
    )
  }

  assert.match(source('app/(app)/reports/PaperView.tsx'), /<ReportPaper\b/)
  assert.match(source('app/(app)/reports/PaperView.tsx'), /from '.\/ReportTable'/)
  assert.match(source('app/(app)/reports/custom/ResultView.tsx'), /<PaperView\b/)
  assert.match(source('app/(app)/reports/custom/builder/[id]/ReportBuilder.tsx'), /<PaperView\b/)
  assert.match(source('app/(app)/reports/custom/run/[id]/ReportRunner.tsx'), /<(?:ResultView|ReportPaper)\b/)
  assert.match(source('app/(app)/knowledge/views/[id]/page.tsx'), /<ResultView\b/)
  assert.match(source('app/(app)/knowledge/views/ViewStudio.tsx'), /<ResultView\b/)
  assert.match(source('components/app-shell.tsx'), /<GlobalReportDrawerHost\b/)
  assert.match(source('app/(app)/reports/PaperView.tsx'), /<ReportDrillLink\b/)
  assert.match(source('app/(app)/reports/StatementMatrixTable.tsx'), /<ReportDrillLink\b/)
  assert.match(source('app/(app)/reports/project-profitability/ProjectProfitabilityTable.tsx'), /<ReportPaper\b/)
  assert.doesNotMatch(source('lib/report-filters.ts'), /\/reports\/detail/)
})

test('every report result uses the P&L filter bar as one non-wrapping row', () => {
  const directReportPages = [
    'app/(app)/reports/aging/page.tsx',
    'app/(app)/reports/balance-sheet/page.tsx',
    'app/(app)/reports/budget/page.tsx',
    'app/(app)/reports/cash-flow/page.tsx',
    'app/(app)/reports/general-ledger/page.tsx',
    'app/(app)/reports/journal/page.tsx',
    'app/(app)/reports/orders/page.tsx',
    'app/(app)/reports/partners/page.tsx',
    'app/(app)/reports/pnl/page.tsx',
    'app/(app)/reports/project-profitability/page.tsx',
    'app/(app)/reports/registers/page.tsx',
    'app/(app)/reports/statements/[partyId]/page.tsx',
    'app/(app)/reports/trial-balance/page.tsx',
  ]

  for (const page of directReportPages) {
    const pageSource = source(page)
    assert.match(pageSource, /<ReportFilterBar\b/, `${page} must render the shared P&L filter bar`)
    assert.doesNotMatch(pageSource, /<SearchInput\b/, `${page} must not render search outside the shared filter bar`)
  }

  const filterBar = source('app/(app)/reports/ReportFilterBar.tsx')
  assert.match(filterBar, /flex-nowrap/)
  assert.match(filterBar, /overflow-x-auto/)
  assert.doesNotMatch(filterBar, /flex-wrap/)
  assert.match(filterBar, /controls\.search[\s\S]*<SearchInput\b/)
  assert.match(source('app/(app)/reports/custom/run/[id]/ReportRunner.tsx'), /<ReportFilterBar\b/)
  assert.match(source('app/(app)/reports/custom/page.tsx'), /if \(!query\) return/)
})

test('every collapsible report exposes shared expand-all and collapse-all controls', () => {
  const filterBar = source('app/(app)/reports/ReportFilterBar.tsx')
  assert.match(filterBar, /controls\.sections/)
  assert.match(filterBar, /setAllReportSections\('expand'\)/)
  assert.match(filterBar, /setAllReportSections\('collapse'\)/)
  assert.match(filterBar, /onOpenChange=\{setOptionsOpen\}[\s\S]*align="end"/)

  const statement = source('app/(app)/reports/StatementMatrixTable.tsx')
  assert.match(statement, /REPORT_SECTION_VISIBILITY_EVENT/)
  assert.match(statement, /new Set\(ranges\.keys\(\)\)/)
  assert.doesNotMatch(statement, /aria-label=\{isCollapsed \? 'Expand' : 'Collapse'\}/)

  const projects = source('app/(app)/reports/project-profitability/ProjectProfitabilityTable.tsx')
  assert.match(projects, /REPORT_SECTION_VISIBILITY_EVENT/)
  assert.match(projects, /new Set\(groups\.map/)
  assert.doesNotMatch(projects, /<Pagination\b/)
  assert.doesNotMatch(source('app/(app)/reports/project-profitability/page.tsx'), /\.slice\(/)

  for (const page of [
    'app/(app)/reports/pnl/page.tsx',
    'app/(app)/reports/balance-sheet/page.tsx',
    'app/(app)/reports/budget/page.tsx',
    'app/(app)/reports/project-profitability/page.tsx',
  ]) {
    assert.match(source(page), /sections:/, `${page} must enable the shared section control`)
  }
})

test('every direct report with numeric output exposes a drill target or native transaction link', () => {
  const numericReports = [
    'app/(app)/reports/aging/page.tsx',
    'app/(app)/reports/cash-flow/page.tsx',
    'app/(app)/reports/general-ledger/page.tsx',
    'app/(app)/reports/journal/page.tsx',
    'app/(app)/reports/orders/page.tsx',
    'app/(app)/reports/partners/page.tsx',
    'app/(app)/reports/project-profitability/page.tsx',
    'app/(app)/reports/registers/page.tsx',
    'app/(app)/reports/statements/[partyId]/page.tsx',
    'app/(app)/reports/trial-balance/page.tsx',
  ]
  for (const page of numericReports) {
    assert.match(source(page), /(?:ReportDrillLink|TxnLink|drills)/, `${page} must expose numeric drill-through`)
  }
  assert.match(source('app/(app)/reports/custom/ResultView.tsx'), /drillTarget/)
  assert.match(source('components/global-report-drawer-host.tsx'), /RelatedTransactionDrawerClient/)
})

test('report table primitives remain document-like rather than list-like', () => {
  const table = source('app/(app)/reports/ReportTable.tsx')
  assert.match(table, /border-slate-300/)
  assert.match(table, /border-b-\[3px\].*border-double/)
  assert.doesNotMatch(table, /rounded-(?:md|lg|xl)/)
  assert.doesNotMatch(table, /hover:bg-/)
  assert.doesNotMatch(table, /className=[^\n]*sticky/)
  assert.doesNotMatch(table, /framer-motion/)
})

test('project profitability establishes tenant scope before report queries', () => {
  const page = source('app/(app)/reports/project-profitability/page.tsx')
  assert.match(page, /await requirePermission\('reports\.read'\)/)
  assert.match(page, /resolvePeriod\([^\n]+orgId: authz\.user\.orgId/)
  assert.match(page, /orgInfo\(authz\.user\.orgId\)/)
  assert.match(page, /orgBranding\(authz\.user\.orgId\)/)
})
