import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  allocationPortionFromInput,
  allocationTargetBasisFromLine,
  type AllocationLine,
} from './SplitLinesEditor.tsx'

const editorSource = readFileSync(fileURLToPath(new URL('./SplitLinesEditor.tsx', import.meta.url)), 'utf8')

test('weight input preserves exact decimal text', () => {
  assert.deepEqual(
    allocationPortionFromInput({ kind: 'weight', value: '0' }, '33.3333'),
    { kind: 'weight', value: '33.3333' },
  )
})

test('target basis serializes every portion kind without floats', () => {
  const line = (portion: AllocationLine['portion']): AllocationLine => ({
    accountId: 'acct-1',
    portion,
    label: 'ops',
  })
  assert.deepEqual(allocationTargetBasisFromLine(line({ kind: 'remainder' })), {
    targetAccountId: 'acct-1',
    fixedPercent: null,
    weight: null,
    isRemainder: true,
    label: 'ops',
  })
  assert.deepEqual(allocationTargetBasisFromLine(line({ kind: 'percent', value: 12.5 })), {
    targetAccountId: 'acct-1',
    fixedPercent: '12.5',
    weight: null,
    isRemainder: false,
    label: 'ops',
  })
  assert.deepEqual(allocationTargetBasisFromLine(line({ kind: 'weight', value: '2.5000' })), {
    targetAccountId: 'acct-1',
    fixedPercent: null,
    weight: '2.5000',
    isRemainder: false,
    label: 'ops',
  })
  // Fixed-amount splits are not an allocation basis — they map to neither, so
  // publish validation fails closed instead of misreading the line.
  assert.deepEqual(allocationTargetBasisFromLine(line({ kind: 'fixed', value: '10.00' })), {
    targetAccountId: 'acct-1',
    fixedPercent: null,
    weight: null,
    isRemainder: false,
    label: 'ops',
  })
})

test('empty account means same account; missing label stays null', () => {
  assert.deepEqual(
    allocationTargetBasisFromLine({ accountId: '', portion: { kind: 'remainder' } }),
    { targetAccountId: null, fixedPercent: null, weight: null, isRemainder: true, label: null },
  )
})

test('editor exposes the allocation affordances the rule drawer needs', () => {
  // Weight is a first-class portion kind driven by the consumer's list.
  assert.match(editorSource, /weight: 'weight'/)
  assert.match(editorSource, /portionKinds\.map\(\(kind\)/)
  // Optional target account renders clearable with a "same account" empty state.
  assert.match(editorSource, /clearable=\{allowEmptyAccount\}/)
  assert.match(editorSource, /emptyLabel=\{allowEmptyAccount \? labels\.sameAccount/)
  // Per-target label input is gated behind showLabel.
  assert.match(editorSource, /\{showLabel \? \(/)
  assert.match(editorSource, /placeholder=\{labels\.labelPlaceholder\}/)
  // Legacy consumers keep the exact three historical kinds by default.
  assert.match(editorSource, /\['remainder', 'percent', 'fixed'\]/)
})
