import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { toUnits } from '../../engine/src/money/money.ts'
import { createMoneyFormatter } from './money-format.ts'
import type { CustomerLabourRow } from './invoice-backup.ts'

// invoice-backup is a server-only module; mock that marker so its pure amount
// allocator can be exercised directly without starting a Next.js server.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@openbooks/engine/src/') || specifier.startsWith('@openbooks/schema/src/')) {
      const [packageName, ...packagePath] = specifier.slice('@openbooks/'.length).split('/')
      if (packageName !== 'engine' && packageName !== 'schema') {
        // Workspace packages declare their own subpath exports (networking's
        // ./ssrf maps to ./src/ssrf.ts); resolve those for real instead of
        // guessing a source path the package never had.
        return nextResolve(specifier, context)
      }
      const packageRoot = `../../${packageName}`
      const localPath = packagePath.length ? packagePath.join('/') : 'src/index.ts'
      return { shortCircuit: true, url: new URL(`${packageRoot}/${localPath}`, import.meta.url).href }
    }
    return nextResolve(specifier, context)
  },
})
const { allocateTimesheetBillAmounts, provenanceOf, projectCustomerLabourBackup, customerLabourBackupHtml } = await import('./invoice-backup.ts')
hooks.deregister()

const unitsTotal = (amounts: readonly string[]) => amounts.reduce((total, amount) => total + toUnits(amount), 0n)

test('a rolled-up line allocates its full posted amount by native bill value', () => {
  const shares = allocateTimesheetBillAmounts({
    lineAmount: '100.0000',
    // These are the exact hours × bill-rate values for the three entries.
    nativeBillAmounts: ['1.0000', '2.0000', '3.0000'],
  })

  assert.deepEqual(shares, ['16.6667', '33.3333', '50.0000'])
  assert.equal(unitsTotal(shares), toUnits('100.0000'))
})

test('negative and fractional posted totals cross-foot exactly in bigint units', () => {
  const negative = allocateTimesheetBillAmounts({
    lineAmount: '-100.0000',
    nativeBillAmounts: ['1.0000', '2.0000', '3.0000'],
  })
  assert.deepEqual(negative, ['-16.6667', '-33.3333', '-50.0000'])
  assert.equal(unitsTotal(negative), toUnits('-100.0000'))

  const fractional = allocateTimesheetBillAmounts({
    lineAmount: '0.0005',
    nativeBillAmounts: ['1.0000', '1.0000'],
  })
  assert.deepEqual(fractional, ['0.0003', '0.0002'])
  assert.equal(unitsTotal(fractional), toUnits('0.0005'))
})

test('a zero native total uses equal weights and largest-remainder tie order', () => {
  const shares = allocateTimesheetBillAmounts({
    lineAmount: '100.0000',
    nativeBillAmounts: ['0.0000', '0.0000', '0.0000'],
  })

  assert.deepEqual(shares, ['33.3334', '33.3333', '33.3333'])
  assert.equal(unitsTotal(shares), toUnits('100.0000'))
  assert.deepEqual(
    shares,
    allocateTimesheetBillAmounts({ lineAmount: '100.0000', nativeBillAmounts: ['0.0000', '0.0000', '0.0000'] }),
  )
})

test('a line linked to one entry keeps its exact posted amount', () => {
  assert.deepEqual(
    allocateTimesheetBillAmounts({ lineAmount: '12.34', nativeBillAmounts: ['125.0000'] }),
    ['12.3400'],
  )
})

test('a backup manifest entry pins the exact template design that printed it', () => {
  // The archived packet's component manifest is the immutable evidence of
  // which design each page was printed with: id + revision + content hash.
  assert.deepEqual(
    provenanceOf({
      compiledHtml: '<p/>',
      paperSize: 'letter',
      orientation: 'portrait',
      marginMm: 14,
      headerHtml: null,
      footerHtml: null,
      provenance: { templateId: 'template-9', revision: 2, contentHash: 'cafe01' },
    }),
    { id: 'template-9', revision: 2, hash: 'cafe01' },
  )
  assert.deepEqual(
    provenanceOf({
      compiledHtml: '<p/>',
      paperSize: 'letter',
      orientation: 'portrait',
      marginMm: 14,
      headerHtml: null,
      footerHtml: null,
      provenance: { templateId: null, revision: null, contentHash: 'cafe02' },
    }),
    { id: null, revision: null, hash: 'cafe02' },
  )
})

