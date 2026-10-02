import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import messages from '../../../messages/en/index.ts'
const { stubModules } = await import('../../../testing/stub-modules')
stubModules({ navigation: true })

// The test loader compiles workspace UI with the classic JSX runtime.
Object.assign(globalThis, { React })
const { renderToString } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { MoneyProvider } = await import('@/components/money-provider')
const { CollectionsClient } = await import('./CollectionsClient')

// the recurring-schedules headers jammed into one string at 390px
// ("TemplateCustomerCadenceNext runRunsAuto-postStatus") — the header cells
// carry no gutters, so the eight columns collapse with zero separation and
// the overflow-x-auto wrapper has nothing to scroll. Every header cell must
// keep a horizontal gutter (and stay on one line) so the row scrolls instead
// of jamming.
function panelHtml() {
  return renderToString(
    <MoneyProvider currency="CAD">
      <NextIntlClientProvider locale="en" messages={messages}>
        <CollectionsClient initialView="recurring" />
      </NextIntlClientProvider>
    </MoneyProvider>,
  )
}

test('recurring table headers keep gutters instead of jamming', () => {
  const html = panelHtml()
  const thead = html.match(/<thead[\s\S]*?<\/thead>/)
  assert.ok(thead, 'recurring table head must render')
  const cells = [...thead[0]!.matchAll(/<th(\s[^>]*)?>/g)]
  assert.ok(cells.length >= 7, 'all schedule header cells must render')
  for (const cell of cells) {
    assert.match(cell[1] ?? '', /px-\d/, 'header cells must keep a horizontal gutter')
    assert.match(cell[1] ?? '', /whitespace-nowrap/, 'header labels must stay on one line')
  }
})
