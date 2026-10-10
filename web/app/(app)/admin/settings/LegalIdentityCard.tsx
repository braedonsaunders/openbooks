'use client'

import { useMemo } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  FieldLabel,
  Input,
  SearchSelect,
  Select,
} from '@openbooks/ui'
import {
  EMPTY_COMPANY_ADDRESS,
  LEGAL_FORMS,
  taxClassificationsFor,
  taxIdScheme,
  taxIdSchemesFor,
  type CompanyAddress,
  type LegalForm,
  type TaxClassification,
} from '@openbooks/engine/src/organization/company-identity.ts'
import { countryOptions } from '../../../../lib/countries'

/** The company's legal identity as the form edits it. */
export type LegalIdentityValue = {
  address: CompanyAddress
  legalForm: LegalForm | ''
  taxClassification: TaxClassification | ''
  taxIds: Record<string, string>
}

export const EMPTY_ADDRESS: CompanyAddress = { ...EMPTY_COMPANY_ADDRESS }

/**
 * The identifier fields shown for a company in `country`: that
 * jurisdiction's schemes, plus any identifier already on file under another
 * scheme (kept until an operator clears it, never dropped by a save).
 */
export function visibleTaxIdKeys(country: string, stored: Readonly<Record<string, string>>): string[] {
  const own = taxIdSchemesFor(country).map((scheme) => scheme.key)
  return [...own, ...Object.keys(stored).filter((key) => !own.includes(key) && taxIdScheme(key))]
}

/**
 * The settings payload for the legal identity, or the first identifier that
 * is not well formed — checked with the same scheme rules the save enforces,
 * so the operator sees the problem beside the field before submitting.
 */
export function legalIdentityPayload(
  value: LegalIdentityValue,
  country: string,
  stored: Readonly<Record<string, string>>,
): { ok: true; payload: Record<string, unknown> } | { ok: false; invalidScheme: string } {
  const taxIds: Record<string, string | null> = {}
  const own = new Set(taxIdSchemesFor(country).map((scheme) => scheme.key))
  for (const key of visibleTaxIdKeys(country, stored)) {
    const raw = (value.taxIds[key] ?? '').trim()
    if (!raw) {
      taxIds[key] = null
      continue
    }
    // An identifier kept from another jurisdiction travels unchanged.
    if (!own.has(key)) {
      taxIds[key] = raw
      continue
    }
    const canonical = taxIdScheme(key)?.normalize(raw, country)
    if (!canonical) return { ok: false, invalidScheme: key }
    taxIds[key] = canonical
  }
  // The country alone is not an address; an address with no country of its
  // own is in the company's country, as the picker shows it.
  const { country: addressCountry, ...lines } = value.address
  const addressBlank = Object.values(lines).every((part) => !part.trim())
  return {
    ok: true,
    payload: {
      address: addressBlank ? null : { ...value.address, country: addressCountry || country },
      legalForm: value.legalForm || null,
      taxClassification: value.taxClassification || null,
      taxIds,
    },
  }
}

