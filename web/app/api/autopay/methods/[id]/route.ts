import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  AutopayError,
  removeMethod,
  setDefaultMethod,
  setMethodFallbackPriority,
} from '@openbooks/engine/payments/autopay'
import { defineRoute } from '@/lib/api/route'
import { isUuid } from '@/lib/list-params'
import { guardPaymentMethodScope } from '@/lib/autopay-scope'

export const runtime = 'nodejs'

const patchBody = z.union([
  z.object({ isDefault: z.literal(true) }),
  z.object({ fallbackPriority: z.number().int().min(0).max(999) }),
])

/** Make a method the default charge target, or order it in the backup chain. */
export const PATCH = defineRoute({
  permission: 'payment_methods.manage',
  feature: 'autopay',
  body: patchBody,
  handler: async ({ authz, body, params: routeParams }) => {
    const { id } = (routeParams ?? {}) as { id?: string }
    if (!id || !isUuid(id)) return NextResponse.json({ error: 'method id is required' }, { status: 400 })
    const outOfScope = await guardPaymentMethodScope(authz, id)
    if (outOfScope) return outOfScope
    try {
      if ('fallbackPriority' in body) {
        await setMethodFallbackPriority(authz.user.orgId, id, body.fallbackPriority, authz.user.id)
      } else {
        await setDefaultMethod(authz.user.orgId, id, authz.user.id)
      }
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
    const outOfScope = await guardPaymentMethodScope(authz, id)
    if (outOfScope) return outOfScope
    try {
      await removeMethod(authz.user.orgId, id, authz.user.id)
      return NextResponse.json({ ok: true })
    } catch (e) {
      if (e instanceof AutopayError) return apiErrorResponse(e, { safeStatus: 422 })
      throw e
    }
  },
})
