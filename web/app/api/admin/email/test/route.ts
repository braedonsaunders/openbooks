import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from 'next/server'

import { deriveEmailDeliveryKey, sendVia, isValidEmailAddress } from '@openbooks/emails'
import { insertEmailLog, markEmailFailed, markEmailSent, markEmailUncertain, resolveOrgEmailTransportDetailed } from '@openbooks/engine/src/delivery/email-config.ts'

const requestBodySchema = z.object({ to: z.string().trim().min(1).max(320) });


export const runtime = 'nodejs'

/**
 * Send a test email through the org's currently-saved transport (synchronous so
 * the admin sees the outcome immediately). Records an email_log row either way.
 */


export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  body: requestBodySchema,
  handler: async ({ body, authz: routeAuthz }) => {

    // Sending through (and probing) the org transport is setup authority.
    const gate = routeAuthz

    const orgId = gate.user.orgId

    let to: string
    try {


      to = body.to
    } catch {
      return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
    }
    if (!isValidEmailAddress(to)) return NextResponse.json({ error: 'Enter a valid recipient email.' }, { status: 422 })

    const resolution = await resolveOrgEmailTransportDetailed(orgId)
    if (resolution.state === 'unconfigured') {
      return NextResponse.json({ error: 'Configure and enable an email provider first.' }, { status: 422 })
    }
    if (resolution.state === 'unusable') {
      return NextResponse.json({ error: resolution.reason }, { status: 422 })
    }
    const transport = resolution.transport

    const subject = 'OpenBooks email test'
    const logId = await insertEmailLog({
      orgId,
      provider: transport.provider,
      recipients: [to],
      fromAddr: transport.from,
      replyToAddr: transport.replyTo ?? null,
      subject,
      status: 'queued',
      categoryKey: 'test',
      meta: { userId: gate.user.id },
      actor: { kind: 'user', userId: gate.user.id },
    })
    try {
      const outcome = await sendVia(transport, {
        to,
        subject,
        text: `This is a test email from OpenBooks, sent via ${transport.provider}.`,
        html: `<p>This is a test email from OpenBooks, sent via <strong>${transport.provider}</strong>.</p>`,
        // The log row scope keeps this direct send's identity durable.
      }, { deliveryKey: deriveEmailDeliveryKey({ orgId, scope: `test:${logId}`, to }) })
      if (outcome.kind === 'sent') {
        await markEmailSent(orgId, logId, outcome.providerMessageId)
        return NextResponse.json({ ok: true, provider: transport.provider, messageId: outcome.providerMessageId })
      }
      // The provider may have accepted the message; do not claim failure.
      await markEmailUncertain(orgId, logId, outcome.reason)
      return NextResponse.json({ error: outcome.reason }, { status: 422 })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'send failed'
      await markEmailFailed(orgId, logId, message)
      return NextResponse.json({ error: message }, { status: 422 })
    }
  },
});
