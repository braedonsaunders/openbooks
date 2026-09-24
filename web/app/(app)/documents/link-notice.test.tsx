// F4T-17: a ?file= / ?folder= that resolves to nothing must say so. The
// drawers stay closed by design, so the page carries an inline notice
// instead of rendering the plain list as if the link had worked.

import { readFileSync } from 'node:fs'
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

const view = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')
const contracts = readFileSync(
  new URL('../../../components/viewspec/widget-contracts.ts', import.meta.url),
  'utf8',
)
const widgets = readFileSync(
  new URL('../../../components/viewspec/widgets-records.tsx', import.meta.url),
  'utf8',
)

test('the loader notices every requested-but-unresolved drawer param', () => {
  assert.match(
    view,
    /sp\.file !== undefined && !openFile/,
    'a ?file= with no resolved file notices',
  )
  assert.match(
    view,
    /folderParam !== undefined && \(folderParam === 'new' \? !canManage : !openFolder\)/,
    'a ?folder= with no resolved folder notices, including new without manage',
  )
  assert.match(view, /linkNotice/, 'the notice travels on the loader data')
  assert.match(
    view,
    /widgetBlock\('documents-link-notice', \{ message: data\.linkNotice/,
    'the spec renders the notice widget',
  )
  assert.match(view, /when: f\('linkNotice'\)/, 'the notice renders only when set')
})

test('the notice widget is registered with its message prop', () => {
  assert.match(
    contracts,
    /'documents-link-notice': \{ props: \['message'\] \}/,
    'the widget contract names the message prop',
  )
  assert.match(widgets, /'documents-link-notice'/, 'the widget is registered')
})
