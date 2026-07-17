/** Client-safe exact decimal helpers for the editable budget worksheet. */
const SCALE = 10_000n

export function budgetToUnits(value: string): bigint {
  const raw = value.trim()
  if (!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) throw new Error('invalid_decimal')
  const negative = raw.startsWith('-')
  const unsigned = raw.replace(/^[-+]/, '')
  const [whole = '0', fraction = ''] = unsigned.split('.')
  if (fraction.length > 4 && /[1-9]/.test(fraction.slice(4))) throw new Error('too_many_decimals')
  const units = BigInt(whole || '0') * SCALE + BigInt((fraction + '0000').slice(0, 4))
  return negative ? -units : units
}
export function budgetFromUnits(units: bigint): string {
  const negative = units < 0n
  const absolute = negative ? -units : units
  return `${negative ? '-' : ''}${absolute / SCALE}.${(absolute % SCALE).toString().padStart(4, '0')}`
}

/** Split a total exactly across N periods; the earliest periods receive the remainder. */
export function spreadBudgetTotal(total: string, periods: number): string[] {
  if (!Number.isInteger(periods) || periods <= 0) throw new Error('invalid_period_count')
  const units = budgetToUnits(total)
  const count = BigInt(periods)
  const base = units / count
  let remainder = units % count
  return Array.from({ length: periods }, () => {
    let value = base
    if (remainder > 0n) {
      value += 1n
      remainder -= 1n
    } else if (remainder < 0n) {
      value -= 1n
      remainder += 1n
    }
    return budgetFromUnits(value)
  })
}

/** Apply an exact percentage uplift, rounded half away from zero to 4 decimals. */
export function upliftBudgetAmount(amount: string, percent: string): string {
  const amountUnits = budgetToUnits(amount)
  const percentUnits = budgetToUnits(percent)
  const multiplier = 100n * SCALE + percentUnits
  const denominator = 100n * SCALE
  const product = amountUnits * multiplier
  const negative = product < 0n
  const absolute = negative ? -product : product
  const rounded = (absolute + denominator / 2n) / denominator
  return budgetFromUnits(negative ? -rounded : rounded)
}
