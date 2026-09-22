import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative: string) => readFileSync(join(root, relative), 'utf8')

test('UrlDrawer remounts on openKey and refuses a stale afterExit', () => {
  const drawer = read('../packages/ui/src/drawer.tsx')
  assert.match(drawer, /openKey/)
  assert.match(drawer, /nextDrawerShow/)
  assert.match(drawer, /shouldCommitDrawerCloseNavigation/)
})

test('navigation treats overlay-only hrefs as replaceState, not RSC', () => {
  const nav = read('components/navigation-provider.tsx')
  assert.match(nav, /isOverlayOnlyHrefChange/)
  assert.match(nav, /replaceState/)
  assert.match(nav, /setReloadPending\(true\)/)
  assert.match(nav, /router\.push/)
})

test('report drill, txn, and register links go through OverlayLink', () => {
  assert.match(read('app/(app)/reports/ReportDrillLink.tsx'), /OverlayLink/)
  assert.doesNotMatch(read('app/(app)/reports/ReportDrillLink.tsx'), /from 'next\/link'/)
  assert.match(read('app/(app)/reports/TxnLink.tsx'), /OverlayLink/)
  assert.doesNotMatch(read('app/(app)/reports/TxnLink.tsx'), /from 'next\/link'/)
  assert.match(read('components/account-register-link.tsx'), /OverlayLink/)
})

test('the report drawer host reads the overlay store and keys the panel on the target', () => {
  const host = read('components/global-report-drawer-host.tsx')
  assert.match(host, /useReportOverlay\(/)
  assert.match(host, /openKey=\{target/)
  assert.match(host, /hrefWithoutKeys/)
  assert.doesNotMatch(host, /useSearchParams/)
  assert.doesNotMatch(host, /useRouter/)
})

test('filter-bar paper changes strip overlay chrome and mark the reload', () => {
  const bar = read('app/(app)/reports/ReportFilterBar.tsx')
  assert.match(bar, /stripReportOverlay/)
  assert.match(bar, /beginReload/)
  assert.match(bar, /isOverlayOnlyHrefChange/)
})

test('aging rebuild uses a materialized line set and a per-line applications LATERAL', () => {
  const aging = read('lib/reports/aging.ts')
  assert.match(aging, /with doc_lines as materialized/)
  assert.match(aging, /left join lateral/)
  assert.match(aging, /from applications a/)
  assert.match(aging, /a\.from_line_id = dl\.line_id or a\.to_line_id = dl\.line_id/)
  assert.doesNotMatch(aging, /applied_lines as \(/)
})

test('aging drill passes party, bucket, and currency into the rebuild instead of discarding rows in JS', () => {
  const drill = read('lib/report-drill-data.ts')
  assert.match(drill, /partyId: target\.partyId/)
  assert.match(drill, /bucket: target\.bucket/)
  assert.match(drill, /reportingCurrency: target\.currency/)
  assert.doesNotMatch(
    drill,
    /result\.rows\.filter\(\(row\) => \(!target\.partyId/,
  )
})

test('bucketOf breakpoints are the ones the SQL predicate must match', () => {
  const aging = read('lib/reports/aging.ts')
  assert.match(
    aging,
    /export function bucketOf\(age: number\): AgingBucket \{\s+if \(age <= 0\) return "current"\s+if \(age <= 30\) return "b1"\s+if \(age <= 60\) return "b2"\s+if \(age < 90\) return "b3"\s+return "b4"/,
  )
  assert.match(aging, /bucket === "current"\) return sql`\$\{age\} <= 0`/)
  assert.match(aging, /bucket === "b1"\) return sql`\$\{age\} > 0 and \$\{age\} <= 30`/)
  assert.match(aging, /bucket === "b2"\) return sql`\$\{age\} > 30 and \$\{age\} <= 60`/)
  assert.match(aging, /bucket === "b3"\) return sql`\$\{age\} > 60 and \$\{age\} < 90`/)
  assert.match(aging, /return sql`\$\{age\} >= 90`/)
})
