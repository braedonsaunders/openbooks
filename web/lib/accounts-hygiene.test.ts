/**
 * An account typed asset_bank shows as cash everywhere, so a mistyped
 * clearing, provision, or facility account silently inflates cash. The typing
 * check is a WARNING (never a refusal): it fires when the asset_bank type is
 * uncorroborated — no bank-like name, not statement-reconcilable, and no
 * statements ever imported for the account.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { assetBankHygieneWarning } from './accounts-hygiene'

test('a bank-named account needs no corroboration', () => {
  assert.equal(assetBankHygieneWarning({ type: 'asset_bank', name: 'RBC Bank' }), null)
  assert.equal(assetBankHygieneWarning({ type: 'asset_bank', name: 'SAVINGS' }), null)
  assert.equal(assetBankHygieneWarning({ type: 'asset_bank', name: 'Staff Chequing Account' }), null)
})

test('canonical cash names are cash by definition, not mistypes', () => {
  assert.equal(assetBankHygieneWarning({ type: 'asset_bank', name: 'Cash' }), null)
  assert.equal(assetBankHygieneWarning({ type: 'asset_bank', name: 'Petty Cash' }), null)
  assert.equal(assetBankHygieneWarning({ type: 'asset_bank', name: 'Undeposited Funds' }), null)
})

test('reconcilable or statement-backed accounts need no name match', () => {
  assert.equal(
    assetBankHygieneWarning({ type: 'asset_bank', name: 'Operating', reconcilable: true }),
    null,
  )
  assert.equal(
    assetBankHygieneWarning({ type: 'asset_bank', name: 'Operating', hasStatements: true }),
    null,
  )
})

test('an uncorroborated asset_bank warns naming the account', () => {
  for (const name of ['Operating', 'Provision for Future Income Tax', 'Payroll Clearing', 'RBC Line of Credit']) {
    const warning = assetBankHygieneWarning({ type: 'asset_bank', name })
    assert.ok(warning, `${name} should warn`)
    assert.match(warning!, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('other types, summaries, and empty names never warn', () => {
  assert.equal(assetBankHygieneWarning({ type: 'expense', name: 'Provision for Claims' }), null)
  assert.equal(assetBankHygieneWarning({ type: 'asset_receivable', name: 'RBC Bank' }), null)
  // Summary accounts never post; the cash queries exclude them.
  assert.equal(assetBankHygieneWarning({ type: 'asset_bank', name: 'Misc', isSummary: true }), null)
})
