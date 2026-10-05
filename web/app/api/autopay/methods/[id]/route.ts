import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  AutopayError,
  removeMethod,
  setDefaultMethod,
} from '@openbooks/engine/payments/autopay'
import { defineRoute } from '@/lib/api/route'
import { isUuid } from '@/lib/list-params'

export const runtime = 'nodejs'

const patchBody = z.object({ isDefault: z.literal(true) })

/** Make a method the default charge target. */
export const PATCH = defineRoute({
  permission: 'payment_methods.manage',
  feature: 'autopay',
  body: patchBody,
  handler: async ({ authz, params: routeParams }) => {
    const { id } = (routeParams ?? {}) as { id?: string }
    if (!id || !isUuid(id)) return NextResponse.json({ error: 'method id is required' }, { status: 400 })
    try {
      await setDefaultMethod(authz.user.orgId, id, authz.user.id)
      return NextResponse.json({ ok: true })
    } catch (e) {
      if (e instanceof AutopayError) return apiErrorResponse(e, { safeStatus: 422 })
      throw e
    }
  },
})

/** Remove a stored method (detached at the provider first). */
export const DELETE = defineRoute({
  permission: 'payment_methods.manage',
  feature: 'autopay',
  handler: async ({ authz, params: routeParams }) => {
    const { id } = (routeParams ?? {}) as { id?: string }
    if (!id || !isUuid(id)) return NextResponse.json({ error: 'method id is required' }, { status: 400 })
    try {
      await removeMethod(authz.user.orgId, id, authz.user.id)
      return NextResponse.json({ ok: true })
    } catch (e) {
      if (e instanceof AutopayError) return apiErrorResponse(e, { safeStatus: 422 })
      throw e
    }
  },
})
