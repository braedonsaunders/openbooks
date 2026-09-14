import { decimalCmp, decimalNeg, decimalSum } from '../../../lib/statement-format'

/** Total the visible legs independently: subsidiary scope may show only one side. */
export function entryTotals(lines: readonly { amount: string }[]) {
  return {
    debit: decimalSum(lines.filter((line) => decimalCmp(line.amount, '0') > 0).map((line) => line.amount)),
    credit: decimalNeg(decimalSum(lines.filter((line) => decimalCmp(line.amount, '0') < 0).map((line) => line.amount))),
  }
}
