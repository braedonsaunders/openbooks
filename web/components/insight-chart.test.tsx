import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../testing/jsdom-env'
import { stubModules } from '../testing/stub-modules'

declare global {
  var __chartCalls: { action: string; value?: Record<string, unknown> }[]
  var __chartLoadGate: Promise<void>
  var __chartInitFailure: Error | undefined
}

await bootJsdomEnvironment()
let releaseRenderer!: () => void
globalThis.__chartLoadGate = new Promise<void>((resolve) => { releaseRenderer = resolve })
stubModules({ extra: {
  echarts: `await globalThis.__chartLoadGate;
  export function init(){
    if(globalThis.__chartInitFailure) throw globalThis.__chartInitFailure;
    globalThis.__chartCalls.push({action:'init'});
    return {
      setOption(value){globalThis.__chartCalls.push({action:'setOption',value})},
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

test('renderer loading retains current options and focused inspection and never initializes an unmounted chart', async () => {
  globalThis.__chartCalls = []
  const host = document.createElement('div')
  const cancelledHost = document.createElement('div')
  document.body.append(host, cancelledHost)
  const root = createRoot(host)
  const cancelledRoot = createRoot(cancelledHost)
  let cancelledUnmounted = false
  const inspection = { label: 'Annual pay', instructions: 'Use arrow keys', points: ['Jan 1 · CAD 70,000.01', 'Apr 1 · CAD 72,500.25'] }
  const latest = { series: [{ type: 'line', data: [70000.01, 72500.25] }] }
  try {
    await act(async () => {
      root.render(<InsightChart option={{ series: [] }} inspection={inspection} />)
      cancelledRoot.render(<InsightChart option={{ series: [] }} />)
    })
    assert.equal(globalThis.__chartCalls.length, 0)
    await act(async () => {
      host.querySelector<HTMLElement>('[role="group"]')!.focus()
      root.render(<InsightChart option={latest} inspection={inspection} />)
      cancelledRoot.unmount()
      cancelledUnmounted = true
    })
    assert.equal(host.querySelector('[aria-live="polite"]')?.textContent, inspection.points[1])
    await act(async () => { releaseRenderer(); await globalThis.__chartLoadGate })
    assert.equal(globalThis.__chartCalls.filter((call) => call.action === 'init').length, 1)
    assert.deepEqual(globalThis.__chartCalls.find((call) => call.action === 'setOption')?.value, latest)
    assert.deepEqual(globalThis.__chartCalls.find((call) => call.value?.type === 'showTip')?.value,
      { type: 'showTip', seriesIndex: 0, dataIndex: 1 })
  } finally {
    releaseRenderer()
    await act(async () => {
      root.unmount()
      if (!cancelledUnmounted) cancelledRoot.unmount()
    })
    host.remove()
    cancelledHost.remove()
  }
  assert.equal(globalThis.__chartCalls.filter((call) => call.action === 'dispose').length, 1)
})

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

test('renderer initialization failures retain their cause at the caller boundary and a remount can recover', async () => {
  const cause = new Error('Canvas renderer unavailable')
  let caught: unknown
  class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
    state = { failed: false }
    static getDerivedStateFromError() { return { failed: true } }
    componentDidCatch(error: unknown) { caught = error }
    render() { return this.state.failed ? <div role="alert">Chart unavailable</div> : this.props.children }
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host, { onCaughtError() {} })
  globalThis.__chartCalls = []
  try {
    globalThis.__chartInitFailure = cause
    await act(async () => root.render(<Boundary key="failed"><InsightChart option={{ series: [] }} /></Boundary>))
    assert.equal(caught, cause)
    assert.equal(host.querySelector('[role="alert"]')?.textContent, 'Chart unavailable')
    globalThis.__chartInitFailure = undefined
    await act(async () => root.render(<Boundary key="retry"><InsightChart option={{ series: [] }} /></Boundary>))
    assert.equal(host.querySelector('[role="alert"]'), null)
    assert.equal(globalThis.__chartCalls.filter((call) => call.action === 'init').length, 1)
  } finally {
    globalThis.__chartInitFailure = undefined
    await act(async () => root.unmount())
    host.remove()
  }
  assert.equal(globalThis.__chartCalls.filter((call) => call.action === 'dispose').length, 1)
})
