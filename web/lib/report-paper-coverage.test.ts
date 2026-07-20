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
    'app/(app)/reports/detail/page.tsx',
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
    assert.match(source(page), /<(?:ReportPaper|PaperView)\b/, `${page} must render the shared report paper`)
  }

  assert.match(source('app/(app)/reports/PaperView.tsx'), /<ReportPaper\b/)
  assert.match(source('app/(app)/reports/custom/ResultView.tsx'), /<PaperView\b/)
  assert.match(source('app/(app)/reports/custom/builder/[id]/ReportBuilder.tsx'), /<PaperView\b/)
  assert.match(source('app/(app)/reports/custom/run/[id]/ReportRunner.tsx'), /<(?:ResultView|ReportPaper)\b/)
  assert.match(source('app/(app)/knowledge/views/[id]/page.tsx'), /<ResultView\b/)
  assert.match(source('app/(app)/knowledge/views/ViewStudio.tsx'), /<ResultView\b/)
})

test('project profitability establishes tenant scope before report queries', () => {
  const page = source('app/(app)/reports/project-profitability/page.tsx')
  assert.match(page, /await requirePermission\('reports\.read'\)/)
  assert.match(page, /resolvePeriod\([^\n]+orgId: authz\.user\.orgId/)
  assert.match(page, /orgInfo\(authz\.user\.orgId\)/)
  assert.match(page, /orgBranding\(authz\.user\.orgId\)/)
})