export function LegalIdentityCard({
  value,
  onChange,
  country,
  storedTaxIds,
  invalidScheme,
}: {
  value: LegalIdentityValue
  onChange: (next: LegalIdentityValue) => void
  /** The company's country as the form currently has it. */
  country: string
  storedTaxIds: Readonly<Record<string, string>>
  /** The identifier the last save attempt found malformed, if any. */
  invalidScheme: string | null
}) {
  const t = useTranslations('admin.settings.legalIdentity')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const countries = useMemo(() => countryOptions(locale), [locale])
  const classifications = taxClassificationsFor(value.legalForm || null, country)
  const ownSchemes = new Set(taxIdSchemesFor(country).map((scheme) => scheme.key))
  const setAddress = (field: keyof CompanyAddress, next: string) =>
    onChange({ ...value, address: { ...value.address, [field]: next } })

  const addressField = (field: Exclude<keyof CompanyAddress, 'country'>, span = false) => (
    <div className={span ? 'space-y-1.5 sm:col-span-2' : 'space-y-1.5'}>
      <FieldLabel htmlFor={`company-address-${field}`}>{t(`address.${field}`)}</FieldLabel>
      <Input
        id={`company-address-${field}`}
        value={value.address[field]}
        onChange={(event) => setAddress(field, event.target.value)}
        autoComplete={field === 'line1' ? 'address-line1' : field === 'line2' ? 'address-line2' : field === 'city' ? 'address-level2' : field === 'region' ? 'address-level1' : 'postal-code'}
      />
    </div>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        {addressField('line1', true)}
        {addressField('line2', true)}
        {addressField('city')}
        {addressField('region')}
        {addressField('postalCode')}
        <div className="space-y-1.5">
          <FieldLabel htmlFor="company-address-country">{t('address.country')}</FieldLabel>
          <SearchSelect
            id="company-address-country"
            ariaLabel={t('address.country')}
            value={value.address.country || country}
            onChange={(next) => setAddress('country', (next ?? '').toUpperCase())}
            options={countries}
            placeholder={t('address.countryPlaceholder')}
          />
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="company-legal-form" help={t('legalFormHint')}>{t('legalForm')}</FieldLabel>
          <Select
            id="company-legal-form"
            value={value.legalForm}
            onChange={(event) => {
              const legalForm = event.target.value as LegalForm | ''
              const allowed = taxClassificationsFor(legalForm || null, country)
              onChange({
                ...value,
                legalForm,
                // A structure that cannot elect the current treatment
                // clears it rather than keeping a combination the save refuses.
                taxClassification: value.taxClassification && allowed.includes(value.taxClassification)
                  ? value.taxClassification
                  : allowed.length === 1 ? allowed[0]! : '',
              })
            }}
          >
            <option value="">{tCommon('labels.notSet')}</option>
            {LEGAL_FORMS.map((form) => (
              <option key={form} value={form}>{t(`legalForms.${form}`)}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="company-tax-classification" help={t('taxClassificationHint')}>{t('taxClassification')}</FieldLabel>
          <Select
            id="company-tax-classification"
            value={value.taxClassification}
            onChange={(event) => onChange({ ...value, taxClassification: event.target.value as TaxClassification | '' })}
          >
            <option value="">{tCommon('labels.notSet')}</option>
            {classifications.map((classification) => (
              <option key={classification} value={classification}>{t(`taxClassifications.${classification}`)}</option>
            ))}
          </Select>
        </div>
      </CardContent>
      <CardContent className="space-y-3 pt-0">
        <div>
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">{t('taxIdsTitle')}</p>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t('taxIdsHint')}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {visibleTaxIdKeys(country, storedTaxIds).map((key) => {
            const scheme = taxIdScheme(key)
            const invalid = invalidScheme === key
            return (
              <div key={key} className="space-y-1.5">
                <FieldLabel htmlFor={`company-tax-id-${key}`}>{t(`taxIds.${key}`)}</FieldLabel>
                <Input
                  id={`company-tax-id-${key}`}
                  value={value.taxIds[key] ?? ''}
                  onChange={(event) => onChange({ ...value, taxIds: { ...value.taxIds, [key]: event.target.value } })}
                  placeholder={scheme?.example || undefined}
                  aria-invalid={invalid || undefined}
                  aria-describedby={invalid ? `company-tax-id-${key}-error` : undefined}
                />
                {invalid ? (
                  <p id={`company-tax-id-${key}-error`} role="alert" className="text-xs text-red-600 dark:text-red-400">
                    {scheme?.example ? t('taxIdInvalidExample', { example: scheme.example }) : t('taxIdInvalid')}
                  </p>
                ) : !ownSchemes.has(key) ? (
                  <p className="text-xs text-amber-700 dark:text-amber-400">{t('otherJurisdiction')}</p>
                ) : null}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
