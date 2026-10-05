import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { db, withOrgContext } from '@openbooks/engine/platform/database'
import {
  PORTAL_ACTOR_ID,
  acceptSaveOffer,
  applySubscriptionChange,
  assertPortalDocument,
  assertPortalPaymentMethod,
  cancelSubscription,
  pauseSubscription,
  previewSubscriptionChange,
  resolvePortalSession,
  resolvePortalSetupCurrency,
  resumeSubscription,
} from '@openbooks/engine/portal'
import { createPaymentLink } from '@openbooks/engine/payments/acceptance'
import { removeMethod, setDefaultMethod, startMethodSetup } from '@openbooks/engine/payments/autopay'
import { lookupStoredValueByCode } from '@openbooks/engine/stored-value'
import { appBaseUrl } from '@openbooks/engine/flows'

export const runtime = 'nodejs'

const sessionToken = z.string().min(16).max(256)

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('previewSubscription'), sessionToken, subscriptionId: z.string().uuid(), quantity: z.unknown().optional(), unitPrice: z.unknown().optional(), componentKey: z.string().max(120).optional(), effectiveOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
  z.object({ action: z.literal('changeSubscription'), sessionToken, subscriptionId: z.string().uuid(), quantity: z.unknown().optional(), unitPrice: z.unknown().optional(), componentKey: z.string().max(120).optional(), effectiveOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
  z.object({ action: z.literal('pauseSubscription'), sessionToken, subscriptionId: z.string().uuid() }),
  z.object({ action: z.literal('resumeSubscription'), sessionToken, subscriptionId: z.string().uuid() }),
  z.object({ action: z.literal('cancelSubscription'), sessionToken, subscriptionId: z.string().uuid(), reason: z.string().max(200) }),
  z.object({ action: z.literal('acceptSaveOffer'), sessionToken, subscriptionId: z.string().uuid(), offerId: z.string().max(80) }),
  z.object({ action: z.literal('payInvoice'), sessionToken, documentId: z.string().uuid(), provider: z.enum(['stripe', 'adyen', 'gocardless']) }),
  z.object({ action: z.literal('setDefaultMethod'), sessionToken, methodId: z.string().uuid() }),
  z.object({ action: z.literal('removeMethod'), sessionToken, methodId: z.string().uuid() }),
  z.object({ action: z.literal('startMethodSetup'), sessionToken, provider: z.enum(['stripe', 'adyen', 'gocardless']) }),
  z.object({ action: z.literal('lookupGiftCard'), sessionToken, code: z.string().min(4).max(64) }),
])

type Body = z.output<typeof bodySchema>

/**
 * Public: every portal mutation. The session token is verified in-route on
 * every request and every record is scope-checked to the session party —
 * customer A names customer B's rows and reads a 404.
 */
export const POST = defineRoute({
  public: 'token',
  body: bodySchema,
  opaque: {
    quantity: "quantities are parsed to exact decimals by parsePortalDecimal in previewSubscriptionChange and applySubscriptionChange with a named 422",
    unitPrice: "prices are parsed to exact decimals by parsePortalDecimal in previewSubscriptionChange and applySubscriptionChange with a named 422",
  },
  handler: async ({ body }: { body: Body }) => {
    const session = await resolvePortalSession(body.sessionToken)
    if (!session) return NextResponse.json({ error: 'This portal session is invalid or expired' }, { status: 404 })
    const { orgId, partyId, linkId } = session
    switch (body.action) {
      case 'previewSubscription':
        return NextResponse.json(await previewSubscriptionChange(orgId, partyId, body))
      case 'changeSubscription':
        return NextResponse.json(await applySubscriptionChange(orgId, partyId, linkId, body))
      case 'pauseSubscription':
        return NextResponse.json(await pauseSubscription(orgId, partyId, linkId, body.subscriptionId))
      case 'resumeSubscription':
        return NextResponse.json(await resumeSubscription(orgId, partyId, linkId, body.subscriptionId))
      case 'cancelSubscription':
        return NextResponse.json(await cancelSubscription(orgId, partyId, linkId, body.subscriptionId, body.reason))
      case 'acceptSaveOffer':
        return NextResponse.json(await acceptSaveOffer(orgId, partyId, linkId, body))
      case 'payInvoice': {
        const invoice = await withOrgContext(orgId, () => assertPortalDocument(db, orgId, partyId, body.documentId))
        if (invoice.kind !== 'customer_invoice') {
          return NextResponse.json({ error: 'Only invoices can be paid here' }, { status: 422 })
        }
        const link = await createPaymentLink(orgId, PORTAL_ACTOR_ID, { documentId: body.documentId, provider: body.provider }, null)
        return NextResponse.json({ paymentToken: link.token })
      }
      case 'setDefaultMethod': {
        await withOrgContext(orgId, () => assertPortalPaymentMethod(db, orgId, partyId, body.methodId))
        await setDefaultMethod(orgId, body.methodId, PORTAL_ACTOR_ID)
        return NextResponse.json({ ok: true })
      }
      case 'removeMethod': {
        await withOrgContext(orgId, () => assertPortalPaymentMethod(db, orgId, partyId, body.methodId))
        await removeMethod(orgId, body.methodId, PORTAL_ACTOR_ID)
        return NextResponse.json({ ok: true })
      }
      case 'startMethodSetup': {
        const setupToken = randomBytes(32).toString('hex')
        const currency = await withOrgContext(orgId, () => resolvePortalSetupCurrency(orgId, partyId))
        const setup = await startMethodSetup(orgId, {
          partyId,
          provider: body.provider,
          setupToken,
          currency,
          returnUrl: `${appBaseUrl()}/pay/setup/${setupToken}/return`,
        })
        return NextResponse.json({ setupToken: setup.setupToken, setupUrl: `/pay/setup/${setupToken}`, redirectUrl: setup.redirectUrl })
      }
      case 'lookupGiftCard': {
        // Customer portal code-Bearer [REDACTED] the secret code is the credential, and
        // the session's party binding is asserted separately — there is no
        // actor entity set to scope by, so explicit null is intentional here.
        const balance = await lookupStoredValueByCode(orgId, body.code, null)
        if (!balance) return NextResponse.json({ error: 'No gift card or credit matches that code' }, { status: 404 })
        return NextResponse.json({ kind: balance.kind, balanceMinor: balance.balanceMinor, currency: balance.currency, status: balance.status })
      }
    }
  },
})
