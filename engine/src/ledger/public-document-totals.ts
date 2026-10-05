/** Supported document tax-totals and numbering contract for application adapters. */
export {
  computeBillTotals,
  computeBillTotalsWithProvider,
  nextDocumentNumber,
  persistLineTaxComponents,
  taxProfileMap,
  type ProviderBillTotalsOptions,
  type TaxProfiles,
} from './document-totals.ts'
export type { TaxComponentConfig } from '../tax/tax.ts'
