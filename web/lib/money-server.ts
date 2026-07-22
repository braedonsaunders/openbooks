import 'server-only'

import { cache } from 'react'
import { resolveLocale } from './locale'
import { orgInfo } from './data'
import { createMoneyFormatter, type MoneyFormatter } from './money-format'

/** Request-scoped server formatter using the same locale and org currency as the UI. */
export const getMoneyFormatter = cache(async function getMoneyFormatter(
  orgId?: string,
  currency?: string,
): Promise<MoneyFormatter> {
  const [locale, org] = await Promise.all([resolveLocale(), currency ? null : orgInfo(orgId)])
  const resolvedCurrency = currency ?? org?.base_currency
  if (!resolvedCurrency) throw new Error('Cannot format money without an organization currency')
  return createMoneyFormatter(locale, resolvedCurrency)
})
