import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

function statusCounts<T extends { status: string }>(rows: T[]): Map<string, number> {
  return rows.reduce((counts, row) => counts.set(row.status, (counts.get(row.status) ?? 0) + 1), new Map())
}

test('capture status counts apply the PO and vendor subsidiary scope', () => {
  const countsQuery = page.match(/select ci\.status, count\(\*\)::int as n from ap_capture_items ci[\s\S]*?group by ci\.status/)
  assert.ok(countsQuery, 'status counts query must be present')
  assert.match(countsQuery[0], /left join parties vendor on vendor\.id = ci\.vendor_candidate_id and vendor\.org_id = ci\.org_id/)
  assert.match(countsQuery[0], /left join documents po on po\.id = ci\.purchase_order_id and po\.org_id = ci\.org_id/)
  assert.match(countsQuery[0], /where ci\.org_id = \$\{authz\.user\.orgId\}[\s\S]*?\$\{subsidiaryScope\}/)

  // A restricted reader sees only captures whose PO and vendor are either
  // org-wide or in the reader's allowed subsidiary set.
  const allowed = new Set(['sub-visible'])
  const mixed = [
    { status: 'queued', po: 'sub-visible', vendor: 'sub-visible' },
    { status: 'queued', po: 'sub-hidden', vendor: 'sub-visible' },
    { status: 'failed', po: null, vendor: 'sub-visible' },
    { status: 'failed', po: 'sub-visible', vendor: 'sub-hidden' },
  ]
  const visible = mixed.filter((row) =>
    (row.po === null || allowed.has(row.po)) && (row.vendor === null || allowed.has(row.vendor)),
  )
  assert.deepEqual(statusCounts(visible), new Map([['queued', 1], ['failed', 1]]))
})
