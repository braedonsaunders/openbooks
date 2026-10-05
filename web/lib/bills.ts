import 'server-only'
import { taxProfileMap as engineTaxProfileMap, type TaxProfiles } from '@openbooks/engine/documents/totals'
import { resolveOrgId } from './org-scope'

export {
  computeBillTotals,
  computeBillTotalsWithProvider,
  nextDocumentNumber,
  persistLineTaxComponents,
  type ProviderBillTotalsOptions,
  type TaxProfiles,
} from '@openbooks/engine/documents/totals'

/** Effective, ordered tax profiles for a transaction date; defaults to the request's organization. */
export async function taxProfileMap(orgId?: string, asOfDate?: string): Promise<TaxProfiles> {
  return engineTaxProfileMap(await resolveOrgId(orgId), asOfDate)
}
