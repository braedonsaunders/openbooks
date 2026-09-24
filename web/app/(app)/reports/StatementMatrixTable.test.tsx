import assert from 'node:assert/strict'
import test from 'node:test'

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export function usePathname(){return '/reports/pnl'}export function useSearchParams(){return new URLSearchParams()}export function useRouter(){return {}}`,
      }
    }
    return next(specifier, context)
  },
})

const React = await import('react')
// Classic-JSX fallback: the shared tsx cache can serve a classic transform,
// which resolves bare React from the global scope, not the module scope.
Object.assign(globalThis, { React })
const { renderToString } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { MoneyProvider } = await import('../../../components/money-provider')
const { StatementMatrixTable } = await import('./StatementMatrixTable')

// F-t07-008: at 390px the amount cells clipped mid-number past the viewport
// with no reachable scroll. The table must render inside a real horizontal
// scroll container so every amount stays reachable on phones.
function matrixHtml(): string {
  return renderToString(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{
        reports: {
          filterBar: {
            expandSection: 'Expand {section}',
            collapseSection: 'Collapse {section}',
          },
        },
      }}
    >
      <MoneyProvider currency="USD">
        <StatementMatrixTable
          currency="USD"
          view={{
            columns: [{ key: 'current', label: '2026', kind: 'amount' }],
            lines: [
              { kind: 'section', label: 'Assets', depth: 0 },
              { kind: 'account', label: 'Cash', depth: 1, values: ['1234.5600'] },
            ],
            truncated: false,
            hasVariance: false,
            mode: 'balance',
          }}
        />
      </MoneyProvider>
    </NextIntlClientProvider>,
  )
}

test('statement amounts render inside a reachable horizontal scroll container at phone widths', () => {
  const html = matrixHtml()
  const scroller = html.match(/<div class="([^"]*)"><table/)
  assert.ok(scroller, 'the statement table must render inside a scroll container')
  assert.match(scroller[1]!, /overflow-x-auto/, 'the container must scroll horizontally instead of spilling past the viewport')
  assert.match(scroller[1]!, /min-w-0/, 'the container must be shrinkable so flex ancestors cannot stretch it past the viewport')
  const table = html.slice(html.indexOf('<table'))
  assert.ok(table.includes('Cash'), 'the account label must render inside the scroll container')
  assert.ok(table.includes('1,234.56'), 'the exact amount 1234.56 USD must render in full inside the scroll container')
})
