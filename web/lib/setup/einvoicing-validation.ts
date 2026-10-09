import 'server-only'
import { paymentAccountRefusal, paymentProviderRefusal } from '@openbooks/engine/einvoice/bank'
import { sql } from 'drizzle-orm'
import { isEInvoiceProfileKey } from '@openbooks/engine/einvoice/profiles'
import { isKnownEasScheme, isKnownPaymentMeansCode, isKnownVatexCode, isVatCategory } from '@openbooks/engine/einvoice/codes'
import { isIsoDate } from '@openbooks/engine/einvoice/dates'
import type { SetupEntityValidationHook } from './types'
import { toSnake } from './registry'

/** Validate configuration candidates without deriving missing fiscal identity. */
export const validateEInvoiceSetupWrite: SetupEntityValidationHook = async ({ entity, orgId, body, rowId, executor }) => {
  const current = rowId
    ? (await executor.execute<Record<string, unknown>>(sql`
        select * ${entity.key === 'tax-codes' ? sql`,einvoice_effective_from::text as einvoice_effective_from` : sql``}
        from ${sql.raw(entity.table)} where org_id=${orgId} and id=${rowId} for update`)).rows[0]
    : null
  if (rowId && !current) return 'not found'
  const value = (key: string): unknown => body[key] === undefined ? current?.[toSnake(key)] ?? null : body[key]
  const str = (key: string): string | null => {
    const raw = value(key)
    return raw == null || raw === '' ? null : typeof raw === 'string' ? raw.trim() : null
  }
  const lengths: Record<string, number> = {
    addressLine1: 200, addressLine2: 200, city: 100, postcode: 20, subdivision: 100,
    tradingName: 200, legalRegistrationId: 100, taxNumber: 50,
    contactName: 200, contactPhone: 50, contactEmail: 320, electronicAddress: 200,
    payeeAccountId: 64, payeeAccountName: 200, untaxedExemptionReason: 1000,
    einvoiceAddress: 200, einvoiceBuyerReference: 200, einvoiceLegalRegistrationId: 100,
    einvoiceExemptionReason: 1000,
  }
  for (const field of entity.fields.filter(field => ['text', 'textarea', 'select'].includes(field.kind))) {
    const raw = value(field.key)
    if (raw != null && typeof raw !== 'string') return `${field.key} must be text.`
  }
  for (const [key, max] of Object.entries(lengths)) {
    const raw = value(key)
    if (raw != null && raw !== '' && (typeof raw !== 'string' || !raw.trim() || raw.trim().length > max)) {
      return `${key} must contain between 1 and ${max} characters.`
    }
  }
  const recipient = entity.key === 'einvoice-recipients'
  const seller = entity.key === 'einvoice-settings'
  if (seller || recipient) {
    const profile = str(seller ? 'defaultProfile' : 'einvoiceProfile')
    if ((seller && !profile) || (profile && !isEInvoiceProfileKey(profile))) return 'Choose a supported e-invoice profile.'
    const address = str(seller ? 'electronicAddress' : 'einvoiceAddress')
    const scheme = str(seller ? 'electronicAddressScheme' : 'einvoiceAddressScheme')
    if (!!address !== !!scheme) return 'Supply both the electronic address and its identifier scheme, or clear both.'
    if (scheme && !isKnownEasScheme(scheme)) return 'Choose a supported electronic address scheme.'
    const registration = str(seller ? 'legalRegistrationId' : 'einvoiceLegalRegistrationId')
    const registrationScheme = str(seller ? 'legalRegistrationScheme' : 'einvoiceLegalRegistrationScheme')
    if (registrationScheme && (!registration || !/^\d{4}$/.test(registrationScheme))) return 'A legal registration scheme needs a registration identifier and a four-digit ICD scheme.'
  }
  if (recipient) {
    const partyId = str('partyId')
    if (!partyId || (current && partyId !== String(current.party_id))) return 'Edit e-invoice metadata on the existing customer role; the customer identity cannot change.'
    const customer = (await executor.execute(sql`
      select p.id from parties p join customer_roles c on c.org_id=p.org_id and c.party_id=p.id
      where p.org_id=${orgId} and p.id=${partyId} and c.id=${rowId ?? null} for share of p`)).rows[0]
    if (!customer) return 'The customer role is not available in this organization.'
  }
  if (seller) {
    const subsidiaryId = str('subsidiaryId')
    if (!subsidiaryId) return 'Choose the invoicing legal entity.'
    if (current && subsidiaryId !== String(current.subsidiary_id)) return 'The invoicing legal entity cannot change. Create settings for the other entity.'
    const subsidiary = (await executor.execute(sql`
      select id from subsidiaries where org_id=${orgId} and id=${subsidiaryId} and is_active and not is_elimination for share`)).rows[0]
    if (!subsidiary) return 'Choose an active invoicing legal entity in this organization.'
    const duplicate = (await executor.execute(sql`
      select id from einvoice_settings where org_id=${orgId} and subsidiary_id=${subsidiaryId}
      ${rowId ? sql`and id<>${rowId}` : sql``}`)).rows[0]
    if (duplicate) return 'This legal entity already has e-invoice settings. Edit that record.'
    if (Object.hasOwn(body, 'paymentMeansCode') && !str('paymentMeansCode')) return 'Choose a supported payment means code.'
    if (!isKnownPaymentMeansCode(str('paymentMeansCode') ?? '30')) return 'Choose a supported payment means code.'
    if (str('contactEmail') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str('contactEmail')!)) return 'Enter a valid seller contact email address.'
    if (str('payeeAccountId')) { const refusal = paymentAccountRefusal(str('payeeAccountId')!, str('paymentMeansCode') ?? '30'); if (refusal) return refusal }
    if (str('payeeBic')) { const refusal = paymentProviderRefusal(str('payeeBic')!); if (refusal) return refusal }
  }
  const category = str(seller ? 'untaxedLineCategory' : 'einvoiceCategory')
  const reason = str(seller ? 'untaxedExemptionReason' : 'einvoiceExemptionReason')
  const reasonCode = str(seller ? 'untaxedExemptionReasonCode' : 'einvoiceExemptionReasonCode')
  if (seller || entity.key === 'tax-codes') {
    if (category && (!isVatCategory(category) || (seller && !['Z', 'E', 'O'].includes(category)))) return 'Choose a supported VAT category.'
    if ((reason || reasonCode) && (!category || !['E', 'AE', 'K', 'G', 'O'].includes(category))) return 'Exemption reasons apply only to exempt, reverse-charge, intra-community, export or outside-scope VAT categories.'
    if (reasonCode && !isKnownVatexCode(reasonCode)) return 'Enter a supported VATEX exemption reason code, or supply the statutory exemption wording.'
    if (!seller && category && (!str('einvoiceEffectiveFrom') || !isIsoDate(str('einvoiceEffectiveFrom')!))) return 'Set a valid effective date of this e-invoice VAT treatment. Earlier posted invoices retain their prior treatment.'
    if (!seller && category && str('calculationType') === 'withholding') return 'Withholding taxes do not represent an EN 16931 VAT category. Configure e-invoice categories on VAT codes.'
    if (!seller && category === 'AE' && str('calculationType') !== 'reverse_charge') return 'Use the native reverse-charge calculation type for a reverse-charge e-invoice category.'
    if (!seller && str('jurisdictionId') && str('country')) {
      const jurisdiction = (await executor.execute<{ country: string }>(sql`select country from tax_jurisdictions where org_id=${orgId} and id=${str('jurisdictionId')} for share`)).rows[0]
      if (!jurisdiction || jurisdiction.country !== str('country')) return 'Choose a tax jurisdiction in the tax code’s configured country.'
    }
    if (!seller && rowId && current?.einvoice_category && ['einvoiceCategory', 'einvoiceEffectiveFrom', 'einvoiceExemptionReason', 'einvoiceExemptionReasonCode']
      .some(key => Object.hasOwn(body, key) && str(key) !== (current[toSnake(key)] == null ? null : String(current[toSnake(key)])))) {
      const posted = (await executor.execute(sql`
        select d.id from document_lines l join documents d on d.org_id=l.org_id and d.id=l.document_id
        where l.org_id=${orgId} and d.status='posted' and (l.tax_code_id=${rowId} or exists (
          select 1 from document_line_tax_components c where c.org_id=l.org_id and c.document_line_id=l.id and c.tax_code_id=${rowId}))
        limit 1`)).rows[0]
      if (posted) return 'This e-invoice VAT treatment is used by posted documents. Create a new tax code with effective-dated rates for changes; issued originals remain preserved.'
    }
  }
  return null
}
