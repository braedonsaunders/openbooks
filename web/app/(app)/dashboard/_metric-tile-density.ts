/**
 * Pack a KPI tile to the cell it was given. Default cells are 112px tall
 * with a 16px radius — the caption has to clear that curve without the
 * grid growing. Stretching the cell scales padding and type; it is never
 * required.
 */
export type MetricTilePack = {
  padX: number
  padTop: number
  padBottom: number
  figure: number
  hintGap: number
  icon: number
  narrow: boolean
  hintLines: 1 | 2
}

const FALLBACK_H = 112
const FALLBACK_W = 256

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function metricTilePack(width: number, height: number): MetricTilePack {
  const h = height > 0 ? height : FALLBACK_H
  const w = width > 0 ? width : FALLBACK_W
  return {
    padX: Math.round(clamp(12, w * 0.05, 20)),
    padTop: Math.round(clamp(8, h * 0.08, 16)),
    // Always ≥20px so 11px type clears the 16px radius at the default size.
    padBottom: Math.round(clamp(20, h * 0.18, 28)),
    figure: Math.round(clamp(22, h * 0.235, 28)),
    hintGap: Math.round(clamp(4, h * 0.05, 10)),
    icon: h < 130 ? 28 : 32,
    narrow: width > 0 && width < 200,
    hintLines: h >= 150 ? 2 : 1,
  }
}

export function packsEqual(a: MetricTilePack, b: MetricTilePack): boolean {
  return (
    a.padX === b.padX &&
    a.padTop === b.padTop &&
    a.padBottom === b.padBottom &&
    a.figure === b.figure &&
    a.hintGap === b.hintGap &&
    a.icon === b.icon &&
    a.narrow === b.narrow &&
    a.hintLines === b.hintLines
  )
}
