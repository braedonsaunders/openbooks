import assert from 'node:assert/strict'
import test from 'node:test'

// A null band set is the "no verdict" presentation: the ring and the
// figure stay slate. Grading a stand-in 0 against configured bands would
// read poor — the exact failure an unscored organization must never see —
// while a genuinely scored 0 keeps grading poor.
const React = await import('react')
Object.assign(globalThis, { React })
const { renderToStaticMarkup } = await import('react-dom/server')
const { Gauge } = await import('./Gauge')

test('a gauge without bands renders untoned, never poor', () => {
  const html = renderToStaticMarkup(<Gauge value={0} bands={null} />)
  assert.ok(html.includes('#64748b'), 'the ring gradient carries no grade')
  assert.ok(html.includes('text-slate-500'), 'the figure carries no grade')
  assert.ok(!html.includes('text-red-600'), 'a stand-in 0 never reads poor')
  assert.ok(!html.includes('#ef4444'), 'a stand-in 0 never paints poor')
})

test('a scored zero against configured bands still grades poor', () => {
  const html = renderToStaticMarkup(<Gauge value={0} bands={{ excellent: 80, good: 60, average: 40 }} />)
  assert.ok(html.includes('text-red-600'), 'configured bands keep grading a real 0')
})
