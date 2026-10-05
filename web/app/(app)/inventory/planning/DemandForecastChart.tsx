'use client'

/**
 * One item-by-location demand picture: history bars (amber where a stockout
 * week was imputed, so censored demand reads as an estimate), the forecast
 * as a line, and the 80% interval as a band. Pure SVG, no chart library —
 * the row-level trend already rides the shared Sparkline, and this drawing
 * is the only place a band around a forecast exists.
 */
export interface ChartHistoryWeek {
  weekStart: string
  quantity: string
  imputed: boolean
}

export interface ChartForecastWeek {
  periodStart: string
  quantity: string
  lower: string
  upper: string
}

const BAR = '#64748b'
const BAR_IMPUTED = '#d97706'
const BAND = 'rgba(37, 99, 235, 0.12)'
const LINE = '#2563eb'

function num(value: string): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function DemandForecastChart({
  history,
  forecast,
  height = 148,
}: {
  history: ChartHistoryWeek[]
  forecast: ChartForecastWeek[]
  height?: number
}) {
  const width = 560
  const pad = { top: 10, right: 8, bottom: 20, left: 8 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom
  const columns = history.length + forecast.length
  if (columns === 0) return null
  const top = Math.max(
    0,
    ...history.map((week) => num(week.quantity)),
    ...forecast.map((week) => num(week.upper)),
  )
  const scale = top > 0 ? innerH / top : 0
  const step = innerW / columns
  const barW = Math.max(2, Math.min(18, step * 0.6))
  const y = (value: number) => pad.top + innerH - value * scale

  const line = forecast
    .map((week, index) => {
      const x = pad.left + (history.length + index + 0.5) * step
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y(num(week.quantity)).toFixed(1)}`
    })
    .join(' ')
  const bandTop = forecast
    .map((week, index) => `${index === 0 ? 'M' : 'L'}${(pad.left + (history.length + index + 0.5) * step).toFixed(1)},${y(num(week.upper)).toFixed(1)}`)
    .join(' ')
  const bandBottom = [...forecast]
    .reverse()
    .map((week, rev) => {
      const index = forecast.length - 1 - rev
      return `L${(pad.left + (history.length + index + 0.5) * step).toFixed(1)},${y(num(week.lower)).toFixed(1)}`
    })
    .join(' ')
  const splitX = pad.left + history.length * step
  const lastHistory = history[history.length - 1]

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      role="img"
      aria-label="Demand history and forecast"
    >
      {history.map((week, index) => {
        const value = num(week.quantity)
        const x = pad.left + (index + 0.5) * step - barW / 2
        return (
          <rect
            key={week.weekStart}
            x={x.toFixed(1)}
            y={y(value).toFixed(1)}
            width={barW.toFixed(1)}
            height={Math.max(0, pad.top + innerH - y(value)).toFixed(1)}
            fill={week.imputed ? BAR_IMPUTED : BAR}
            opacity={week.imputed ? 0.85 : 0.55}
            rx={1}
          />
        )
      })}
      {forecast.length > 0 && (
        <path d={`${bandTop} ${bandBottom} Z`} fill={BAND} stroke="none" />
      )}
      {history.length > 0 && forecast.length > 0 && lastHistory && (
        <line
          x1={splitX.toFixed(1)}
          y1={pad.top}
          x2={splitX.toFixed(1)}
          y2={pad.top + innerH}
          stroke="#94a3b8"
          strokeDasharray="3 3"
          strokeWidth={1}
        />
      )}
      {forecast.length > 0 && <path d={line} fill="none" stroke={LINE} strokeWidth={2} />}
      {forecast.map((week, index) => {
        const x = pad.left + (history.length + index + 0.5) * step
        return (
          <circle key={week.periodStart} cx={x.toFixed(1)} cy={y(num(week.quantity)).toFixed(1)} r={2.5} fill={LINE} />
        )
      })}
      {lastHistory && (
        <text x={pad.left} y={(height - 6).toFixed(1)} fontSize={9} fill="#64748b">
          {lastHistory.weekStart}
        </text>
      )}
      {forecast.length > 0 && (
        <text
          x={(width - pad.right).toFixed(1)}
          y={(height - 6).toFixed(1)}
          fontSize={9}
          fill="#64748b"
          textAnchor="end"
        >
          {forecast[forecast.length - 1]!.periodStart}
        </text>
      )}
    </svg>
  )
}
