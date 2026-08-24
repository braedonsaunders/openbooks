import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const route = readFileSync(new URL('../app/api/reports/definitions/[id]/export/route.ts', import.meta.url), 'utf8')
const resolver = readFileSync(new URL('./report-run.ts', import.meta.url), 'utf8')

test('interactive report-definition PDFs stamp the footer from the org business day', () => {
  assert.match(
    route,
    /const stamp = await businessToday\(user\.orgId\)[\s\S]*?exportDataToPdf\(data, branding, page, \{[\s\S]*?generatedAt: new Date\(`\$\{stamp\}T00:00:00Z`\)/,
  )
})

test('interactive report-definition xlsx stamps workbook created/modified from the org business day', () => {
  assert.match(
    route,
    /const stamp = await businessToday\(user\.orgId\)[\s\S]*?exportDataToXlsx\(data, \{[\s\S]*?generatedAt: new Date\(`\$\{stamp\}T00:00:00Z`\)/,
  )
})

test('definition exports apply catalog URL filters and collect the full paged population', () => {
  assert.match(
    route,
    /resolveDefinitionToExportData\(user\.orgId, id, url\.searchParams/,
    'the route must pass the complete effective URL filter set to the shared resolver',
  )
  assert.match(resolver, /BUILT_IN_REPORT_DEFINITION_MAP\[row\.slug\]/)
  assert.match(resolver, /applyBuiltInUrlFilters\(\{ \.\.\.builtIn, query \}, p\)/)
  assert.match(resolver, /executeReportAllPages\(orgId, query\)/)
  assert.match(
    resolver,
    /reportPeriodField\(query\)[\s\S]*applyBuiltInUrlFilters/,
    'expiry cutoff filters must not manufacture an implicit fiscal period',
  )
})
