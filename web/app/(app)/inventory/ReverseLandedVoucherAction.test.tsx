import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const actionSource = readFileSync(join(webRoot, 'app/(app)/inventory/ReverseLandedVoucherAction.tsx'), 'utf8')
const pageSource = readFileSync(join(webRoot, 'app/(app)/inventory/page.tsx'), 'utf8')
const messages = JSON.parse(readFileSync(join(webRoot, 'messages/en/inventory.json'), 'utf8')) as Record<string, unknown>

// A posted landed-cost voucher had no production reversal path: the engine
// function existed but no caller. The dialog below is that path, so a refusal
// from it must reach the operator exactly like movement refusals do.
test('landed-cost reversal refusals surface the server reason instead of a parse error', () => {
  // Status first, always: the body is read only to extract the refusal.
  assert.match(actionSource, /if \(!res\.ok\)[\s\S]*?readApiErrorMessage\(res/)
  assert.match(actionSource, /action: 'reverseLandedVoucher'/)
  assert.match(actionSource, /idempotencyKey: key/)
  // A refused reversal pins its reason on the dialog until the next submit.
  assert.match(actionSource, /<p role="alert"[\s\S]*?\{submitError/)
  assert.match(actionSource, /setSubmitError\(null\)/)
})

test('the reversal dialog only offers posted vouchers and carries reason plus date', () => {
  assert.match(actionSource, /filter\(\(v\) => v\.status === 'posted'\)/)
  assert.match(actionSource, /memo: reason\.trim\(\)/)
  assert.match(actionSource, /type="date"/)
  assert.match(actionSource, /reason\.trim\(\)\.length < 5/)
})

test('every locale key the reversal dialog asks for exists in English', () => {
  const advanced = messages.advanced as Record<string, Record<string, unknown>>
  assert.ok(advanced.landed, 'advanced.landed exists in English')
  const reverse = advanced.landed!.reverse as Record<string, string>
  for (const key of [
    'openButton', 'title', 'description', 'voucher', 'selectVoucher', 'nonePosted',
    'voucherRequired', 'reversalDate', 'reason', 'reasonPlaceholder', 'reasonLength',
    'reverse', 'reversed', 'alreadyReversed', 'reverseFailed', 'loadFailed',
  ]) {
    assert.equal(typeof reverse[key], 'string', `advanced.landed.reverse.${key}`)
  }
})

test('the reversal action mounts only for the reversal authority', () => {
  assert.match(pageSource, /canReverse \? <ReverseLandedVoucherAction \/> : null/)
  assert.match(pageSource, /const canReverse = can\(authz, 'items\.reverse'\)/)
})
