/**
 * Shared base-currency refusal for money reports (F1T-11). A missing base
 * currency used to throw a raw English Error out of the project
 * profitability loader — which the app error boundary renders as a
 * generic failure with no name and no remedy — while the budget and
 * trial-balance loaders degraded to an undefined table currency. Every
 * money report refuses the same way instead: a named notice carrying the
 * Company settings link, rendered as an empty-state block, before any
 * expensive query runs. The remedy href is a constant so the three
 * loaders cannot drift to three different settings pages; CompanyTab
 * owns the baseCurrency field at that route.
 */
export const BASE_CURRENCY_SETTINGS_HREF = '/admin/setup/company'

export interface BaseCurrencyNotice {
  code: 'base-currency-not-configured'
  title: string
  description: string
  actionLabel: string
  actionHref: string
}

export function baseCurrencyNotice(copy: {
  title: string
  description: string
  actionLabel: string
}): BaseCurrencyNotice {
  return {
    code: 'base-currency-not-configured',
    title: copy.title,
    description: copy.description,
    actionLabel: copy.actionLabel,
    actionHref: BASE_CURRENCY_SETTINGS_HREF,
  }
}

/** True exactly when the loader may render money: no notice, no silent undefined currency. */
export function hasBaseCurrency(baseCurrency: string | null | undefined): baseCurrency is string {
  return typeof baseCurrency === 'string' && baseCurrency.length > 0
}