const customerLabourRows: CustomerLabourRow[] = [
  {
    time_entry_id: 'entry-1', line_id: 'line-large', worked_on: '2026-10-07',
    employee: 'Alex & Morgan', item: 'Service <inspection>', hours: '1.0001',
    bill_rate: '123.4567', line_amount: '900719925474099.1234', native_bill_amount: '1.0000',
    cost_rate: '9876.5432', cost_amount: '777654321.2345', total_cost: '888543219.8765',
  },
  {
    time_entry_id: 'entry-2', line_id: 'line-adjustment', worked_on: '2026-10-08',
    employee: 'Jordan', item: 'Adjustment', hours: '0.0001', bill_rate: '3.0000',
    line_amount: '-0.0005', native_bill_amount: '1.0000', cost_rate: '9876.5432',
  },
  {
    time_entry_id: 'entry-3', line_id: 'line-large', worked_on: '2026-10-08',
    employee: 'Taylor', item: 'Service', hours: '2.0000', bill_rate: '123.4567',
    line_amount: '900719925474099.1234', native_bill_amount: '2.0000', cost_amount: '777654321.2345',
  },
]

test('customer labour projection excludes internal costing and cross-foots independent invoice groups exactly', () => {
  const { entries, totals } = projectCustomerLabourBackup(customerLabourRows)
  assert.deepEqual(entries.map((entry) => entry.time_entry_id), ['entry-1', 'entry-2', 'entry-3'])
  assert.deepEqual(entries.map((entry) => entry.bill_amount), [
    '300239975158033.0411', '-0.0005', '600479950316066.0823',
  ])
  assert.equal(unitsTotal(entries.filter((entry) => entry.line_id === 'line-large').map((entry) => entry.bill_amount)), toUnits('900719925474099.1234'))
  assert.deepEqual(totals, { hours: '3.0002', bill: '900719925474099.1229' })
  for (const entry of entries) {
    assert.equal('cost_rate' in entry, false)
    assert.equal('cost_amount' in entry, false)
    assert.equal('total_cost' in entry, false)
  }
  assert.equal(projectCustomerLabourBackup(customerLabourRows).entries[0]?.bill_amount, entries[0]?.bill_amount)
})

for (const title of ['Labour Backup', 'Shop Labour Backup'] as const) {
  test(`${title} renderer shows only customer evidence and exact allocated amounts`, () => {
    const format = createMoneyFormatter('en-CA', 'CAD')
    const html = customerLabourBackupHtml(customerLabourRows, 'INV<&>', 'Project & Site', title, format)
    assert.ok(html.includes(`<h1>${title}</h1>`))
    assert.ok(html.includes('INV&lt;&amp;&gt;'))
    assert.ok(html.includes('Project &amp; Site'))
    assert.ok(html.includes('Alex &amp; Morgan'))
    assert.ok(html.includes('Service &lt;inspection&gt;'))
    assert.ok(html.includes('2026-10-07'))
    const headings = [...html.matchAll(/<th(?: class="n")?>([^<]+)<\/th>/g)].map((match) => match[1])
    assert.deepEqual(headings, ['Date', 'Employee', 'Service', 'Hours', 'Bill rate', 'Amount'])
    assert.doesNotMatch(html, /cost(?:ed)?(?:[ _]rate|[ _]amount|[ _]total)?/i)
    for (const internal of ['9876.5432', '777654321.2345', '888543219.8765']) {
      assert.equal(html.includes(internal), false)
      assert.equal(html.includes(format.money(internal)), false)
      assert.equal(html.includes(format.money(internal, { maximumFractionDigits: 4 })), false)
    }
    const { entries, totals } = projectCustomerLabourBackup(customerLabourRows)
    for (const entry of entries) {
      assert.ok(html.includes(format.money(entry.bill_amount, { maximumFractionDigits: 4 })))
    }
    assert.ok(html.includes(format.money('123.4567', { maximumFractionDigits: 4 })))
    const footer = html.split('<tfoot>')[1]!
    assert.ok(footer.includes(format.money(totals.bill, { maximumFractionDigits: 4 })), footer)
    assert.ok(footer.includes('3.0002'), footer)
  })
}
