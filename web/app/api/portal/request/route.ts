import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { requestPortalLink, PORTAL_LINK_TTL_MINUTES } from '@openbooks/engine/portal'
import { portalMagicLinkEmail, deriveEmailDeliveryKey, sendVia } from '@openbooks/emails'
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransport,
} from '@openbooks/engine/delivery/email-config'
import { appBaseUrl } from '@openbooks/engine/flows'

export const runtime = 'nodejs'

const bodySchema = z.object({ email: z.string().max(320) })

/**
 * Public: request a portal magic link. Always answers { sent: true } —
 * unknown addresses, capped addresses and orgs without the portal stay
 * silent, so the endpoint cannot enumerate customer emails.
 */
export const POST = defineRoute({
  public: 'token',
  body: bodySchema,
  handler: async ({ body }) => {
    const requested = await requestPortalLink(body.email)
    const origin = appBaseUrl()
    for (const link of requested.links) {
      const url = `${origin}/portal/${link.token}`
      const mail = portalMagicLinkEmail({
        orgName: link.orgName,
        portalName: link.portalName,
        linkUrl: url,
        expiresMinutes: PORTAL_LINK_TTL_MINUTES,
      })
      const transport = await resolveOrgEmailTransport(link.orgId)
      if (!transport) continue
      const logId = await insertEmailLog({
        orgId: link.orgId,
        recipients: [link.email],
        subject: mail.subject,
        status: 'queued',
        categoryKey: 'portal',
        meta: { event: 'magic_link' },
        actor: { kind: 'system', reason: 'Customer requested a portal sign-in link' },
      })
      try {
        const outcome = await sendVia(transport, { to: link.email, subject: mail.subject, html: mail.html, text: mail.text }, {
          deliveryKey: deriveEmailDeliveryKey({ orgId: link.orgId, scope: `direct:${logId}`, to: link.email }),
        })
        if (outcome.kind === 'sent') await markEmailSent(link.orgId, logId, outcome.providerMessageId)
        else {
          await markEmailUncertain(link.orgId, logId, outcome.reason)
        }
      } catch {
        await markEmailFailed(link.orgId, logId, 'portal magic link send failed')
      }
    }
    return NextResponse.json({ sent: true })
  },
})
