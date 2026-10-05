const { stubModules } = await import('../../../testing/stub-modules')
stubModules({ navigation: true })
import assert from 'node:assert/strict'
import test from 'node:test'

const React = await import('react')
// Classic-JSX fallback: the shared tsx cache can serve a classic transform,
// which resolves bare React from the global scope, not the module scope.
Object.assign(globalThis, { React })
const { renderToString } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../messages/en')).default
// Loaded after the navigation stub registers: the hub's search field reads
// the router hooks.
const { ReportsHub } = await import('./ReportsHub')

// Hub card titles once truncated mid-word and descriptions clipped mid-word
// at 1280px, with the full text only in a title tooltip. Titles wrap (no
// truncate) and copy is budgeted to fit two lines; line-clamp-2 stays as a
// visual safety net, and any still-clamped text stays reachable through
// aria-describedby — never the title tooltip alone.
const LONG_DESC =
  'Every outstanding vendor bill across all subsidiaries with due dates and aging buckets'

type Groups = Parameters<typeof ReportsHub>[0]['groups']

const GROUPS: Groups = [
  {
    key: 'payables',
    label: 'Payables',
    accent: 'teal',
    cards: [{ href: '/reports/ap-aging', title: 'AP aging', desc: LONG_DESC, icon: 'Receipt', form: 'aging' }],
  },
  {
    key: 'financial',
    label: 'Financial statements',
    accent: 'sky',
    cards: [
      { href: '/reports/pnl', title: 'Profit & Loss', desc: 'Profit and loss for the period', icon: 'FileText', form: 'statement' },
      { href: '/reports/pnl?period=ytd', title: 'Year-to-date P&L', desc: 'Saved views', icon: 'Bookmark', form: 'statement', saved: true },
    ],
  },
]

function hubHtml(groups: Groups = GROUPS) {
  /* eslint-disable react/no-children-prop */
  return renderToString(
    React.createElement(NextIntlClientProvider, {
      locale: 'en',
      timeZone: 'UTC',
      messages,
      children: React.createElement(ReportsHub, {
        title: 'Reports',
        description: 'Financial and operational reports',
        canCreate: false,
        groups,
      }),
    }),
  )
  /* eslint-enable react/no-children-prop */
}

test('card descriptions clamp to two readable lines, never one-line truncate', () => {
  const html = hubHtml()
  const desc = html.match(new RegExp(`<p id="([^"]*)" class="([^"]*)">${LONG_DESC}`))
  assert.ok(desc, 'the full description must render in the card body')
  assert.match(desc[2]!, /line-clamp-2/, 'description must use a two-line clamp')
  assert.doesNotMatch(desc[2]!, /(^|\s)truncate(\s|$)/, 'description must not one-line truncate mid-word')
})

test('the card title wraps instead of truncating mid-word', () => {
  const html = hubHtml()
  const title = html.match(/<h3 class="([^"]*)">AP aging<\/h3>/)
  assert.ok(title, 'the card title must render')
  assert.doesNotMatch(title[1]!, /(^|\s)truncate(\s|$)/, 'the title must wrap, never truncate')
})

test('a still-clamped description stays reachable without the title tooltip', () => {
  const html = hubHtml()
  assert.doesNotMatch(html, / title="/, 'the card must not rely on the title tooltip alone')
  const link = html.match(/<a[^>]*aria-describedby="([^"]*)"[^>]*>/)
  assert.ok(link, 'the card link must describe itself with the full description')
  const descId = link[1]!
  assert.ok(
    html.includes(`<p id="${descId}"`),
    'aria-describedby must point at the rendered description element',
  )
  assert.ok(html.includes(`>${LONG_DESC}<`), 'the full description text must render in the card body')
})

test('every group is a tab with its report count, and every report links once', () => {
  const html = hubHtml()
  for (const label of ['All reports', 'Payables', 'Financial statements']) {
    assert.ok(html.includes(label), `the ${label} tab must render`)
  }
  for (const href of ['/reports/ap-aging', '/reports/pnl', '/reports/pnl?period=ytd']) {
    const escaped = href.replace(/[?&]/g, (char) => (char === '&' ? '&amp;' : '\\?'))
    assert.equal(html.match(new RegExp(`href="${escaped}"`, 'g'))?.length, 1, `${href} must link exactly once`)
  }
  assert.ok(html.includes('2 reports'), 'a group section names how many reports it holds')
})

test('the miniature sheet is decoration, so assistive technology reads each title once', () => {
  const html = hubHtml()
  // The letterhead repeats the title for sighted users; it must sit inside
  // an aria-hidden subtree so the accessible name is the caption alone.
  const sheet = html.match(/<div aria-hidden="true"[^>]*>(?:(?!<h3).)*?Profit &amp; Loss/s)
  assert.ok(sheet, 'the letterhead title must render inside an aria-hidden sheet')
  assert.equal(html.match(/<h3[^>]*>Profit &amp; Loss<\/h3>/g)?.length, 1, 'the caption heading names the report once')
})

test('an empty catalog states that nothing matches instead of rendering a blank page', () => {
  const html = hubHtml([])
  assert.ok(html.includes('No reports match your search.'))
})
