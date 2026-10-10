import {
  formatCompanyAddress,
  formatTaxIds,
  readCompanyAddress,
  readTaxIds,
} from '@openbooks/engine/src/organization/company-identity.ts'

/** The organization columns every PDF loader reads for its seller block. */
export type OrgIdentityRow = {
  name: string
  legal_name?: string | null
  tax_ids?: unknown
  company_address?: unknown
}

/** Identifier schemes that are a VAT number or a company registration. */
const VAT_SCHEMES = ['gb_vat', 'eu_vat'] as const
const REGISTRATION_SCHEMES = ['gb_crn', 'registration'] as const

/**
 * The seller block's merge values — the same on every record type, from the
 * Company & Accounting legal identity. Every key is always present (empty
 * when not recorded) so a template never prints a raw tag.
 *
 * The fiscal seller fields (`seller_*`) carry the same identity for invoice
 * layouts; an e-invoice replaces them with the values of its embedded
 * invoice, so the printed and the electronic seller can never disagree.
 */
export function orgIdentityMergeValues(org: OrgIdentityRow): Record<string, string> {
  const address = formatCompanyAddress(readCompanyAddress(org.company_address))
  const taxIds = readTaxIds(org.tax_ids)
  const pick = (schemes: readonly string[]) => schemes.map((scheme) => taxIds[scheme]).find(Boolean) ?? ''
  const otherTaxNumbers = Object.fromEntries(
    Object.entries(taxIds).filter(([scheme]) =>
      !(VAT_SCHEMES as readonly string[]).includes(scheme) && !(REGISTRATION_SCHEMES as readonly string[]).includes(scheme)),
  )
  return {
    org_name: org.name,
    org_legal_name: org.legal_name?.trim() || org.name,
    org_address: address,
    org_tax_ids: formatTaxIds(taxIds),
    seller_address: address,
    seller_vat_id: pick(VAT_SCHEMES),
    seller_tax_number: formatTaxIds(otherTaxNumbers),
    seller_legal_registration: pick(REGISTRATION_SCHEMES),
  }
}
