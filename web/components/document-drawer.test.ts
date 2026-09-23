import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyQtyPriceToRows,
  clearedDistributionFields,
  computeDocumentDrawerTotals,
  distributionFieldsOf,
  findCurrencyMismatchedAccount,
  findMissingAccountLine,
  hasDrawerLineAccount,
  isBlankDrawerLine,
  lineAmountFromQtyPrice,
  readDocumentActionResult,
} from './document-drawer'

const row = (accountId: string, amount: string) => ({
  accountId,
  amount,
  taxInputAmount: '',
  taxProfileId: '',
  taxOverridden: false,
  taxAmount: '',
})

// A grid row exactly as the drawer seeds it: every cell blank.
const blankGridRow = () => ({
  lineId: '',
  clientKey: 'seed',
  accountId: '',
  itemId: '',
  description: '',
  quantity: '',
  unit: '',
  unitPrice: '',
  costRate: '',
  billRate: '',
  billAmount: '',
  isBillable: false,
  departmentId: '',
  projectId: '',
  locationId: '',
  classId: '',
  stockLocationId: '',
  returnSourceMovementId: '',
  taxProfileId: '',
  amount: '',
  taxInputAmount: '',
  taxOverridden: false,
  taxAmount: '',
  distributionGroupId: '',
  distributionRuleId: '',
  distributionRuleName: '',
  distributionVersionId: '',
  distributionLocked: false,
  distributionKey: '',
})

test('only a truly blank placeholder row is blank', () => {
  assert.equal(isBlankDrawerLine(blankGridRow()), true)
  assert.equal(isBlankDrawerLine(row('', '')), true)
  // An account alone is content: it rides to the server, which refuses the
  // missing amount by line name.
  assert.equal(isBlankDrawerLine(row('a', '   ')), false)
  // Whitespace-only cells are untouched cells, not content.
  assert.equal(isBlankDrawerLine({ ...blankGridRow(), description: '   ' }), true)
})

test('any user-entered content makes the row non-blank — even without an account (OM-09)', () => {
  // Sara's vanished line: item + qty/price + derived amount, account empty.
  assert.equal(
    isBlankDrawerLine({ ...blankGridRow(), itemId: 'OPS-W01', quantity: '2', unitPrice: '100', amount: '200.0000' }),
    false,
  )
  // Every content column alone suffices: each of these used to vanish from
  // the footer and the save payload when the account was empty.
  for (const content of [
    { accountId: 'a' },
    { itemId: 'OPS-W01' },
    { description: 'field work' },
    { quantity: '2' },
    { unitPrice: '100' },
    { amount: '200.0000' },
    { taxProfileId: 'code:vat' },
    { departmentId: 'd1' },
    { cf_note: 'keep me' },
  ]) {
    assert.equal(isBlankDrawerLine({ ...blankGridRow(), ...content }), false, JSON.stringify(content))
  }
  // Signed and zero amounts with an account still ride, as before.
  assert.equal(isBlankDrawerLine(row('a', '100')), false)
  assert.equal(isBlankDrawerLine(row('a', '-20')), false)
  assert.equal(isBlankDrawerLine(row('a', '0')), false)
})

test('the missing-account probe names the first contentful account-less grid row', () => {
  assert.equal(findMissingAccountLine([blankGridRow()]), null)
  assert.equal(findMissingAccountLine([row('a', '100'), blankGridRow()]), null)
  // OM-09 shape: booked line 1, Sara's account-less line 2, trailing blank.
  const missing = findMissingAccountLine([
    row('a', '1480'),
    { ...blankGridRow(), itemId: 'OPS-W01', quantity: '2', unitPrice: '100', amount: '200.0000' },
    blankGridRow(),
  ])
  assert.deepEqual(missing, { index: 1, lineNumber: 2 })
  assert.equal(hasDrawerLineAccount({ accountId: '' }), false)
  assert.equal(hasDrawerLineAccount({ accountId: 'a' }), true)
})

