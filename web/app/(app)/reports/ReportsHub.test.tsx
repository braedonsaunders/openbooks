import assert from 'node:assert/strict'
import test from 'node:test'

const React = await import('react')
const { renderToString } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { ReportsHub } = await import('./ReportsHub')

// UX-12: hub card descriptions rendered one-line `truncate`, clipping
// mid-word at desktop widths. Descriptions get a readable two-line clamp;
// the full text stays on the link tooltip. Titles stay single-line.
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

test('UX-12: card descriptions clamp to two readable lines, never one-line truncate', () => {
  const html = hubHtml()
  const desc = html.match(new RegExp(`<p class="([^"]*)">${LONG_DESC}`))
  assert.ok(desc, 'the full description must render in the card body')
  assert.match(desc[1]!, /line-clamp-2/, 'description must use a two-line clamp')
  assert.doesNotMatch(desc[1]!, /(^|\s)truncate(\s|$)/, 'description must not one-line truncate mid-word')
})

test('UX-12: the full description stays on the card tooltip and the title stays single-line', () => {
  const html = hubHtml()
  assert.ok(html.includes(`title="${LONG_DESC}"`), 'the card link must keep the full description as its tooltip')
  const title = html.match(/<h3 class="([^"]*)">AP aging<\/h3>/)
  assert.ok(title, 'the card title must render')
  assert.match(title[1]!, /(^|\s)truncate(\s|$)/, 'the title stays a single truncated line')
})
