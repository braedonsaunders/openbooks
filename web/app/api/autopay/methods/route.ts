import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { randomBytes } from 'node:crypto'
import { appBaseUrl } from '@openbooks/engine/payments/autopay'
import {
  AutopayError,
  listPaymentMethods,
  startMethodSetup,
} from '@openbooks/engine/payments/autopay'
import { uuidId } from '@/lib/api/json'
import { defineRoute } from '@/lib/api/route'
import { isUuid } from '@/lib/list-params'
import { guardAutopayPartyScope } from '@/lib/autopay-scope'

export const runtime = 'nodejs'

const providerEnum = z.enum(['stripe', 'adyen', 'gocardless'])

const startSetupBody = z.object({
  partyId: uuidId,
  provider: providerEnum,
  currency: z.string().regex(/^[A-Za-z]{3}$/, 'currency must be a 3-letter code'),
})

/**
 * Stored payment methods on file for a customer (brand, last four, expiry —
 * full credentials never leave the provider). POST mints a hosted setup
 * session and returns the customer-facing setup link, pinned to the app
 * origin like invoice mail links so a forged Host cannot carry the token
 * off-site.
 */
export const GET = defineRoute({
  permission: 'payment_methods.read',
  feature: 'autopay',
  handler: async ({ authz, request }) => {
    const partyId = new URL(request.url).searchParams.get('partyId') ?? ''
    if (!partyId || !isUuid(partyId)) return NextResponse.json({ error: 'partyId is required' }, { status: 400 })
    const outOfScope = await guardAutopayPartyScope(authz, partyId)
    if (outOfScope) return outOfScope
    try {
      const methods = await listPaymentMethods(authz.user.orgId, partyId)
      return NextResponse.json({ methods })
    } catch (e) {
      if (e instanceof AutopayError) return apiErrorResponse(e, { safeStatus: 422 })
      throw e
    }
  },
})

export const POST = defineRoute({
  permission: 'payment_methods.manage',
  feature: 'autopay',
  body: startSetupBody,
  handler: async ({ authz, body }) => {
    const outOfScope = await guardAutopayPartyScope(authz, body.partyId)
    if (outOfScope) return outOfScope
    const setupToken = randomBytes(32).toString('hex')
    try {
      const session = await startMethodSetup(authz.user.orgId, {
        partyId: body.partyId,
        provider: body.provider,
        currency: body.currency.toUpperCase(),
        returnUrl: `${appBaseUrl()}/pay/setup/${setupToken}/return`,
        setupToken,
        actorId: authz.user.id,
      })
      return NextResponse.json({
        methodId: session.methodId,
        setupUrl: `/pay/setup/${setupToken}`,
        redirectUrl: session.redirectUrl,
      })
    } catch (e) {
      if (e instanceof AutopayError) return apiErrorResponse(e, { safeStatus: 422 })
      throw e
    }
  },
})
