import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransport,
} from '@openbooks/engine/src/email-config.ts'
import { deriveEmailDeliveryKey, documentEmail, isValidEmailAddress, sendVia } from '@openbooks/emails'
import { guardPermission } from '../../../../../../lib/authz'
import { isUuid } from '../../../../../../lib/list-params'
import { parseReportQuery } from '../../../../../../lib/report-filters'
import { resolvePeriod } from '../../../../../../lib/periods'
import { resolveReport, type ReportKind } from '../../../../../../lib/report-run'
import { exportDataToPdf, orgBranding, resolveLayout, type Translator } from '../../../../../../lib/report-pdf'
import { safeName } from '../../../../../../lib/export'

export const runtime = 'nodejs'

/**
 * Party statement delivery (AR/AP sides of /reports/statements/[partyId]).
 *
 * Generates the same partner-statement PDF the Reports surface exports and
 * emails it to the party, so a statement can go out from the customer/vendor
 * drawer instead of download-then-attach. Mirrors the record-pdf send
 * boundary: sending needs the family write authority (ar.create/ap.create by
 * side — read access alone never authorizes a delivery), an explicitly
 * addressed send must name one valid address, and blank falls through to the
 * party email on file. No transport configured, or no recipient anywhere,
 * fails closed before any render work.
 */

type Side = 'ar' | 'ap'

function sideOf(req: Request, body?: { side?: unknown }): Side {
  const raw = typeof body?.side === 'string' ? body.side : new URL(req.url).searchParams.get('side')
  return raw === 'ap' ? 'ap' : 'ar'
}

async function loadParty(orgId: string, id: string) {
  const rows = (await db.execute<{ id: string; display_name: string | null; email: string | null }>(sql`
    select id, display_name, email from parties where id = ${id} and org_id = ${orgId} limit 1
  `)).rows
  return rows[0] ?? null
}

/** GET — default recipient to prefill the send dialog. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const side = sideOf(req)
  const gate = await guardPermission(side === 'ap' ? 'ap.read' : 'ar.read')
  if (gate instanceof NextResponse) return gate
  if (!isUuid(id)) return NextResponse.json({ error: 'record not found' }, { status: 404 })
  const party = await loadParty(gate.user.orgId, id)
  if (!party) return NextResponse.json({ error: 'record not found' }, { status: 404 })
  return NextResponse.json({ to: party.email?.trim() || null, partyName: party.display_name })
}

/** POST — render the party-statement PDF and email it to the party. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const parsedBody = await parseJsonBody(req, jsonObject)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data as { to?: string; message?: string; side?: string; from?: string; toDate?: string }
  const side = sideOf(req, body)
  const sendPermission = side === 'ap' ? 'ap.create' : 'ar.create'
  const gate = await guardPermission(sendPermission)
  if (gate instanceof NextResponse) return gate
  if (!isUuid(id)) return NextResponse.json({ error: 'record not found' }, { status: 404 })
  const party = await loadParty(gate.user.orgId, id)
  if (!party) return NextResponse.json({ error: 'record not found' }, { status: 404 })

  const requestedTo = typeof body.to === 'string' ? body.to.trim() : ''
  if (requestedTo !== '' && !isValidEmailAddress(requestedTo)) {
    return NextResponse.json({ error: 'invalid recipient email address' }, { status: 400 })
  }
  const to = requestedTo || party.email?.trim() || ''
  if (!to) {
    return NextResponse.json({ error: 'no recipient email — add an email address to the party first' }, { status: 422 })
  }

  const transport = await resolveOrgEmailTransport(gate.user.orgId)
  if (!transport) {
    return NextResponse.json({ error: 'email delivery is not configured — set it up in Admin → Email' }, { status: 422 })
  }

  const t = (await getTranslations('reports')) as unknown as Translator
  const stamp = await businessToday(gate.user.orgId)
  const reportParams = new URLSearchParams({ party: id, side })
  if (typeof body.from === 'string' && body.from) reportParams.set('from', body.from)
  if (typeof body.toDate === 'string' && body.toDate) reportParams.set('to', body.toDate)
  const query = parseReportQuery(reportParams)
  const period = await resolvePeriod(query.period, { customFrom: query.from, customTo: query.to })
  let pdf: Buffer
  let orgName = 'OpenBooks'
  try {
    const resolved = await resolveReport('partner-statement' as ReportKind, reportParams, {
      orgId: gate.user.orgId, t, period, query,
    })
    if (resolved.render !== 'data') throw new Error('statement failed')
    const branding = await orgBranding(gate.user.orgId)
    orgName = branding.orgName || orgName
    const { page, showSummary } = resolveLayout(null)
    pdf = Buffer.from(await exportDataToPdf(resolved.data, branding, page, {
      showSummary,
      generatedAt: new Date(`${stamp}T00:00:00Z`),
    }))
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'statement failed' }, { status: 422 })
  }

  const partyName = party.display_name?.trim() || undefined
  const attachmentName = `${safeName(`statement-${party.display_name ?? 'party'}-${period.to}`)}.pdf`
  const email = documentEmail({
    orgName,
    docTitle: 'Statement',
    reference: `as of ${period.to}`,
    partyName,
    message: typeof body.message === 'string' ? body.message : undefined,
    attachmentName,
  })
  const logId = await insertEmailLog({
    orgId: gate.user.orgId,
    recipients: [to],
    subject: email.subject,
    status: 'queued',
    categoryKey: 'statement',
    meta: { partyId: id, side },
    actor: { kind: 'user', userId: gate.user.id },
  })
  let uncertaintyRecorded = false
  try {
    const outcome = await sendVia(transport, {
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      attachments: [{ filename: attachmentName, content: pdf.toString('base64'), contentType: 'application/pdf' }],
    }, { deliveryKey: deriveEmailDeliveryKey({ orgId: gate.user.orgId, scope: `direct:${logId}`, to }) })
    if (outcome.kind === 'sent') {
      await markEmailSent(gate.user.orgId, logId, outcome.providerMessageId)
    } else {
      uncertaintyRecorded = true
      await markEmailUncertain(gate.user.orgId, logId, outcome.reason)
      throw new Error(outcome.reason)
    }
  } catch (e) {
    if (!uncertaintyRecorded) {
      await markEmailFailed(gate.user.orgId, logId, e instanceof Error ? e.message : String(e))
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : 'send failed' }, { status: 422 })
  }
  return NextResponse.json({ ok: true, to })
}
