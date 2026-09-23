import assert from 'node:assert/strict'
import test from 'node:test'
import { formatWaiverAmount, renderLienWaiverBody } from './lien-waiver-form.ts'

test('legal release amounts preserve cents beyond Number safe precision', () => {
  const amount = '900719925474099.9400'

  assert.equal(formatWaiverAmount(amount, 'USD'), 'USD 900,719,925,474,099.94')

  const html = renderLienWaiverBody({
    waiverNumber: 'LW-100',
    waiverType: 'conditional_final',
    direction: 'received',
    claimantName: 'Example Subcontractor',
    payerName: 'Example Builder',
    projectName: 'Example Project',
    throughDate: '2026-08-28',
    amount,
    currency: 'USD',
    notarized: false,
  })

  assert.match(html, /in the sum of USD 900,719,925,474,099\.94/)
  assert.match(html, /<p class="amount">USD 900,719,925,474,099\.94<\/p>/)
  assert.doesNotMatch(html, /USD 900,719,925,474,100\.00/)
})

test('ordinary waiver amounts retain standard two-decimal formatting', () => {
  assert.equal(formatWaiverAmount('1234.5', 'CAD'), 'CAD 1,234.50')
})

const legacyData = {
  waiverNumber: 'LW-7',
  waiverType: 'conditional_progress' as const,
  direction: 'received' as const,
  claimantName: 'Old Vendor Co',
  payerName: 'Example Builder',
  projectName: 'Old Project',
  throughDate: '2026-03-31',
  amount: '1000.00',
  currency: 'CAD',
  notarized: false,
}

test('executed prints carry no legacy banner by default', () => {
  const html = renderLienWaiverBody({ ...legacyData, signedByName: 'Sam Signer', signedAt: '2026-04-01' })
  assert.doesNotMatch(html, /<div class="legacy-notice">/)
  assert.doesNotMatch(html, /Legacy waiver/)
})

test('a legacy executed print banners itself as current records, never the release', () => {
  const html = renderLienWaiverBody({ ...legacyData, signedByName: 'Old Signer', signedAt: '2026-04-01' }, 'Example Builder', {
    legacyUnverifiedAsOf: '2026-09-23',
  })
  assert.match(html, /<div class="legacy-notice">/)
  assert.match(html, /Legacy waiver — executed evidence not captured at signing/)
  assert.match(html, /reflect current records as of 2026-09-23/)
  assert.match(html, /void and reissue/)
  // The release body still renders beneath the banner.
  assert.match(html, /Old Vendor Co/)
})

test('the legacy banner escapes its reading date', () => {
  const html = renderLienWaiverBody(legacyData, null, { legacyUnverifiedAsOf: '<2026-09-23>' })
  assert.doesNotMatch(html, /<2026-09-23>/)
  assert.match(html, /&lt;2026-09-23&gt;/)
})
