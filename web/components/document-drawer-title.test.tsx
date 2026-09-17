import assert from 'node:assert/strict'
import test from 'node:test'

const React = await import('react')
const { renderToString } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { DocumentDrawerTitle } = await import('./document-drawer')

// F-t12-013: the invoice drawer title row clipped the status pill to "Vo…"
// at 390px — the title was a single nowrap flex row, so the pill (last
// item) was what shrank. The pill must keep its width (shrink-0) and the
// row must wrap (flex-wrap) so the status stays readable.
function titleHtml() {
  return renderToString(
    React.createElement(NextIntlClientProvider, {
      locale: 'en',
      messages: {},
      children: React.createElement(DocumentDrawerTitle, {
        kind: 'customer_invoice',
        documentNumber: 'INV-00001',
        statusLabel: 'Voided',
        statusVariant: 'outline',
      }),
    }),
  )
}

test('F-t12-013: drawer title row wraps instead of clipping the status pill', () => {
  const html = titleHtml()
  assert.ok(html.includes('Voided'), 'status pill text must render in full')
  assert.ok(html.includes('INV-00001'), 'document number must render')
  const row = html.match(/<span class="([^"]*)">/)
  assert.ok(row, 'title row must render')
  assert.match(row[1]!, /flex-wrap/, 'title row must wrap on narrow viewports')
})

test('F-t12-013: status pill never shrinks', () => {
  const html = titleHtml()
  const pill = html.match(/<div class="([^"]*)">Voided<\/div>/)
  assert.ok(pill, 'status pill must render')
  assert.match(pill[1]!, /shrink-0/, 'status pill must keep its width, never clip')
})
