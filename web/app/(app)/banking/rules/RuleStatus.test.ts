import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t05-004: the rules Status filter showed "Active" / "inactive" — the
// BANK_RULE record type pairs common.labels.active with
// banking.rules.inactive, whose English value was lowercase.
const registrySource = readFileSync(
  new URL('../../../../../packages/customization/src/registry.ts', import.meta.url),
  'utf8',
)
const enBanking = JSON.parse(
  readFileSync(new URL('../../../../messages/en/banking.json', import.meta.url), 'utf8'),
) as { rules: Record<string, string> }

test('bank rule status options use the shared Active label', () => {
  assert.match(
    registrySource,
    /\{ value: "true", labelKey: "common\.labels\.active" \}/,
    'the active option must stay on the shared label',
  )
  assert.match(
    registrySource,
    /\{ value: "false", labelKey: "banking\.rules\.inactive" \}/,
    'the inactive option resolves through banking.rules.inactive',
  )
})

test('inactive renders capitalized like its Active sibling', () => {
  assert.equal(enBanking.rules['inactive'], 'Inactive')
})
