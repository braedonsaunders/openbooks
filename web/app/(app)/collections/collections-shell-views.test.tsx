import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import messages from '../../../messages/en/index.ts'
import { MoneyProvider } from '../../../components/money-provider.tsx'

const { stubModules } = await import('../../../testing/stub-modules')
stubModules({
  navigation: true,
  extra: {
    'next/link':
      `export default function Link(p){return globalThis.React.createElement('a',{href:p.href,'aria-current':p['aria-current'],className:p.className},p.children)}`,
  },
})
const { CollectionsShell } = await import('./sections.tsx')

Object.assign(globalThis, { React })
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const tabs = [
  { href: '/collections?view=recovery', label: 'Recovery', active: true, count: 2 },
  { href: '/collections?view=attempts', label: 'Attempts', active: false },
  { href: '/collections?view=policies', label: 'Policies', active: false },
]

function render(initialView: string): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MoneyProvider currency="USD">
        <CollectionsShell
          title="Collections"
          description="Collect receivables and manage billing."
          tabs={initialView === 'policies' ? tabs.map((tab) => ({ ...tab, active: tab.href.includes('policies') })) : tabs}
          initialView={initialView}
          autopayOn
          worklistHref={null}
          worklistLabel="Open the collections worklist"
          subscriptionsEnabled={false}
          advancedSubscriptionsEnabled={false}
          customers={[]}
          incomeAccounts={[]}
        />
      </MoneyProvider>
    </NextIntlClientProvider>,
  )
}

/**
 * Recovery and attempts own their page views: the shell renders its header
 * and tab strip there, never an operational panel beside the server block.
 */
test('the shell renders only its tab strip on the recovery view', () => {
  const html = render('recovery')
  assert.match(html, /view=recovery/)
  assert.match(html, /aria-current="page"/)
  assert.doesNotMatch(html, /Policy name/)
  assert.doesNotMatch(html, /Loading/)
})

test('the shell renders only its tab strip on the attempts view', () => {
  const html = render('attempts')
  assert.match(html, /view=attempts/)
  assert.doesNotMatch(html, /Policy name/)
  assert.doesNotMatch(html, /Loading/)
})

test('the shell still renders its policies panel with tabs present', () => {
  const html = render('policies')
  assert.match(html, /Policy name/)
})
