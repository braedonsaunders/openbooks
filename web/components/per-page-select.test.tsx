import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// The page-size choice must preserve the rest of the list state: switching
// size resets the page to 1 but keeps search, sort, direction and filters on
// the URL through mergeHref — otherwise every size change silently drops the
// operator's place. These assertions read the rendered links, never classes.

const LINK_MOCK = `
  export default function Link(p) { return globalThis.React.createElement('a', { href: p.href }, p.children) }
`

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/link') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,' + encodeURIComponent(LINK_MOCK) }
    }
    return nextResolve(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { renderToString } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { PerPageSelect } = await import('./per-page-select.tsx')
hooks.deregister()

function htmlFor(params: Record<string, string | string[] | undefined>, perPage: number): string {
  /* eslint-disable react/no-children-prop */
  return renderToString(
    React.createElement(NextIntlClientProvider, {
      locale: 'en',
      messages: { ui: { pagination: { perPage: 'Rows per page' } } },
      children: React.createElement(PerPageSelect, {
        basePath: '/platform/users',
        currentParams: params,
        perPage,
      }),
    }),
  )
  /* eslint-enable react/no-children-prop */
}

test('the current size renders marked, the rest link to it', () => {
  const html = htmlFor({ q: 'w93', sort: 'name', dir: 'asc', page: '3', status: 'active' }, 50)
  assert.match(html, /Rows per page/, 'the control names itself')
  assert.match(html, /aria-current="true"[^>]*>50</, 'the active size is marked, not linked')
  const to25 = html.match(/<a href="([^"]*)">25<\/a>/)
  assert.ok(to25, 'an inactive size links somewhere')
  const href = to25[1]!
  assert.match(href, /perPage=25/, 'the link carries the new size')
  assert.match(href, /page=1/, 'the link resets to the first page')
  assert.match(href, /q=w93/, 'the link keeps the search')
  assert.match(href, /sort=name/, 'the link keeps the sort')
  assert.match(href, /dir=asc/, 'the link keeps the direction')
  assert.match(href, /status=active/, 'the link keeps the filter')
})

test('the default options cover the house clamp range', () => {
  const html = htmlFor({}, 25)
  assert.match(html, />25</, 'the smallest choice renders')
  assert.match(html, />50</, 'a middle choice renders')
  assert.match(html, />100</, 'the largest choice renders')
})
