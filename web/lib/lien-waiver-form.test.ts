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
