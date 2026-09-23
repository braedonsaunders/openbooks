import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import messages from '../../../messages/en/index.ts'
import { MoneyProvider } from '../../../components/money-provider.tsx'
import { CollectionsShell } from './sections.tsx'

// UX-01: the /collections page is recurring/subscription/dunning
// configuration, while the overdue chase list lives on /ar. The shell must
// link to that worklist for readers who may open it — and offer nothing to
// readers who may not. Static markup is enough: the link is server-rendered,
// not client state.

Object.assign(globalThis, { React })
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const base = {
  title: 'Collections',
  description: 'Configuration, not the chase list.',
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

test('the collections shell links to the /ar worklist', () => {
  const html = render('/ar')
  assert.match(html, /href="\/ar"/)
  assert.match(html, /Open the collections worklist/)
})

test('the collections shell offers no worklist link without ar.read', () => {
  const html = render(null)
  assert.doesNotMatch(html, /Open the collections worklist/)
})
