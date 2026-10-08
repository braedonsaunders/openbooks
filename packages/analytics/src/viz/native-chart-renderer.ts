import { use } from 'echarts/core'
import { BarChart, LineChart, PieChart, ScatterChart, HeatmapChart, TreemapChart } from 'echarts/charts'
import * as components from 'echarts/components'
import { LabelLayout, UniversalTransition } from 'echarts/features'
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers'

// Keep coordinate systems, markers, datasets, interaction and accessibility
// components available for the native series, including calendar heatmaps.
use([
  BarChart, LineChart, PieChart, ScatterChart, HeatmapChart, TreemapChart,
  ...Object.values(components), LabelLayout, UniversalTransition,
  CanvasRenderer, SVGRenderer,
])

export { init } from 'echarts/core'
