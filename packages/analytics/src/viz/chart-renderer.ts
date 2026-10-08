import type { EChartsOption } from '../viz'

const nativeSeries = new Set(['bar', 'line', 'pie', 'scatter', 'heatmap', 'treemap'])

/** Inspect every responsive and timeline branch before selecting a renderer.
 * Other series retain the complete ECharts contract through its full bundle. */
function usesNativeSeries(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const option = value as EChartsOption
  const series = option.series === undefined ? [] : Array.isArray(option.series) ? option.series : [option.series]
  return series.every((item) => item && typeof item === 'object' && typeof item.type === 'string' && nativeSeries.has(item.type))
    && (!option.baseOption || usesNativeSeries(option.baseOption))
    && (!option.options || (Array.isArray(option.options) && option.options.every(usesNativeSeries)))
    && (!option.media || (Array.isArray(option.media) && option.media.every((item) =>
      item && typeof item === 'object' && (!item.option || usesNativeSeries(item.option)))))
}

export async function loadChartRenderer(option: EChartsOption) {
  return usesNativeSeries(option) ? import('./native-chart-renderer') : import('echarts')
}
