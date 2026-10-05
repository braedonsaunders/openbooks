import { z } from 'zod'
import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { apiErrorResponse } from '@/lib/api/error-response'
import { ANALYTICS_DASHBOARD_MAP } from '@/lib/analytics/dashboard-catalog'
import { analyticsDashboardAvailable } from '@/lib/analytics/dashboard-access'
import { RATIO_INPUT_KEYS } from '@/lib/analytics/financial-health'
import { RatioInputError, loadRatioInputs, saveRatioInput } from '@/lib/analytics/ratio-inputs'

export const runtime = 'nodejs'

/**
 * The organization's ratio-input classifications (interest expense,
 * interest-bearing debt). Readable by anyone who can open Financial Health;
 * editable with the Setup permission over the whole company, because one
 * classification serves every subsidiary's ratios.
 */
const body = z.strictObject({
  key: z.enum(RATIO_INPUT_KEYS),
  accountIds: z.array(z.string().uuid()).max(500),
})

export const GET = defineRoute({
  permission: 'reports.read',
  feature: { none: 'Governed by the Financial Health dashboard: reports.read.' },
  handler: async ({ authz }) => {
    if (!(await analyticsDashboardAvailable(authz, ANALYTICS_DASHBOARD_MAP['financial-health']!))) return notFound('record')
    return NextResponse.json({ inputs: await loadRatioInputs(authz.user.orgId) })
  },
})

export const PUT = defineRoute({
  permission: 'admin.setup.manage',
  feature: { none: 'Governed by admin.setup.manage over the whole company.' },
  scope: 'unrestricted',
  body,
  handler: async ({ authz, body: input }) => {
    if (!(await analyticsDashboardAvailable(authz, ANALYTICS_DASHBOARD_MAP['financial-health']!))) return notFound('record')
    const t = await getTranslations('analytics.financialHealth.ratioInputs')
    try {
      const accounts = await saveRatioInput(authz.user.orgId, authz.user.id, input.key, input.accountIds, t(`${input.key}.title`))
      return NextResponse.json({ ok: true, accounts })
    } catch (error) {
      if (error instanceof RatioInputError) return apiErrorResponse(error, { safeStatus: 422 })
      throw error
    }
  },
})
