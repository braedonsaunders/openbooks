import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const reactUrl = pathToFileURL(require.resolve('react')).href

const { registerHooks } = await import('node:module')
// @openbooks/ui resolves to the main checkout via the worktree's symlinked
// root node_modules, so render the panel against minimal stubs: the contract
// under test is the table's own cell classes, not the ui primitives.
const uiStub = `import{createElement as h}from'${reactUrl}';
const passthrough=(tag)=>({children,...rest})=>h(tag,rest,children);
export const Button=passthrough('button');
export const Card=({children,className})=>h('div',{className},children);
export const Input=(props)=>h('input',props);
export const Label=({children})=>h('label',null,children);
export const Select=({children,...rest})=>h('select',rest,children);
export const Badge=({children})=>h('span',null,children);
export const Alert=({children})=>(children??null);
export const AlertDescription=({children})=>(children??null);
export const Skeleton=()=>null;`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@openbooks/ui') {
      return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(uiStub)}` }
    }
    return next(specifier, context)
  },
})

const React = await import('react')
const { renderToString } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { MoneyProvider } = await import('@/components/money-provider')
const { CollectionsClient } = await import('./CollectionsClient')

// F-t12-016: the recurring-schedules headers jammed into one string at 390px
// ("TemplateCustomerCadenceNext runRunsAuto-postStatus") — the header cells
// carry no gutters, so the eight columns collapse with zero separation and
// the overflow-x-auto wrapper has nothing to scroll. Every header cell must
// keep a horizontal gutter (and stay on one line) so the row scrolls instead
// of jamming.
function panelHtml() {
  return renderToString(
    React.createElement(MoneyProvider, {
      currency: 'CAD',
      children: React.createElement(NextIntlClientProvider, {
        locale: 'en',
        messages: {},
        children: React.createElement(CollectionsClient, {}),
      }),
    }),
  )
}

test('F-t12-016: recurring table headers keep gutters instead of jamming', () => {
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
