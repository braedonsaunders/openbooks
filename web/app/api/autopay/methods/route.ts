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
import { setupCurrencyAvailable, setupCustomerName, setupRecipients } from '@/lib/autopay-setup-link'
import { deriveEmailDeliveryKey, paymentMethodSetupEmail, sendVia } from '@openbooks/emails'
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransport,
} from '@openbooks/engine/delivery/email-config'
import { db } from '@openbooks/engine/platform/database'
import { sql } from 'drizzle-orm'

export const runtime = 'nodejs'

const providerEnum = z.enum(['stripe', 'adyen', 'gocardless'])

const startSetupBody = z.object({
  partyId: uuidId,
  provider: providerEnum,
  currency: z.string().regex(/^[A-Za-z]{3}$/, 'currency must be a 3-letter code'),
  /** Email the link to this address on the customer's record. Omitted, the
   *  link is only returned for the operator to share. */
  recipientEmail: z.string().trim().email().max(320).optional(),
})

type SetupDelivery = { status: 'sent' | 'uncertain' | 'failed'; recipient: string }

/**
 * Stored payment methods on file for a customer (brand, last four, expiry —
 * full credentials never leave the provider). POST mints a hosted setup
 * session and returns the customer-facing setup link, pinned to the app
 * origin like invoice mail links so a forged Host cannot carry the token
 * off-site. With a recipient, the link is also emailed to that address,
 * which must be the customer's own email or an active contact's; the
 * currency must be one the customer's legal entity may collect in.
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
    const orgId = authz.user.orgId
    const currency = body.currency.toUpperCase()
    if (!(await setupCurrencyAvailable(orgId, body.partyId, currency))) {
      return NextResponse.json(
        { error: `${currency} is not enabled for this customer; pick one of the listed currencies or enable Multi-currency in Company Settings → Features` },
        { status: 422 },
      )
    }
    let recipient: string | null = null
    let transport: Awaited<ReturnType<typeof resolveOrgEmailTransport>> = null
    if (body.recipientEmail) {
      const wanted = body.recipientEmail.toLowerCase()
      const match = (await setupRecipients(orgId, body.partyId)).find((entry) => entry.email.toLowerCase() === wanted)
      if (!match) {
        return NextResponse.json(
          { error: 'that address is not on this customer; add it to the customer as a contact first' },
          { status: 422 },
        )
      }
      transport = await resolveOrgEmailTransport(orgId)
      if (!transport) {
        return NextResponse.json(
          { error: 'outbound email is not set up; configure it under Administration → Email, or create the link without a recipient and share it yourself' },
          { status: 422 },
        )
      }
      recipient = match.email
    }
    const setupToken = randomBytes(32).toString('hex')
    let session: Awaited<ReturnType<typeof startMethodSetup>>
    try {
      session = await startMethodSetup(orgId, {
        partyId: body.partyId,
        provider: body.provider,
        currency,
        returnUrl: `${appBaseUrl()}/pay/setup/${setupToken}/return`,
        setupToken,
        actorId: authz.user.id,
      })
    } catch (e) {
      if (e instanceof AutopayError) return apiErrorResponse(e, { safeStatus: 422 })
      throw e
    }
    const setupUrl = `/pay/setup/${setupToken}`
    let delivery: SetupDelivery | null = null
    if (recipient && transport) {
      // The setup session already exists: a failed send still returns the
      // link so the operator can share it another way.
      const orgName = (await db.execute<{ name: string }>(sql`select name from orgs where id = ${orgId}`)).rows[0]?.name ?? ''
      const mail = paymentMethodSetupEmail({
        orgName,
        customerName: (await setupCustomerName(orgId, body.partyId)) ?? '',
        linkUrl: `${appBaseUrl()}${setupUrl}`,
      })
      const logId = await insertEmailLog({
        orgId,
        recipients: [recipient],
        subject: mail.subject,
        status: 'queued',
        categoryKey: 'autopay',
        meta: { event: 'payment_method_setup', partyId: body.partyId, methodId: session.methodId },
        actor: { kind: 'user', userId: authz.user.id },
      })
      try {
        const outcome = await sendVia(transport, { to: recipient, subject: mail.subject, html: mail.html, text: mail.text }, {
          deliveryKey: deriveEmailDeliveryKey({ orgId, scope: `direct:${logId}`, to: recipient }),
        })
        if (outcome.kind === 'sent') {
          await markEmailSent(orgId, logId, outcome.providerMessageId)
          delivery = { status: 'sent', recipient }
        } else {
          await markEmailUncertain(orgId, logId, outcome.reason)
          delivery = { status: 'uncertain', recipient }
        }
      } catch (error) {
        await markEmailFailed(orgId, logId, error instanceof Error ? error.message : 'payment method setup email failed')
        delivery = { status: 'failed', recipient }
      }
    }
    return NextResponse.json({
      methodId: session.methodId,
      setupUrl,
      redirectUrl: session.redirectUrl,
      delivery,
    })
  },
})
