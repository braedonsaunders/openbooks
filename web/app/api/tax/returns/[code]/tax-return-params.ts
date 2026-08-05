const AMOUNT_RE = /^-?\d+(\.\d+)?$/

/** Adjustment-box amounts arrive as `adj_<lineCode>=<amount>` query params. */
export function parseAdjustments(params: URLSearchParams): Record<string, string> {
  const adjustments: Record<string, string> = {}
  for (const [key, value] of params) {
    if (!key.startsWith('adj_')) continue
    if (AMOUNT_RE.test(value)) adjustments[key.slice(4)] = value
  }
  return adjustments
}
