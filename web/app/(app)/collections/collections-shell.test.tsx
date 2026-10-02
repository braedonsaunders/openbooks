import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import messages from '../../../messages/en/index.ts'
import { MoneyProvider } from '../../../components/money-provider.tsx'


const { stubModules } = await import('../../../testing/stub-modules')
stubModules({ navigation: true })
const { CollectionsShell } = await import('./sections.tsx')

Object.assign(globalThis, { React })
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const base = {
  title: 'Collections',
  description: 'Collect receivables and manage billing.',
  worklistLabel: 'Open the collections worklist',
  subscriptionsEnabled: false,
  advancedSubscriptionsEnabled: false,
  customers: [],
  incomeAccounts: [],
}

function render(worklistHref: string | null): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MoneyProvider currency="USD">
        <CollectionsShell {...base} worklistHref={worklistHref} />
      </MoneyProvider>
    </NextIntlClientProvider>,
  )
}

test('the collections shell opens its native worklist for ar.read readers', () => {
  const html = render('/ar')
  assert.match(html, /Loading/)
  assert.doesNotMatch(html, /href="\/ar"/)
  assert.doesNotMatch(html, /Reports|Strategic accounts|Policy controls/)
})

test('configuration readers get policies without a collection worklist or its actions', () => {
  const html = render(null)
  assert.match(html, /Policy name/)
  assert.doesNotMatch(html, /Build collection run|Open the collections worklist/)
})
