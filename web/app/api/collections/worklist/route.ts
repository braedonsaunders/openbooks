import { NextResponse } from 'next/server'
import { getLocale } from 'next-intl/server'
import { defineRoute } from '@/lib/api/route'
import { can } from '@/lib/authz'
import { arPosition } from '@/lib/cash/ar-position'
import { analyticsConfig } from '@/lib/analytics/config'
import { normalizeMoneyValue } from '@/lib/cash/core'

export const runtime = 'nodejs'

/** Share the AR reader, including its legal-entity scope and exact balances. */
export const GET = defineRoute({
  permission: 'ar.read',
  feature: { none: 'Collections is an always-on receivables workflow governed by ar.read.' },
  handler: async ({ authz }) => {
    const [locale, config] = await Promise.all([getLocale(), analyticsConfig(authz.user.orgId, 'cashflow')])
    const position = await arPosition(authz.user.orgId, 4, {
      weeklyCap: normalizeMoneyValue(String(config.weeklyApCap ?? 0)),
      restrictToSafe: (config.restrictToSafe ?? 0) >= 1,
    }, undefined, authz.allowedSubsidiaryIds, locale)
    return NextResponse.json({
      asOf: position.asOf, overdue: position.overdue, expectedThisWeek: position.expectedThisWeek,
      canCollect: can(authz, 'ar.pay'),
      rows: position.worklist.filter((entry) => entry.docId && entry.docKind === 'customer_invoice').map((entry) => ({
        id: entry.id, docId: entry.docId, docKind: entry.docKind, docNumber: entry.docNumber,
        partyName: entry.partyName, amount: entry.amount, dueDate: entry.dueDate,
        predictedDate: entry.predictedDate, daysOverdue: entry.daysOverdue, method: entry.method,
      })),
    })
  },
})
