import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, _context, next) {
    if (specifier === 'next/link') {
      return { shortCircuit: true, url: 'data:text/javascript,export default function Link(p){return globalThis.React.createElement("a",{href:p.href},p.children)}' }
    }
    return next(specifier)
  },
})

const React = await import('react')
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { renderToStaticMarkup } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
const { MoneyProvider } = await import('../../../components/money-provider')
const { CardTile } = await import('./CardTile')
const { WidgetCard } = await import('../dashboard/_widget-views')

const card = {
  id: 'card-1',
  name: 'Revenue by month',
  query: { source: 'ledger_lines', measures: [{ agg: 'count' as const }], dimensions: [], filters: [] },
  vizType: 'bar' as const,
  vizSettings: {},
}

function outerCardClass(html: string): string {
  const match = html.match(/<div class="([^"]*rounded-xl border[^"]*)">/)
  assert.ok(match, `the card must render its outer surface: ${html}`)
  return match[1]!.trim()
}

test('insight and dashboard cards render the same light and dark card shell', () => {
  const insight = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <CardTile card={card} />
    </NextIntlClientProvider>,
  )
  const dashboard = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MoneyProvider currency="USD">
        <WidgetCard widgetId="reference-card-shell" data={{} as never} />
      </MoneyProvider>
    </NextIntlClientProvider>,
  )
  assert.equal(outerCardClass(insight), outerCardClass(dashboard))
  assert.match(outerCardClass(insight), /bg-white/)
  assert.match(outerCardClass(insight), /border-slate-200/)
  assert.match(outerCardClass(insight), /dark:border-slate-800/)
  assert.match(outerCardClass(insight), /dark:bg-slate-900/)
})