test('a contentful account-less row survives to the save payload, where the server names it (OM-09 guard)', () => {
  // The save payload keeps every non-blank row. If anyone reintroduces an
  // account-gated drop here, this row vanishes before any line-named
  // refusal can reach it — exactly the production defect.
  const rows = [
    row('a', '1480'),
    { ...blankGridRow(), itemId: 'OPS-W01', quantity: '2', unitPrice: '100', amount: '200.0000' },
    blankGridRow(),
  ]
  const payload = rows.filter((r) => !isBlankDrawerLine(r))
  assert.equal(payload.length, 2)
  assert.equal((payload[1] as { amount: string }).amount, '200.0000')
  // …and the client names its grid line before any write fires.
  assert.deepEqual(findMissingAccountLine(rows)?.lineNumber, 2)
})

test('distribution columns map tolerantly: a line without them is simply ungrouped', () => {
  assert.deepEqual(distributionFieldsOf({}), {
    distributionGroupId: '',
    distributionRuleId: '',
    distributionRuleName: '',
    distributionVersionId: '',
    distributionLocked: false,
    distributionKey: '',
  })
  assert.deepEqual(
    distributionFieldsOf({
      distribution_group_id: 'g1',
      distribution_rule_id: 'r1',
      distribution_rule_name: 'Overhead',
      distribution_version_id: 'v1',
      distribution_locked: true,
    }),
    {
      distributionGroupId: 'g1',
      distributionRuleId: 'r1',
      distributionRuleName: 'Overhead',
      distributionVersionId: 'v1',
      distributionLocked: true,
      distributionKey: '',
    },
  )
  // Only an explicit true locks: absent (or any other shape) stays unlocked
  // so a partial read can never freeze a group the operator did not lock.
  assert.equal(distributionFieldsOf({ distribution_locked: 1 }).distributionLocked, false)
  assert.deepEqual(clearedDistributionFields(), distributionFieldsOf({}))
})

test('the reviewed footer total is the booked total: save keeps every row the footer prices', () => {
  const rows = [
    row('a', '100'),
    row('a', '-20'),
    row('a', '0'),
    row('a', ''),
    // OM-09: a contentful row missing its account is priced in the footer
    // instead of silently excluded — the save refuses it by line name, so
    // the operator sees the $50 and fixes the line rather than losing it.
    row('', '50'),
  ]
  const reviewed = computeDocumentDrawerTotals(rows, new Map(), false)
  assert.equal(reviewed.total, '130.0000')
  // Totals over exactly the rows the save payload keeps must match the
  // reviewed footer — otherwise the drawer books something other than what
  // the operator reviewed.
  const booked = computeDocumentDrawerTotals(
    rows.filter((r) => !isBlankDrawerLine(r)),
    new Map(),
    false,
  )
  assert.equal(booked.total, reviewed.total)
})

// F-t02-004: Quantity × Unit price drives the line Amount. Exact decimal
// math, ledger scale, no Number hop.
test('line amount derives exactly from quantity times unit price', () => {
  assert.equal(lineAmountFromQtyPrice('1', '1000'), '1000.0000')
  assert.equal(lineAmountFromQtyPrice('3', '1000'), '3000.0000')
  assert.equal(lineAmountFromQtyPrice('1.5', '19.99'), '29.9850')
  assert.equal(lineAmountFromQtyPrice('-2', '100'), '-200.0000')
  assert.equal(lineAmountFromQtyPrice('3', '10.333'), '30.9990')
})

test('line amount derivation refuses to guess: blank or junk keeps the manual amount', () => {
  assert.equal(lineAmountFromQtyPrice('', '1000'), null)
  assert.equal(lineAmountFromQtyPrice('3', ''), null)
  assert.equal(lineAmountFromQtyPrice('', ''), null)
  assert.equal(lineAmountFromQtyPrice('abc', '1000'), null)
  assert.equal(lineAmountFromQtyPrice('3', '1.23456789012'), null)
})

const qtyRow = (quantity: string, unitPrice: string, amount: string) => ({ quantity, unitPrice, amount })

test('a fresh qty+price prices the line: the F-t02-004 invoice flow', () => {
  const prev = [qtyRow('', '', '')]
  const next = [qtyRow('1', '1000', '')]
  assert.deepEqual(applyQtyPriceToRows(prev, next), [qtyRow('1', '1000', '1000.0000')])
})

test('editing quantity on a derived line re-derives the amount', () => {
  const prev = [qtyRow('1', '1000', '1000.0000')]
  const next = [qtyRow('3', '1000', '1000.0000')]
  assert.deepEqual(applyQtyPriceToRows(prev, next), [qtyRow('3', '1000', '3000.0000')])
})

