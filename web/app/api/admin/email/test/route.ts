import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../../lib/authz'
import { sendVia, isValidEmailAddress } from '@openbooks/emails'
import { insertEmailLog, markEmailFailed, markEmailSent, resolveOrgEmailTransport } from '@openbooks/engine/src/email-config.ts'

export const runtime = 'nodejs'

/**
 * Send a test email through the org's currently-saved transport (synchronous so
 * the admin sees the outcome immediately). Records an email_log row either way.
 */
export async function POST(req: Request) {
  // Sending through (and probing) the org transport is setup authority.
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId

  let to: string
  try {
    const parsedBody = await parseJsonBody(req, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    to = String(((parsedBody.data) as { to?: unknown }).to ?? '').trim()
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }
  if (!isValidEmailAddress(to)) return NextResponse.json({ error: 'Enter a valid recipient email.' }, { status: 422 })

  const transport = await resolveOrgEmailTransport(orgId)
  if (!transport) return NextResponse.json({ error: 'Configure and enable an email provider first.' }, { status: 422 })

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
  })
  try {
    const { id } = await sendVia(transport, {
      to,
      subject,
      text: `This is a test email from OpenBooks, sent via ${transport.provider}.`,
      html: `<p>This is a test email from OpenBooks, sent via <strong>${transport.provider}</strong>.</p>`,
    })
    await markEmailSent(orgId, logId, id)
    return NextResponse.json({ ok: true, provider: transport.provider, messageId: id })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'send failed'
    await markEmailFailed(orgId, logId, message)
    return NextResponse.json({ error: message }, { status: 422 })
  }
}
