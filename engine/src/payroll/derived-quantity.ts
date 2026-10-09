import { canonicalDecimal } from '../money/exact-decimal.ts';
import { cmp } from '../money/money.ts';
import { PayrollError } from './error.ts';

/** Operational quantities remain separate from insured and benefit-counted hours. */
export function requireDerivedQuantityEvidence(line: {
  kind: string; hours?: string | null; derivedQuantity?: string | null; derivedRuleCode?: string | null;
}): void {
  if (line.derivedQuantity == null && line.derivedRuleCode == null) return;
  const quantity = line.derivedQuantity;
  const code = line.derivedRuleCode;
  if (typeof quantity !== 'string' || canonicalDecimal(quantity, 4) === null || cmp(quantity, '0') <= 0 ||
      quantity.replace(/^0+/, '').split('.')[0]!.length > 20 ||
      typeof code !== 'string' || !code.trim() || code !== code.trim() ||
      line.kind !== 'earning' || line.hours != null) {
    throw new PayrollError('Derived earning evidence requires a positive exact quantity, its rule code and no additional worked hours.');
  }
}
