/**
 * Time-series forecasting engine — a faithful TypeScript port of Gantry's
 * Dashboard.Health.js forecast methods (ETS/Holt-Winters, linear regression,
 * seasonal decomposition, moving average, ARIMA-style) plus the trend/σ,
 * seasonality detection, and MAPE/RMSE/R² diagnostics. Pure and deterministic
 * so it runs client-side off the monthly GL series.
 */

export type ForecastMethod = 'ets' | 'linear' | 'seasonal' | 'moving_avg' | 'arima'
export type Seasonality = 'auto' | 'none' | 'monthly' | 'quarterly'

export interface ForecastResult {
  values: number[]
  low: number[]
  high: number[]
  fitted: number[]
  trend: number
  seasonal: boolean
  seasonalPeriod: number
}

export interface ForecastDiagnostics {
  mape: number
  rmse: number
  r2: number
  trendDir: 'Upward' | 'Downward' | 'Flat'
  seasonLabel: string
}

const Z: Record<number, number> = { 80: 1.282, 90: 1.645, 95: 1.96, 99: 2.576 }

function sum(a: number[]): number {
  return a.reduce((x, y) => x + y, 0)
}

export function calculateTrend(data: number[]): { slope: number; intercept: number } {
  const n = data.length
  if (n < 2) return { slope: 0, intercept: data[0] || 0 }
  const xMean = (n - 1) / 2
  const yMean = sum(data) / n
  let numerator = 0
  let denominator = 0
  data.forEach((val, i) => {
    numerator += (i - xMean) * (val - yMean)
    denominator += (i - xMean) ** 2
  })
  const slope = denominator !== 0 ? numerator / denominator : 0
  return { slope, intercept: yMean - slope * xMean }
}

export function calculateStdDev(data: number[]): number {
  if (data.length < 2) return 0
  const mean = sum(data) / data.length
  const variance = data.reduce((s, v) => s + (v - mean) ** 2, 0) / data.length
  return Math.sqrt(variance)
}

export function detectSeasonality(data: number[]): number {
  const n = data.length
  if (n < 24) return 0
  const mean = sum(data) / n
  const variance = data.reduce((s, x) => s + (x - mean) ** 2, 0) / n
  let bestPeriod = 0
  let bestCorr = 0
  for (const period of [3, 4, 6, 12]) {
    if (n >= period * 2) {
      let sumCorr = 0
      for (let i = period; i < n; i++) sumCorr += (data[i] - mean) * (data[i - period] - mean)
      const corr = variance > 0 ? sumCorr / ((n - period) * variance) : 0
      if (corr > bestCorr && corr > 0.3) {
        bestCorr = corr
        bestPeriod = period
      }
    }
  }
  return bestPeriod
}

function band(values: number[], sd: number, z: number, spread: number): { low: number[]; high: number[] } {
  return {
    low: values.map((v, i) => v - sd * z * (1 + i * spread)),
    high: values.map((v, i) => v + sd * z * (1 + i * spread)),
  }
}

export function forecastETS(data: number[], horizon: number, seasonalPeriod: number, z = 1.645): ForecastResult {
  const n = data.length
  const alpha = 0.3
  const beta = 0.1
  const gamma = 0.2
  let level = data[0]
  let trend = n > 1 ? data[1] - data[0] : 0
  const seasonal: number[] = []
  if (seasonalPeriod > 0 && n >= seasonalPeriod * 2) {
    for (let i = 0; i < seasonalPeriod; i++) {
      let s = 0
      let count = 0
      for (let j = i; j < n; j += seasonalPeriod) {
        s += data[j]
        count++
      }
      seasonal.push(count > 0 ? s / count / (sum(data) / n) : 1)
    }
  }
  const fitted: number[] = []
  for (let t = 0; t < n; t++) {
    const seasonFactor = seasonal.length > 0 ? seasonal[t % seasonalPeriod] : 1
    const newLevel = alpha * (data[t] / seasonFactor) + (1 - alpha) * (level + trend)
    const newTrend = beta * (newLevel - level) + (1 - beta) * trend
    if (seasonal.length > 0) seasonal[t % seasonalPeriod] = gamma * (data[t] / newLevel) + (1 - gamma) * seasonal[t % seasonalPeriod]
    level = newLevel
    trend = newTrend
    fitted.push(level * seasonFactor)
  }
  const values: number[] = []
  for (let h = 1; h <= horizon; h++) {
    const seasonFactor = seasonal.length > 0 ? seasonal[(n + h - 1) % seasonalPeriod] : 1
    values.push((level + trend * h) * seasonFactor)
  }
  const sd = calculateStdDev(data)
  return { values, ...band(values, sd, z, 0.1), fitted, trend, seasonal: seasonal.length > 0, seasonalPeriod }
}

