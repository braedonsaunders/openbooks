import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./CustomerView.tsx', import.meta.url), 'utf8')
const drawer = readFileSync(new URL('../_ui/DrillDrawer.tsx', import.meta.url), 'utf8')

test('customer health CSV exports retain revenue and CLV decimals', () => {
  assert.match(source, /rows\.map\(\(r\) => \[r\.name, r\.healthScore, r\.healthGrade, r\.revenue, r\.invoicedRevenue, r\.clv, /)
  assert.doesNotMatch(source, /Math\.round\(r\.(?:revenue|invoicedRevenue|clv)\)/)
})

test('customer health table shows invoiced beside recognized revenue', () => {
  assert.match(source, /t\('table\.invoiced'\)/)
  assert.match(source, /money\(r\.invoicedRevenue\)/)
})

test('customer drill carries the waterfall-signed recon bridge', () => {
  for (const key of ['recon.title', 'recon.tax', 'recon.credits', 'recon.deferred', 'recon.recognized', 'recon.voids', 'recon.other']) {
    assert.ok(source.includes(`t('${key}')`), `CustomerView must render ${key}`)
  }
  // Bridge stores gap contributions (invoiced − recognized); the display
  // negates each leg so recognized = invoiced + rows.
  assert.match(source, /amount: -r\.recon\.tax/)
  assert.match(source, /amount: -r\.recon\.timingDeferred/)
  assert.match(source, /amount: r\.recon\.timingRecognized/)
  assert.ok(drawer.includes('target.recon'), 'DrillDrawer must render the recon section when present')
})
