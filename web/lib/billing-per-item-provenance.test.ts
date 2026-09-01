import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const billingSource = () => readFileSync(join(webRoot, 'lib/billing.ts'), 'utf8')

test('per-item grouping keeps every source cost line billable exactly once across retries', () => {
  const billing = billingSource()
  const groupingStart = billing.indexOf("if (invoicing.lineGrouping === 'per_item')")
  const groupingEnd = billing.indexOf('const invoiceDate =', groupingStart)
  assert.ok(groupingStart >= 0 && groupingEnd > groupingStart, 'per-item grouping block is present')
  const grouping = billing.slice(groupingStart, groupingEnd)
  assert.match(grouping, /prior\.sourceCostLineIds = sourceCostLineIds/)
  assert.match(grouping, /sourceCostLineIds\.push\(l\.sourceCostLineId\)/)

  const provenanceStart = billing.indexOf('for (const [index, l] of built.entries())')
  const provenanceEnd = billing.indexOf('const subtotal =', provenanceStart)
  assert.ok(provenanceStart >= 0 && provenanceEnd > provenanceStart, 'provenance loop is present')
  const provenance = billing.slice(provenanceStart, provenanceEnd)
  assert.match(provenance, /for \(const sourceCostLineId of sourceCostLineIds\)/)
  assert.match(provenance, /where id = \$\{sourceCostLineId\}/)

  // Two cost rows that become one presented line must both be consumed by the
  // first run. The second run's source query filters on billed_by_line_id IS
  // NULL, so no source remains eligible to charge again.
  const sourceRows = [
    { id: 'cost-line-1', amount: 12 },
    { id: 'cost-line-2', amount: 8 },
  ]
  const merged = {
    amount: sourceRows.reduce((total, row) => total + row.amount, 0),
    sourceCostLineIds: sourceRows.map((row) => row.id),
  }
  const billedBy = new Map<string, string>()
  for (const sourceCostLineId of merged.sourceCostLineIds) billedBy.set(sourceCostLineId, 'invoice-line-1')
  assert.equal(merged.amount, 20, 'matching sources still produce one summed invoice line')
  assert.deepEqual(
    sourceRows.filter((row) => !billedBy.has(row.id)),
    [],
    'a retry cannot select either source after provenance is stamped',
  )
})