export function forecastLinear(data: number[], horizon: number, z = 1.645): ForecastResult {
  const n = data.length
  const trend = calculateTrend(data)
  const fitted = data.map((_, i) => trend.intercept + trend.slope * i)
  const values: number[] = []
  for (let h = 0; h < horizon; h++) values.push(trend.intercept + trend.slope * (n + h))
  const sd = calculateStdDev(data)
  return { values, ...band(values, sd, z, 0.15), fitted, trend: trend.slope, seasonal: false, seasonalPeriod: 0 }
}

export function forecastSeasonal(data: number[], horizon: number, period: number, z = 1.645): ForecastResult {
  const n = data.length
  const trend = calculateTrend(data)
  const seasonalIdx: number[] = []
  for (let i = 0; i < period; i++) {
    const vals: number[] = []
    for (let j = i; j < n; j += period) vals.push(data[j] - (trend.intercept + trend.slope * j))
    seasonalIdx.push(vals.length > 0 ? sum(vals) / vals.length : 0)
  }
  const fitted = data.map((_, i) => trend.intercept + trend.slope * i + seasonalIdx[i % period])
  const values: number[] = []
  for (let h = 0; h < horizon; h++) values.push(trend.intercept + trend.slope * (n + h) + seasonalIdx[(n + h) % period])
  const sd = calculateStdDev(data)
  return { values, ...band(values, sd, z, 0.12), fitted, trend: trend.slope, seasonal: true, seasonalPeriod: period }
}

export function forecastMovingAvg(data: number[], horizon: number, z = 1.645): ForecastResult {
  const n = data.length
  const windowSize = Math.min(6, Math.floor(n / 2)) || 1
  const ma: number[] = []
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - windowSize + 1)
    const slice = data.slice(start, i + 1)
    ma.push(sum(slice) / slice.length)
  }
  const trend = calculateTrend(ma.slice(-windowSize))
  const lastMA = ma[ma.length - 1]
  const values: number[] = []
  for (let h = 0; h < horizon; h++) values.push(lastMA + trend.slope * h)
  const sd = calculateStdDev(data)
  return { values, ...band(values, sd, z, 0.2), fitted: ma, trend: trend.slope, seasonal: false, seasonalPeriod: 0 }
}

export function forecastARIMA(data: number[], horizon: number, seasonalPeriod: number, z = 1.645): ForecastResult {
  const n = data.length
  const diff: number[] = []
  for (let i = 1; i < n; i++) diff.push(data[i] - data[i - 1])
  let ar1 = 0
  if (diff.length > 1) {
    let sumXY = 0
    let sumX2 = 0
    for (let i = 1; i < diff.length; i++) {
      sumXY += diff[i] * diff[i - 1]
      sumX2 += diff[i - 1] * diff[i - 1]
    }
    ar1 = sumX2 > 0 ? sumXY / sumX2 : 0
  }
  ar1 = Math.max(-0.9, Math.min(0.9, ar1))
  const ma1 = 0.3
  let lastDiff = diff[diff.length - 1] || 0
  let lastValue = data[n - 1]
  const values: number[] = []
  for (let h = 0; h < horizon; h++) {
    const nextDiff = ar1 * lastDiff + ma1 * (lastDiff - ar1 * (diff[diff.length - 2] || 0))
    lastValue = lastValue + nextDiff
    values.push(lastValue)
    lastDiff = nextDiff
  }
  const fitted = [data[0]]
  lastDiff = 0
  for (let i = 1; i < n; i++) {
    fitted.push(fitted[i - 1] + ar1 * lastDiff)
    lastDiff = diff[i - 1] || 0
  }
  const sd = calculateStdDev(diff) || calculateStdDev(data)
  return {
    values,
    low: values.map((v, i) => v - sd * z * Math.sqrt(i + 1)),
    high: values.map((v, i) => v + sd * z * Math.sqrt(i + 1)),
    fitted,
    trend: diff.length > 0 ? sum(diff) / diff.length : 0,
    seasonal: seasonalPeriod > 0,
    seasonalPeriod,
  }
}

