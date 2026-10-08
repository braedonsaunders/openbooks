import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../testing/jsdom-env'
import { stubModules } from '../testing/stub-modules'

declare global {
  var __chartCalls: { action: string; value?: Record<string, unknown> }[]
}

await bootJsdomEnvironment()
stubModules({ extra: {
  echarts: `export function init(){
    globalThis.__chartCalls.push({action:'init'});
    return {
      setOption(){globalThis.__chartCalls.push({action:'setOption'})},
      dispatchAction(value){globalThis.__chartCalls.push({action:'dispatch',value})},
      resize(){},
      dispose(){globalThis.__chartCalls.push({action:'dispose'})}
    }
  }`,
} })
const React = await import('react')
Object.assign(globalThis, { React })
const { act } = React
const { createRoot } = await import('react-dom/client')
const { InsightChart } = await import('../../packages/analytics/src/viz/InsightChart')

async function renderChart(inspection?: { label: string; instructions: string; points: string[] }) {
  globalThis.__chartCalls = []
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<InsightChart option={{ series: [] }} height={180} inspection={inspection} />))
  return { host, done: async () => { await act(async () => root.unmount()); host.remove() } }
}

test('keyboard inspection highlights exact dated points in the native chart and clears on exit', async (t) => {
  const points = ['Jan 1 · CAD 70,000.01', 'Apr 1 · CAD 72,500.25', 'Sep 1 · CAD 78,000.50']
  const { host, done } = await renderChart({ label: 'Annual pay', instructions: 'Use arrow keys', points })
  t.after(done)
  const chart = host.querySelector<HTMLElement>('[role="group"]')!
  assert.equal(chart.tabIndex, 0)
  const instructions = chart.getAttribute('aria-describedby')!
  assert.equal(document.getElementById(instructions)?.textContent, 'Use arrow keys')
  const live = host.querySelector('[aria-live="polite"]')!
  await act(async () => chart.focus())
  assert.equal(live.textContent, points[2])
  for (const [key, index] of [['ArrowLeft', 1], ['Home', 0], ['ArrowLeft', 0], ['ArrowRight', 1], ['End', 2], ['ArrowRight', 2]] as const) {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    await act(async () => { chart.dispatchEvent(event) })
    assert.equal(event.defaultPrevented, true)
    assert.equal(live.textContent, points[index], 'the announced value must retain the exact formatted cents')
    assert.deepEqual(globalThis.__chartCalls.filter((call) => call.value?.type === 'showTip').at(-1)?.value,
      { type: 'showTip', seriesIndex: 0, dataIndex: index })
  }
  await act(async () => chart.blur())
  assert.equal(live.textContent, '')
  assert.ok(globalThis.__chartCalls.some((call) => call.value?.type === 'hideTip'))
})

test('charts without inspection retain their existing canvas and dispose their renderer', async () => {
  const { host, done } = await renderChart()
  try {
    assert.equal(host.querySelector('[tabindex]'), null)
    assert.equal(host.querySelector('[role="group"]'), null)
    assert.equal((host.firstElementChild as HTMLElement).style.height, '180px')
    assert.equal(globalThis.__chartCalls.filter((call) => call.action === 'init').length, 1)
    assert.equal(globalThis.__chartCalls.filter((call) => call.action === 'setOption').length, 1)
  } finally {
    await done()
  }
  assert.equal(globalThis.__chartCalls.filter((call) => call.action === 'dispose').length, 1)
})
