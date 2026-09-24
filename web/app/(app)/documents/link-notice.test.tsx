// F4T-17: a ?file= / ?folder= that resolves to nothing must say so. The
// drawers stay closed by design, so the page carries an inline notice
// instead of rendering the plain list as if the link had worked.

import assert from 'node:assert/strict'
import test from 'node:test'

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return p.children}',
      }
    }
    return next(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { renderToStaticMarkup } = await import('react-dom/server')
const { DocumentsLinkNotice } = await import('./sections')

test('the dead-link notice names the message as an alert', () => {
  const html = renderToStaticMarkup(
    React.createElement(DocumentsLinkNotice, {
      message: 'The requested file or folder could not be opened.',
    }),
  )
  assert.match(html, /role="alert"/, 'the notice is announced as an alert')
  assert.ok(
    html.includes('The requested file or folder could not be opened.'),
    'the notice carries the loader message',
  )
})
