import type {
  ReportFormulaExpr,
  ReportMeasure,
} from './types'

export const DEFAULT_UNDEFINED_FORMULA_LABEL = 'Undefined — divides by zero'

type Rational = { numerator: bigint; denominator: bigint }
export type FormulaValue = { value: string | null; undefinedLabel: string | null }

function abs(value: bigint): bigint {
  return value < 0n ? -value : value
}

function gcd(left: bigint, right: bigint): bigint {
  let a = abs(left)
  let b = abs(right)
  while (b !== 0n) [a, b] = [b, a % b]
  return a || 1n
}

function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new Error('A rational denominator cannot be zero')
  const sign = denominator < 0n ? -1n : 1n
  const divisor = gcd(numerator, denominator)
  return { numerator: (numerator / divisor) * sign, denominator: abs(denominator / divisor) }
}

function decimal(value: unknown): Rational | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' && typeof value !== 'bigint') return null
  const text = String(value)
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!match) return null
  const fraction = match[3] ?? ''
  const denominator = 10n ** BigInt(fraction.length)
  const digits = BigInt(`${match[2]}${fraction}`)
  return rational(match[1] === '-' ? -digits : digits, denominator)
}

function add(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator)
}

function subtract(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator)
}

function multiply(a: Rational, b: Rational): Rational {
  return rational(a.numerator * b.numerator, a.denominator * b.denominator)
}

function divide(a: Rational, b: Rational): Rational | null {
  return b.numerator === 0n ? null : rational(a.numerator * b.denominator, a.denominator * b.numerator)
}

function equalZero(value: Rational | null): boolean {
  return value !== null && value.numerator === 0n
}

function scaleFor(measure: ReportMeasure): number {
  if (measure.scale !== undefined) return measure.scale
  switch (measure.format) {
    case 'ratio': return 4
    case 'percent': return 2
    case 'money': return 4
    default: return 4
  }
}

/** Round a rational to a fixed decimal scale using half away from zero. */
function roundedDecimal(value: Rational, scale: number): string {
  const factor = 10n ** BigInt(scale)
  const scaledNumerator = value.numerator * factor
  const negative = scaledNumerator < 0n
  const magnitude = abs(scaledNumerator)
  let quotient = magnitude / value.denominator
  const remainder = magnitude % value.denominator
  if (remainder * 2n >= value.denominator) quotient += 1n
  const whole = quotient / factor
  const fraction = String(quotient % factor).padStart(scale, '0')
  return `${negative && quotient !== 0n ? '-' : ''}${whole}${scale ? `.${fraction}` : ''}`
}

function expressionValue(
  expr: ReportFormulaExpr,
  resolve: (key: string) => Rational | null,
): Rational | null {
  if ('ref' in expr) return resolve(expr.ref)
  if ('const' in expr) return decimal(expr.const)
  const left = expressionValue(expr.left, resolve)
  const right = expressionValue(expr.right, resolve)
  if (!left || !right) return null
  switch (expr.op) {
    case '+': return add(left, right)
    case '-': return subtract(left, right)
    case '*': return multiply(left, right)
    case '/': return divide(left, right)
  }
}

/** Evaluate formula measures from the unformatted aggregate values in m0…mN.
 *  References to another formula retain its exact rational value until each
 *  formula's own output is rounded for display. */
export function evaluateFormulaMeasures(
  measures: readonly ReportMeasure[],
  aggregateValues: readonly unknown[],
  notTotalled: ReadonlySet<string> = new Set(),
  labels: { undefined?: string; notTotalled?: string } = {},
): FormulaValue[] {
  const keyToIndex = new Map<string, number>()
  for (const [index, measure] of measures.entries()) {
    if (measure.key) keyToIndex.set(measure.key, index)
  }
  const exact = new Map<number, Rational | null>()
  const results = new Map<number, FormulaValue>()
  const active = new Set<number>()

  const resolve = (key: string): Rational | null => {
    const index = keyToIndex.get(key)
    if (index === undefined) return null
    return evaluate(index)
  }

  const evaluate = (index: number): Rational | null => {
    if (exact.has(index)) return exact.get(index) ?? null
    if (active.has(index)) return null
    const measure = measures[index]!
    if (measure.fn !== 'formula') {
      const raw = aggregateValues[index]
      if ((measure.fn === 'count' || measure.fn === 'count_distinct') && typeof raw === 'number') {
        return Number.isSafeInteger(raw) ? decimal(String(raw)) : null
      }
      return decimal(raw)
    }
    active.add(index)

    let undefinedLabel: string | null = null
    for (const guard of measure.guards ?? []) {
      const guardedIndex = keyToIndex.get(guard.measure)
      if (guardedIndex === undefined) continue
      const guardedValue = evaluate(guardedIndex)
      if ((guard.when === 'null' && guardedValue === null)
        || (guard.when === 'zero' && equalZero(guardedValue))) {
        undefinedLabel = guard.label
        break
      }
    }

    let value: Rational | null = null
    if (!undefinedLabel && !notTotalled.has(measure.key ?? `#${index}`) && measure.expr) {
      value = expressionValue(measure.expr, resolve)
      if (value === null) undefinedLabel = measure.undefinedLabel ?? labels.undefined ?? DEFAULT_UNDEFINED_FORMULA_LABEL
    } else if (!undefinedLabel && notTotalled.has(measure.key ?? `#${index}`)) {
      undefinedLabel = labels.notTotalled ?? 'Not totalled'
    }

    active.delete(index)
    exact.set(index, value)
    results.set(index, {
      value: value === null ? null : roundedDecimal(
        measure.format === 'percent' ? multiply(value, rational(100n, 1n)) : value,
        scaleFor(measure),
      ),
      undefinedLabel,
    })
    return value
  }

  return measures.map((measure, index) => {
    if (measure.fn !== 'formula') return { value: null, undefinedLabel: null }
    evaluate(index)
    return results.get(index) ?? { value: null, undefinedLabel: measure.undefinedLabel ?? labels.undefined ?? DEFAULT_UNDEFINED_FORMULA_LABEL }
  })
}
