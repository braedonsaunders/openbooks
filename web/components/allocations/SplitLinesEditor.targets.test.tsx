import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import test from 'node:test'
import messages from '../../messages/en'
import { SplitLinesEditor } from './SplitLinesEditor.tsx'
import {
  allocationPortionFromInput,
  allocationTargetBasisFromLine,
  type AllocationLine,
} from './split-lines-model.ts'

Object.assign(globalThis, { React })

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

test('allocation target editor renders its allowed portions and same-account label', () => {
  const markup = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <SplitLinesEditor
        lines={[{ accountId: '', portion: { kind: 'remainder' }, label: '' }]}
        onChange={() => {}}
        accountOptions={[{ value: 'acct-1', label: 'Operating cash' }]}
        portionKinds={['remainder', 'percent', 'weight']}
        allowEmptyAccount
        showLabel
        labels={{ sameAccount: 'Same account', labelPlaceholder: 'Target label', remainder: 'Remainder', percent: 'Percent', weight: 'Weight' }}
      />
    </NextIntlClientProvider>,
  )

  assert.match(markup, /Same account/, 'an unset target account is identified as the source account')
  assert.match(markup, /Remainder/, 'the configured remainder portion is available')
  assert.match(markup, /Target label/, 'target labels are shown to editors')
  assert.doesNotMatch(markup, />Fixed</, 'allocation targets do not offer fixed-amount portions')
})
