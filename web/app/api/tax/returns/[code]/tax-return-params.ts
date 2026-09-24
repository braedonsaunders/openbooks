import { decimalNullRefusal } from '../../../../../lib/payroll-decimal-refusal'

const AMOUNT_RE = /^-?\d+(\.\d+)?$/

/** An `adj_<lineCode>` query param the server cannot read as an amount. */
export class AdjustmentParamError extends Error {
  readonly param: string
  constructor(param: string, message: string) {
    super(message)
    this.name = 'AdjustmentParamError'
    this.param = param
  }
}

/**
 * Adjustment-box amounts arrive as `adj_<lineCode>=<amount>` query params.
 * Every `adj_` key is validated: an unreadable amount is refused by name
 * (naming the parameter, with the shared decimal remedy) instead of being
 * skipped silently — a skipped key used to compute the box as 0.0000.
 */
export function parseAdjustments(params: URLSearchParams): Record<string, string> {
  const adjustments: Record<string, string> = {}
  for (const [key, value] of params) {
    if (!key.startsWith('adj_')) continue
    const lineCode = key.slice(4)
    if (!AMOUNT_RE.test(value)) {
      throw new AdjustmentParamError(
        key,
        decimalNullRefusal(`adjustment ${lineCode}`, 'an amount', value, 4),
      )
    }
    adjustments[lineCode] = value
  }
  return adjustments
}
