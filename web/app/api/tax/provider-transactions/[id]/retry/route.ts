import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import {
  TaxProviderCommitError,
  retryProviderTransaction,
} from '@openbooks/engine/tax'
import { defineRoute } from '@/lib/api/route'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

/**
 * Operator retry for a terminally failed provider commit: re-arms the row so
 * the periodic scan commits it again. Only failed rows retry — committed,
 * voided and pending rows refuse by name.
 */
export const POST = defineRoute({
  permission: 'compliance.file',
  feature: { none: 'This route is governed by its permission and service authorization.' },
  handler: async ({ authz, params: routeParams }) => {
    const { id } = (routeParams ?? {}) as { id?: string }
    if (!id || !isUuid(id)) return NextResponse.json({ error: 'provider transaction id is required' }, { status: 400 })
    try {
      await retryProviderTransaction(authz.user.orgId, id, authz.user.id)
      return NextResponse.json({ ok: true })
    } catch (e) {
      if (e instanceof TaxProviderCommitError) return apiErrorResponse(e, { safeStatus: 422 })
      throw e
    }
  },
})
