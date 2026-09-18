import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { metricTilePack } from './_metric-tile-density'

// Default KPI cells are h:2 = 112px with a 16px radius. The pack must fit
// that cell — not ask the grid for another row — and still clear the curve.
const source = readFileSync(join(process.cwd(), 'web/app/(app)/dashboard/_widget-views.tsx'), 'utf8')

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

test('the tile measures the cell it was given', () => {
  assert.match(source, /ResizeObserver/, 'the tile must measure the cell, not the viewport')
  assert.match(source, /metricTilePack/, 'packing must come from the shared helper')
})
