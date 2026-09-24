import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import './_dashboard-render-harness'
import { act, fireResize, mountDashboard, observedElements, setCellSize, tick } from './_dashboard-render-harness'
import { metricTilePack } from './_metric-tile-density'
import type { DashboardMetrics } from './_metrics'

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims.
const { WidgetCard } = await import('./_widget-views')

const dir = dirname(fileURLToPath(import.meta.url));
const dashboardEn = JSON.parse(
  readFileSync(join(dir, '..', '..', '..', 'messages', 'en', 'dashboard.json'), 'utf8'),
);

// Default KPI cells are h:2 = 112px with a 16px radius. The pack must fit
// that cell — not ask the grid for another row — and still clear the curve.
test('the default 112px cell keeps a 26px figure and a 20px caption inset', () => {
  const pack = metricTilePack(256, 112)
  assert.equal(pack.figure, 26)
  assert.equal(pack.padBottom, 20)
  assert.equal(pack.icon, 28)
  assert.equal(pack.hintLines, 1)
  assert.equal(pack.narrow, false)
  const used =
    pack.padTop + pack.icon + pack.hintGap + pack.figure + pack.hintGap + 11 + pack.padBottom
  assert.ok(used <= 110, `compact pack must fit the bordered 112px cell, used ${used}`)
})

test('a stretched cell grows inset and type without a new default height', () => {
  const mid = metricTilePack(256, 176)
  const tall = metricTilePack(256, 240)
  assert.ok(mid.padBottom >= 20)
  assert.ok(tall.padBottom >= mid.padBottom)
  assert.ok(tall.figure >= mid.figure)
  assert.equal(mid.hintLines, 2)
})

test('narrow KPI cells hide the accent pill', () => {
  assert.equal(metricTilePack(160, 112).narrow, true)
  assert.equal(metricTilePack(200, 112).narrow, false)
})

// The tile must measure the cell, not the viewport, and the packing must come
// from the shared helper: render the exported card with a scripted cell size
// and read the packing back out of the markup (hand values from the sizing
// rule the helper tests above pin independently).
test('the rendered tile packs from its measured cell and repacks on resize', async () => {
  const data = { journalLineCount: 42 } as unknown as DashboardMetrics
  setCellSize(256, 112)
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-journal-lines" data={data} />,
    { dashboard: dashboardEn },
  )
  try {
    const figure = host.querySelector('.tabular-nums')
    assert.ok(
      figure instanceof HTMLElement && figure.textContent === '42',
      'the tile renders the KPI value',
    )
    assert.ok(
      observedElements.some((el) => el.contains(figure)),
      'the tile subscribes to its own cell resizes',
    )
    assert.equal(figure.style.fontSize, '26px')
    const cell = figure.parentElement?.parentElement
    assert.ok(cell, 'the value sits inside the measured cell')
    assert.equal(cell.style.paddingBottom, '20px')
    assert.ok(host.querySelector('.from-teal-500'), 'the accent pill renders in a wide cell')

    await act(async () => {
      setCellSize(160, 112)
      fireResize()
      await tick()
    })
    assert.equal(figure.style.fontSize, '26px', 'the figure follows the same height')
    assert.equal(
      host.querySelector('.from-teal-500'),
      null,
      'a 160px cell hides the accent pill',
    )

    await act(async () => {
      setCellSize(256, 240)
      fireResize()
      await tick()
    })
    assert.equal(figure.style.fontSize, '28px', 'a taller cell grows the figure')
    assert.equal(cell.style.paddingBottom, '28px', 'a taller cell grows the inset')
  } finally {
    await unmount()
  }
})