export function applyForecastMethod(
  data: number[],
  method: ForecastMethod,
  horizon: number,
  seasonality: Seasonality,
  confidence: number,
  growthOverride: number | null = null,
): ForecastResult {
  const n = data.length
  const z = Z[confidence] ?? 1.645
  let seasonalPeriod = 0
  if (seasonality === 'auto' && n >= 12) seasonalPeriod = detectSeasonality(data)
  else if (seasonality === 'monthly') seasonalPeriod = 1
  else if (seasonality === 'quarterly') seasonalPeriod = 3

  let result: ForecastResult
  switch (method) {
    case 'ets':
      result = forecastETS(data, horizon, seasonalPeriod, z)
      break
    case 'linear':
      result = forecastLinear(data, horizon, z)
      break
    case 'seasonal':
      result = forecastSeasonal(data, horizon, seasonalPeriod || 12, z)
      break
    case 'moving_avg':
      result = forecastMovingAvg(data, horizon, z)
      break
    case 'arima':
      result = forecastARIMA(data, horizon, seasonalPeriod, z)
      break
    default:
      result = forecastLinear(data, horizon, z)
  }

  if (growthOverride !== null && !Number.isNaN(growthOverride)) {
    const baseValue = data[n - 1]
    const monthlyGrowth = growthOverride / 100 / 12
    result.values = Array.from({ length: horizon }, (_, i) => baseValue * (1 + monthlyGrowth) ** (i + 1))
  }
  return result
}

/** Macro adjustment (Optimistic/Recession/…): scale every forecast month. */
export function applyForecastAdjustment(values: number[], macroAdjustment: number): number[] {
  if (macroAdjustment === 0) return values
  return values.map((v) => v * (1 + macroAdjustment))
}

export function calculateMAPE(actual: number[], predicted: number[]): number {
  const n = Math.min(actual.length, predicted.length)
  if (n === 0) return 0
  let s = 0
  for (let i = 0; i < n; i++) if (actual[i] !== 0) s += Math.abs((actual[i] - predicted[i]) / actual[i])
  return (s / n) * 100
}

export function calculateRMSE(actual: number[], predicted: number[]): number {
  const n = Math.min(actual.length, predicted.length)
  if (n === 0) return 0
  let sumSq = 0
  for (let i = 0; i < n; i++) sumSq += (actual[i] - predicted[i]) ** 2
  return Math.sqrt(sumSq / n)
}

export function calculateR2(actual: number[], predicted: number[]): number {
  const n = Math.min(actual.length, predicted.length)
  if (n === 0) return 0
  const mean = sum(actual.slice(0, n)) / n
  let ssTot = 0
  let ssRes = 0
  for (let i = 0; i < n; i++) {
    ssTot += (actual[i] - mean) ** 2
    ssRes += (actual[i] - predicted[i]) ** 2
  }
  return ssTot > 0 ? 1 - ssRes / ssTot : 0
}

export function diagnostics(actual: number[], result: ForecastResult): ForecastDiagnostics {
  const fitted = result.fitted.length ? result.fitted : actual
  return {
    mape: calculateMAPE(actual, fitted),
    rmse: calculateRMSE(actual, fitted),
    r2: calculateR2(actual, fitted),
    trendDir: result.trend > 0 ? 'Upward' : result.trend < 0 ? 'Downward' : 'Flat',
    seasonLabel: result.seasonal ? `Detected (${result.seasonalPeriod}mo)` : 'None',
  }
}
