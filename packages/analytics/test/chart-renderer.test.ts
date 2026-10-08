import assert from 'node:assert/strict'
import test from 'node:test'
import { loadChartRenderer } from '../src/viz/chart-renderer'
import type { EChartsOption } from '../src/viz'

test('native renderer draws every dashboard series with markers, calendar and dataset components', async () => {
  const cartesian = { animation: false, xAxis: { type: 'category', data: ['First', 'Second'] }, yAxis: {} }
  const options: EChartsOption[] = [
    { ...cartesian, series: [{ type: 'bar', data: [2, 4] }] },
    { ...cartesian, tooltip: { trigger: 'axis' }, legend: { type: 'scroll' }, dataset: { source: [['First', 2], ['Second', 4]] },
      series: [{ type: 'line', markLine: { data: [{ yAxis: 3 }] }, markPoint: { data: [{ type: 'max' }] } }] },
    { animation: false, series: [{ type: 'pie', data: [{ name: 'First', value: 2 }, { name: 'Second', value: 4 }] }] },
    { animation: false, xAxis: {}, yAxis: {}, series: [{ type: 'scatter', data: [[2, 4], [4, 2]] }] },
    { animation: false, calendar: { range: '2026-07' }, visualMap: { min: 0, max: 4 },
      series: [{ type: 'heatmap', coordinateSystem: 'calendar', data: [['2026-07-01', 2], ['2026-07-02', 4]] }] },
    { animation: false, series: [{ type: 'treemap', data: [{ name: 'First', value: 2 }, { name: 'Second', value: 4 }] }] },
  ]
  for (const option of options) {
    const renderer = await loadChartRenderer(option)
    const chart = renderer.init(null, undefined, { renderer: 'svg', ssr: true, width: 400, height: 240 })
    try {
      chart.setOption(option, { notMerge: true })
      const svg = chart.renderToSVGString()
      assert.match(svg, /<svg/)
      assert.match(svg, /<(?:path|rect|circle|polyline)\b/, 'the series must produce graphics')
      assert.equal((chart.getOption().series as { type: string }[])[0]?.type,
        (option.series as { type: string }[])[0]?.type)
      chart.dispatchAction({ type: 'highlight', seriesIndex: 0, dataIndex: 0 })
      chart.dispatchAction({ type: 'downplay', seriesIndex: 0 })
    } finally { chart.dispose() }
  }
})

test('full renderer preserves other series and later timeline or responsive option changes on the same chart', async () => {
  const option = { animation: false, series: [{ type: 'pie', data: [{ value: 4 }] }] }
  const renderer = await loadChartRenderer(option)
  const chart = renderer.init(null, undefined, { renderer: 'svg', ssr: true, width: 400, height: 240 })
  try {
    chart.setOption(option)
    // The full module registers against the same core as an existing canvas.
    // A later edit must load its additional series before setting its option.
    for (const next of [
      { animation: false, series: [{ type: 'gauge', data: [{ value: 42 }] }] },
      { baseOption: { animation: false, timeline: { data: ['First'], autoPlay: false }, series: [] },
        options: [{ series: [{ type: 'funnel', data: [{ value: 4 }] }] }] },
      { baseOption: { animation: false }, media: [{ query: { maxWidth: 500 }, option: { series: [{ type: 'radar', data: [] }], radar: { indicator: [{ name: 'First', max: 4 }] } } }] },
    ]) {
      const full = await loadChartRenderer(next)
      assert.ok('registerMap' in full, 'every non-native branch selects the complete renderer')
      chart.setOption(next, { notMerge: true })
      assert.match(chart.renderToSVGString(), /<svg/)
    }
  } finally { chart.dispose() }
})
