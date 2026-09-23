import assert from 'node:assert/strict'
import test from 'node:test'

const React = await import('react')
const { renderToString } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { ReportsHub } = await import('./ReportsHub')

// UX-12b: hub card titles wrapped mid-word under `truncate` and descriptions
// clipped mid-word ("custo…", "every…", "(this…") at 1280px, with the full
// text only in the link's title tooltip. Titles now wrap (no truncate) and
// copy is budgeted to fit two lines; line-clamp-2 stays as a visual safety
// net, and any still-clamped text stays reachable via aria-describedby —
// never the title tooltip alone.
const LONG_DESC =
  'Every outstanding vendor bill across all subsidiaries with due dates and aging buckets'

function hubHtml() {
  /* eslint-disable react/no-children-prop */
  return renderToString(
    React.createElement(NextIntlClientProvider, {
      locale: 'en',
      messages: { reports: { hub: { searchPlaceholder: 'Search reports', noMatches: 'No matches' } } },
      children: React.createElement(ReportsHub, {
        title: 'Reports',
        description: 'Financial and operational reports',
        canCreate: false,
        groups: [
          {
            key: 'payables',
            label: 'Payables',
            accent: 'teal',
            cards: [{ href: '/reports/ap-aging', title: 'AP aging', desc: LONG_DESC, icon: 'Receipt' }],
          },
        ],
      }),
    }),
  )
  /* eslint-enable react/no-children-prop */
}

test('UX-12b: card descriptions clamp to two readable lines, never one-line truncate', () => {
  const html = hubHtml()
  const desc = html.match(new RegExp(`<p id="([^"]*)" class="([^"]*)">${LONG_DESC}`))
  assert.ok(desc, 'the full description must render in the card body')
  assert.match(desc[2]!, /line-clamp-2/, 'description must use a two-line clamp')
  assert.doesNotMatch(desc[2]!, /(^|\s)truncate(\s|$)/, 'description must not one-line truncate mid-word')
})

test('UX-12b: the card title wraps instead of truncating mid-word', () => {
  const html = hubHtml()
  const title = html.match(/<h3 class="([^"]*)">AP aging<\/h3>/)
  assert.ok(title, 'the card title must render')
  assert.doesNotMatch(title[1]!, /(^|\s)truncate(\s|$)/, 'the title must wrap, never truncate')
})

test('UX-12b: a still-clamped description stays reachable without the title tooltip', () => {
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
