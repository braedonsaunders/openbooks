import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// OrderDrawer on the shared action path. Three deltas over the old code get
// their own guards here: a refused delete toasted without pinning (and a
// non-JSON body threw past the busy reset), a refused approve/void toasted
// without pinning, and a refused save toasted without pinning. The credit
// override branch moved from a message read to the stable code — same wire
// signal. (Convert pins were already covered by
// order-convert-refusal.test.ts, migrated to the shared path there.)
const source = readFileSync(new URL('./OrderDrawer.tsx', import.meta.url), 'utf8')

function block(name: string, length: number) {
  const start = source.indexOf(name)
  assert.notEqual(start, -1, `expected ${name} to exist`)
  return source.slice(start, start + length)
}

test('a refused delete pins instead of only toasting', () => {
  const removeBlock = block('async function remove()', 1400)
  assert.match(removeBlock, /execute\(/, 'remove must run through the shared action path')
  assert.match(removeBlock, /fetchAction/, 'remove must read through the shared fetch path')
})

test('a refused approve/void pins instead of only toasting', () => {
  const statusBlock = block('async function setStatus(', 3600)
  assert.match(statusBlock, /execute[<(]/, 'setStatus must run through the shared action path')
  assert.match(
    statusBlock,
    /CUSTOMER_CREDIT_LIMIT_EXCEEDED/,
    'the credit override branch must key on the stable code',
  )
})

test('no hand-rolled busy reset remains on the action paths', () => {
  assert.doesNotMatch(
    source,
    /setBusy\(/,
    'busy always releases through the shared path, never a manual reset',
  )
})
