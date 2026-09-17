import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t03-008: the party drawer's "Open balance" sums document open balances
// across ALL documents (any status, any posting date) while the /ap
// "Payables by vendor" panel groups the shared as-of open-items reader. The
// ruling keeps both figures and labels each: the drawer card states its
// all-time basis on screen, in every locale, so a reader comparing it with
// the dashboard no longer assumes one of them is broken.
const LOCALES = ['en', 'fr', 'es', 'de', 'ja', 'pt-BR', 'zh'] as const

function summaryLabel(locale: string): unknown {
  const catalog = JSON.parse(
    readFileSync(new URL(`../../../messages/${locale}/parties.json`, import.meta.url), 'utf8'),
  )
  return catalog?.drawer?.summary?.openBalance
}

test('the drawer open-balance card states its all-time basis in every locale', () => {
  assert.equal(
    summaryLabel('en'),
    'Open balance (all time)',
    'the English source pins the all-time basis the ruling requires',
  )
  for (const locale of LOCALES) {
    const label = summaryLabel(locale)
    assert.equal(typeof label, 'string', `${locale} ships the drawer open-balance label`)
    assert.match(
      String(label),
      /\(.+\)|（.+）/,
      `${locale} qualifies the open-balance card with its basis on screen`,
    )
    if (locale !== 'en') {
      assert.notEqual(
        label,
        summaryLabel('en'),
        `${locale} translates the qualified label instead of pasting English`,
      )
    }
  }
})