test('a reorder compares each line against itself by client identity, not by position', () => {
  // Alt+Up moves the discounted line B above line A. Position matching would
  // compare B against A's old qty/price, mistake B's hand-typed 10.0000 for
  // a stale derivation of A's line, and overwrite it with 2 x 10 = 20.0000.
  const prev = [
    { ...qtyRow('1', '10', '10.0000'), clientKey: 'a' },
    { ...qtyRow('2', '10', '10.0000'), clientKey: 'b' },
  ]
  const next = [
    { ...qtyRow('2', '10', '10.0000'), clientKey: 'b' },
    { ...qtyRow('1', '10', '10.0000'), clientKey: 'a' },
  ]
  assert.deepEqual(applyQtyPriceToRows(prev, next), next)
})

test('a hand-typed amount that diverges from qty x price is never overwritten', () => {
  // Discount / reapportioned / tax-adjusted lines keep their manual figure
  // even when the operator edits quantity afterwards.
  const prev = [qtyRow('1', '1000', '850.0000')]
  const next = [qtyRow('3', '1000', '850.0000')]
  assert.deepEqual(applyQtyPriceToRows(prev, next), [qtyRow('3', '1000', '850.0000')])
  // …and an unrelated edit leaves derived and manual rows alike untouched.
  const same = [qtyRow('3', '1000', '3000.0000'), qtyRow('1', '100', '90.0000')]
  assert.deepEqual(applyQtyPriceToRows(same, same.map((r) => ({ ...r }))), same)
})

// F-t04-006 follow-up: the drawer Post read res.json() unguarded — a
// non-JSON error body threw out as an unhandled rejection (zero toast, and
// the Post button wedged busy). The read must never throw; the caller falls
// back to the localized message when no typed reason arrives.
test('drawer action result read never throws on a non-JSON error body', async () => {
  const html = new Response('<html>proxy error</html>', {
    status: 422,
    headers: { 'content-type': 'text/html' },
  })
  const result = await readDocumentActionResult(html)
  assert.deepEqual(result, { ok: false, message: null, pendingApproval: false })
})

test('drawer action result read carries the typed 422 refusal', async () => {
  const refused = new Response(
    JSON.stringify({ error: 'AP is closed for this period and accounting book' }),
    { status: 422, headers: { 'content-type': 'application/json' } },
  )
  const result = await readDocumentActionResult(refused)
  assert.deepEqual(result, {
    ok: false,
    message: 'AP is closed for this period and accounting book',
    pendingApproval: false,
  })
})

test('drawer action result read passes approvals through', async () => {
  const pending = new Response(JSON.stringify({ ok: true, pendingApproval: true }), { status: 202 })
  const result = await readDocumentActionResult(pending)
  assert.deepEqual(result, { ok: true, message: null, pendingApproval: true })
})

// F-t06-002: the form refuses a currency-mismatched account up front instead
// of saving a document the ledger is certain to reject at post.
test('currency proof names the first restricted account outside the doc currency', () => {
  const restrictions = new Map([
    ['bank-cad', 'CAD'],
    ['bank-usd', 'USD'],
    ['revenue', null],
  ])
  const refs = [
    { accountId: 'revenue', label: '4000 Service Revenue' },
    { accountId: 'bank-cad', label: '1000 Operating Cash' },
  ]
  assert.deepEqual(findCurrencyMismatchedAccount('USD', refs, restrictions), {
    accountId: 'bank-cad',
    label: '1000 Operating Cash',
    allowed: 'CAD',
  })
})

test('currency proof passes matching, unrestricted, unknown, and blank accounts', () => {
  const restrictions = new Map([
    ['bank-usd', 'USD'],
    ['revenue', null],
  ])
  const refs = [
    { accountId: 'revenue', label: '4000 Service Revenue' },
    { accountId: 'bank-usd', label: '1010 Payroll Checking' },
    { accountId: 'vanished', label: '0000 Gone' },
    { accountId: '', label: '—' },
  ]
  // Unknown accounts stay the server's call (fail open); blanks never judge.
  assert.equal(findCurrencyMismatchedAccount('USD', refs, restrictions), null)
  assert.equal(findCurrencyMismatchedAccount('', refs, restrictions), null)
})
