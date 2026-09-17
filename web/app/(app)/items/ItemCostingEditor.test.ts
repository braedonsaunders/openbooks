import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { tsImport } from 'tsx/esm/api'

// F-t09-002: the costing form must refuse — inline, before any submit — an
// account combination the PUT route is known to reject with 422 (any offset
// account equal to the inventory asset account). A transient toast after a
// failed save is not a substitute for inline validation.
const source = readFileSync(new URL('./ItemCostingEditor.tsx', import.meta.url), 'utf8')
const { costingOffsetConflicts } = await tsImport('./ItemCostingEditor.tsx', {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
}) as {
  costingOffsetConflicts: (input: {
    assetAccountId: string
    cogsAccountId: string
    adjustmentAccountId: string
    varianceAccountId: string
    receivedNotBilledAccountId: string
  }) => string[]
}

const ASSET = '11111111-1111-4111-8111-111111111111'
const COGS = '22222222-2222-4222-8222-222222222222'
const ADJUST = '33333333-3333-4333-8333-333333333333'
const VARIANCE = '44444444-4444-4444-8444-444444444444'
const GRNI = '55555555-5555-4555-8555-555555555555'

function valid() {
  return {
    assetAccountId: ASSET,
    cogsAccountId: COGS,
    adjustmentAccountId: ADJUST,
    varianceAccountId: VARIANCE,
    receivedNotBilledAccountId: GRNI,
  }
}

test('a valid account combination reports no conflicts', () => {
  assert.deepEqual(costingOffsetConflicts(valid()), [])
})

test('an empty optional offset is not a conflict', () => {
  assert.deepEqual(
    costingOffsetConflicts({ ...valid(), adjustmentAccountId: '', varianceAccountId: '', receivedNotBilledAccountId: '' }),
    [],
  )
})

test('an adjustment account copying the asset account is a conflict', () => {
  assert.deepEqual(
    costingOffsetConflicts({ ...valid(), adjustmentAccountId: ASSET }),
    ['adjustmentAccountId'],
  )
})

test('a variance account copying the COGS-selected asset is a conflict', () => {
  assert.deepEqual(
    costingOffsetConflicts({ ...valid(), varianceAccountId: ASSET }),
    ['varianceAccountId'],
  )
})

test('a COGS account equal to the asset account is a conflict', () => {
  assert.deepEqual(
    costingOffsetConflicts({ ...valid(), cogsAccountId: ASSET }),
    ['cogsAccountId'],
  )
})

test('a received-not-billed account equal to the asset account is a conflict', () => {
  assert.deepEqual(
    costingOffsetConflicts({ ...valid(), receivedNotBilledAccountId: ASSET }),
    ['receivedNotBilledAccountId'],
  )
})

test('the comparison matches the server rule regardless of id casing', () => {
  assert.deepEqual(
    costingOffsetConflicts({ ...valid(), adjustmentAccountId: ASSET.toUpperCase() }),
    ['adjustmentAccountId'],
  )
})

test('the editor blocks the save and renders the conflict inline instead of submitting', () => {
  assert.match(source, /costingOffsetConflicts\(/)
  // The save path must consult the conflicts before issuing the PUT.
  assert.match(source, /if \(conflicts\.length > 0\)[\s\S]*?return/)
  // Conflicting pickers render an inline error, not just a toast.
  assert.match(source, /role="alert"/)
  assert.match(source, /separationConflict/)
})
