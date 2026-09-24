import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, _context, next) {
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export default function Link(p){return globalThis.React.createElement("a",{href:p.href},p.children)}',
      }
    }
    return next(specifier)
  },
})

const React = await import('react')
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { renderToStaticMarkup } = await import('react-dom/server')
const { ForecastExcludedNote, ForecastSection, ForecastSectionHeading } = await import('./sections.tsx')

test('forecast exclusion note names the count and links to the filtered pipeline', () => {
  const html = renderToStaticMarkup(
    React.createElement(ForecastExcludedNote, {
      note: 'Excluded: 3 undated opportunities',
      href: '/crm/opportunities?view=board&undated=1',
      linkLabel: 'View undated',
    }),
  )
  assert.match(html, /Excluded: 3 undated opportunities/)
  assert.match(html, /href="\/crm\/opportunities\?view=board&amp;undated=1"/)
  assert.match(html, />View undated</)
})

test('forecast section connects its content to its visible heading', () => {
  const html = renderToStaticMarkup(
    ForecastSection({
      labelledBy: 'pipeline-heading',
      children: React.createElement(ForecastSectionHeading, {
        id: 'pipeline-heading',
        icon: React.createElement('span', null, '↗'),
        title: 'Pipeline',
        description: 'Expected close dates group forecast periods.',
      }),
    }),
  )
  assert.match(html, /aria-labelledby="pipeline-heading"/)
  assert.match(html, /<h2 id="pipeline-heading"[^>]*>Pipeline<\/h2>/)
  assert.match(html, /Expected close dates group forecast periods\./)
})
