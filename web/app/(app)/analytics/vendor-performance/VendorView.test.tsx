import assert from 'node:assert/strict'
import test from 'node:test'
import { bootViewTests, mountView, captureCsvDownload } from '../_view-test-harness'
import { vendorFixture, unratedRow } from './vendor-view-fixtures'

// Vendor CSVs must carry exact spend and average-bill values: the export
// passes the ledger amounts straight through instead of rounding them.

// Deferred past boot: the view pulls charts that must resolve after jsdom.
await bootViewTests('http://localhost:4800/analytics/vendor-performance')
const { VendorView } = await import('./VendorView')

test('vendor CSV exports retain spend and average bill decimals', async () => {
  const { host, click, cleanup } = await mountView(<VendorView data={vendorFixture()} />, 'Vendors')
  try {
    const { text, downloadedFile, clickedHref } = await captureCsvDownload(async () => {
      const exportButton = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('CSV'))
      assert.ok(exportButton, 'the vendors table must offer a CSV export')
      await click(exportButton)
    }, 'blob:vendor-export-test')
    assert.ok(text.includes('9876.543'), `spend must stay decimal, got:\n${text}`)
    assert.ok(text.includes('123.456'), `average bill must stay decimal, got:\n${text}`)
    assert.equal(downloadedFile, 'vendors-2026-08-28.csv')
    assert.equal(clickedHref, 'blob:vendor-export-test')
  } finally {
    await cleanup()
  }
})

test('unrated vendors read Unrated with a per-cause remedy, never a neutral score', async () => {
  const data = vendorFixture()
  data.rows.push(unratedRow('v-new', 'Brand New Co', 'no-payments', 0))
  data.rows.push(unratedRow('v-undated', 'Undated Bills Co', 'undated', 1))
  const { host, click, cleanup } = await mountView(<VendorView data={data} />)
  try {
    const scorecardTab = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Scorecard')
    assert.ok(scorecardTab, 'the scorecard tab must exist')
    await click(scorecardTab)
    assert.ok((host.textContent ?? '').includes('Unrated'), `an unrated vendor must be named as Unrated, got:\n${host.textContent}`)
    const matrixTab = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Leverage Matrix')
    assert.ok(matrixTab, 'the matrix tab must exist')
    await click(matrixTab)
    const text = host.textContent ?? ''
    assert.ok(text.includes('settle bills to rate'), `a vendor with no payments must be told to settle bills, got:\n${text}`)
    assert.ok(text.includes('add due dates or payment terms'), `a settled-but-undated vendor must be told to date its bills, got:\n${text}`)
  } finally {
    await cleanup()
  }
})
