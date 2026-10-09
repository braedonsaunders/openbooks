import { EINVOICE_PROFILES } from '@openbooks/engine/einvoice/profiles'
import { EAS_LABELS, PAYMENT_MEANS_LABELS, VAT_CATEGORIES } from '@openbooks/engine/einvoice/codes'
import type { SetupEntity, SetupField, SetupOption } from '../types'

const profiles: SetupOption[] = Object.values(EINVOICE_PROFILES).map(profile => ({ value: profile.key, label: profile.label }))
const schemes: SetupOption[] = Object.entries(EAS_LABELS).map(([value, label]) => ({ value, label: `${value} · ${label}` }))
const vat: SetupOption[] = VAT_CATEGORIES.map(({ code }) => ({ value: code, labelKey: `einvoice.vat.${code}` }))

export const EINVOICE_TAX_FIELDS: SetupField[] = [
  { key: 'einvoiceCategory', kind: 'select', options: vat, featureKey: 'einvoicing', labelKey: 'einvoice.vatCategory', sectionKey: 'einvoice.identity' },
  { key: 'einvoiceEffectiveFrom', kind: 'date', featureKey: 'einvoicing', labelKey: 'einvoice.effectiveFrom', helpTextKey: 'einvoice.effectiveFromHelp' },
  { key: 'einvoiceExemptionReasonCode', kind: 'text', featureKey: 'einvoicing', labelKey: 'einvoice.exemptionReasonCode' },
  { key: 'einvoiceExemptionReason', kind: 'textarea', featureKey: 'einvoicing', labelKey: 'einvoice.exemptionReason' },
]

/** Metadata on native legal entities, customer roles and tax codes. */
export const EINVOICING_ENTITIES: SetupEntity[] = [
  {
    key: 'einvoice-settings', table: 'einvoice_settings', actorCols: true,
    groupKey: 'billing', iconKey: 'file', orgScoped: true, hasActive: false,
    featureKey: 'einvoicing', writePermission: 'documents.manage', allowDelete: false,
    orderBy: 'subsidiary_id', formDescriptionKey: 'einvoice.sellerHelp',
    columns: [
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries' },
      { key: 'defaultProfile', kind: 'text', options: profiles, labelKey: 'einvoice.defaultProfile' },
      { key: 'electronicAddress', kind: 'text', labelKey: 'einvoice.electronicAddress' },
    ],
    formSections: [
      { titleKey: 'einvoice.identity', fields: ['subsidiaryId', 'defaultProfile', 'tradingName', 'legalRegistrationId', 'legalRegistrationScheme', 'taxNumber'] },
      { titleKey: 'einvoice.address', fields: ['addressLine1', 'addressLine2', 'city', 'postcode', 'subdivision'] },
      { titleKey: 'einvoice.contact', fields: ['contactName', 'contactPhone', 'contactEmail', 'electronicAddress', 'electronicAddressScheme'] },
      { titleKey: 'einvoice.payment', fields: ['paymentMeansCode', 'payeeAccountId', 'payeeAccountName', 'payeeBic'] },
      { titleKey: 'einvoice.untaxed', fields: ['untaxedLineCategory', 'untaxedExemptionReasonCode', 'untaxedExemptionReason'] },
    ],
    fields: [
      { key: 'subsidiaryId', kind: 'ref', ref: 'subsidiaries', required: true, lockedOnEdit: true, legalEmployer: true },
      { key: 'defaultProfile', kind: 'select', options: profiles, required: true, labelKey: 'einvoice.defaultProfile' },
      ...['tradingName', 'legalRegistrationId', 'legalRegistrationScheme', 'taxNumber', 'addressLine1', 'addressLine2', 'city', 'postcode', 'subdivision', 'contactName', 'contactPhone', 'contactEmail', 'electronicAddress'].map(key => ({ key, kind: 'text' as const, labelKey: `einvoice.${key}` })),
      { key: 'electronicAddressScheme', kind: 'select', options: schemes, labelKey: 'einvoice.electronicAddressScheme' },
      { key: 'paymentMeansCode', kind: 'select', required: true, defaultValue: '30', options: Object.entries(PAYMENT_MEANS_LABELS).map(([value, label]) => ({ value, label: `${value} · ${label}` })), labelKey: 'einvoice.paymentMeansCode' },
      ...['payeeAccountId', 'payeeAccountName', 'payeeBic'].map(key => ({ key, kind: 'text' as const, labelKey: `einvoice.${key}` })),
      { key: 'untaxedLineCategory', kind: 'select', options: vat.filter(option => ['Z', 'E', 'O'].includes(option.value)), labelKey: 'einvoice.untaxedLineCategory', helpTextKey: 'einvoice.untaxedHelp' },
      { key: 'untaxedExemptionReasonCode', kind: 'text', labelKey: 'einvoice.exemptionReasonCode' },
      { key: 'untaxedExemptionReason', kind: 'textarea', labelKey: 'einvoice.exemptionReason' },
    ],
  },
  {
    key: 'einvoice-recipients', table: 'customer_roles', actorCols: true,
    groupKey: 'billing', iconKey: 'users', orgScoped: true, hasActive: true,
    featureKey: 'einvoicing', writePermission: 'parties.manage', allowCreate: false, allowDelete: false,
    orderBy: 'party_id', formDescriptionKey: 'einvoice.recipientHelp',
    columns: [
      { key: 'partyId', kind: 'ref', ref: 'einvoice-customers' },
      { key: 'einvoiceProfile', kind: 'text', options: profiles, labelKey: 'einvoice.defaultProfile' },
      { key: 'einvoiceAddress', kind: 'text', labelKey: 'einvoice.electronicAddress' },
    ],
    fields: [
      { key: 'partyId', kind: 'ref', ref: 'einvoice-customers', required: true, lockedOnEdit: true },
      { key: 'einvoiceProfile', kind: 'select', options: profiles, labelKey: 'einvoice.defaultProfile' },
      { key: 'einvoiceAddress', kind: 'text', labelKey: 'einvoice.electronicAddress' },
      { key: 'einvoiceAddressScheme', kind: 'select', options: schemes, labelKey: 'einvoice.electronicAddressScheme' },
      { key: 'einvoiceBuyerReference', kind: 'text', labelKey: 'einvoice.buyerReference' },
      { key: 'einvoiceLegalRegistrationId', kind: 'text', labelKey: 'einvoice.legalRegistrationId' },
      { key: 'einvoiceLegalRegistrationScheme', kind: 'text', labelKey: 'einvoice.legalRegistrationScheme' },
    ],
  },
]
