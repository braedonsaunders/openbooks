import assert from 'node:assert/strict'
import test from 'node:test'
import { bootViewTests, mountView, captureCsvDownload } from '../_view-test-harness'
import { spendVelocityFixture, alertFixture } from './spend-velocity-view-fixtures'

// Spend account CSVs must carry exact ledger amounts: current, prior,
// two-back and projected pass through instead of being rounded.

// Deferred past boot: the view pulls charts that must resolve after jsdom.
await bootViewTests('http://localhost:4800/analytics/spend-velocity')
const { SpendVelocityView } = await import('./SpendVelocityView')

test('spend velocity CSV exports retain account amount decimals', async () => {
  const { host, click, cleanup } = await mountView(<SpendVelocityView data={spendVelocityFixture()} />, 'Accounts')
  try {
    const { text, downloadedFile, clickedHref } = await captureCsvDownload(async () => {
      const exportButton = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('CSV'))
      assert.ok(exportButton, 'the accounts table must offer a CSV export')
      await click(exportButton)
    }, 'blob:spend-export-test')
    assert.ok(text.includes('5432.109'), `current amount must stay decimal, got:\n${text}`)
    assert.ok(text.includes('5000.25'), `prior amount must stay decimal, got:\n${text}`)
    assert.ok(text.includes('6100.445'), `projected amount must stay decimal, got:\n${text}`)
    assert.ok(!text.includes('5432,'), `current amount must not be rounded, got:\n${text}`)
    assert.ok(!text.includes('6100,'), `projected amount must not be rounded, got:\n${text}`)
    assert.equal(downloadedFile, 'spend-accounts-2026-08-28.csv')
    assert.equal(clickedHref, 'blob:spend-export-test')
  } finally {
    await cleanup()
  }
})

test('unconfigured detectors name remedies with single percents and worded trends', async () => {
  const { host, cleanup } = await mountView(<SpendVelocityView data={alertFixture()} />, 'Detectors')
  try {
    const text = host.textContent ?? ''
    assert.ok(text.includes('Set the minimum base in Spend Velocity → Configuration'), `the cliff tile must name its remedy, got:\n${text}`)
    assert.ok(text.includes('Set the fragmentation size cap in Spend Velocity → Configuration'), `the fragmentation tile must name its remedy, got:\n${text}`)
    assert.ok(!text.includes('%%'), `no detail may double the percent sign, got:\n${text}`)
    assert.ok(text.includes('Accelerating'), `the concentration trend must read in words, got:\n${text}`)
  } finally {
    await cleanup()
  }
})

test('the configuration tab renders the fixed scoring rubric read-only', async () => {
  const { host, cleanup } = await mountView(<SpendVelocityView data={spendVelocityFixture()} />, 'Configuration')
  try {
    const text = host.textContent ?? ''
    assert.ok(text.includes('Scoring model'), `the rubric panel must render, got:\n${text}`)
    assert.ok(text.includes('Deduction cap'), `the rubric rows must name their weights, got:\n${text}`)
    assert.ok(text.includes('(<10%)'), `the frog note must show the configured step cap, got:\n${text}`)
  } finally {
    await cleanup()
  }
})

test('the headlines caveat the detectors the score omits', async () => {
  // The fixture leaves fragmentation unconfigured: the gauge and the
  // alerts headline must carry its remedy, not a clean bill of health.
  const { host, cleanup } = await mountView(<SpendVelocityView data={spendVelocityFixture()} />)
  try {
    const text = host.textContent ?? ''
    assert.ok(text.includes('Set the fragmentation size cap in Spend Velocity → Configuration'), `the headlines must caveat the omitted detector, got:\n${text}`)
  } finally {
    await cleanup()
  }
})
