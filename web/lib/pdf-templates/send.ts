import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { documentEmail, sendVia } from '@openbooks/emails'
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  resolveOrgEmailTransport,
} from '@openbooks/engine/src/email-config.ts'
import { appBaseUrl } from '@openbooks/engine/src/flows/email-tokens.ts'
import { PDF_RECORD_TYPE_BY_KEY } from './catalog'
import { mergeAndPrintPdf } from './render'
import { resolvePdfTemplate } from './store'
import { loadPdfRecordValues } from './values'

/**
 * Email a transaction to its party with the rendered PDF attached. Reuses the
 * exact record-PDF render path (template + values → mergeAndPrintPdf) and the
 * per-org email transport; the send is synchronous so the caller gets a real
 * success/failure (and it's written to email_log either way).
 */

export interface RecipientInfo {
  to: string | null
  docTitle: string
  reference: string
  partyName: string | null
}

/** Default recipient + labels for the send dialog (the party's email on file). */
export async function resolveRecordRecipient(
  recordType: string,
  orgId: string,
  id: string,
): Promise<RecipientInfo | null> {
  const meta = PDF_RECORD_TYPE_BY_KEY[recordType]
  if (!meta) return null
  const record = await loadPdfRecordValues(recordType, orgId, id)
  if (!record) return null
  const v = record.values as Record<string, unknown>
  const to = typeof v.party_email === 'string' && v.party_email.trim() ? v.party_email.trim() : null
  const partyName = typeof v.party_name === 'string' && v.party_name.trim() ? v.party_name.trim() : null
  return { to, docTitle: meta.docTitle, reference: record.reference, partyName }
}

export async function sendRecordPdfEmail(args: {
  recordType: string
  orgId: string
  id: string
  to?: string
  message?: string
  templateId?: string | null
  /**
   * Post-processing pass applied to the rendered bytes before they are
   * attached — how a confidential record (a pay stub) is emailed encrypted.
   * It throws rather than returning the plaintext when it cannot protect the
   * document, and the send fails with it: nothing confidential is ever
   * downgraded to an unprotected attachment.
   */
  encrypt?: (pdf: Buffer) => Promise<Buffer>
}): Promise<{ to: string; subject: string }> {
  const meta = PDF_RECORD_TYPE_BY_KEY[args.recordType]
  if (!meta) throw new Error('unknown record type')

  const [tpl, record, transport] = await Promise.all([
    resolvePdfTemplate(args.orgId, args.recordType, args.templateId ?? null),
    loadPdfRecordValues(args.recordType, args.orgId, args.id),
    resolveOrgEmailTransport(args.orgId),
  ])
  if (!tpl) throw new Error('no PDF template available for this record')
  if (!record) throw new Error('record not found')
  if (!transport) throw new Error('email delivery is not configured — set it up in Admin → Email')

  const v = record.values as Record<string, unknown>
  const to = (args.to?.trim() || (typeof v.party_email === 'string' ? v.party_email : '') || '').trim()
  if (!to) throw new Error('no recipient email — add an email address to the customer or vendor first')

  const orgName = (typeof v.org_name === 'string' && v.org_name) || 'OpenBooks'
  const partyName = typeof v.party_name === 'string' && v.party_name ? v.party_name : undefined
  const attachmentName = `${meta.docTitle}-${record.reference}.pdf`.replace(/\s+/g, '-')
  const rendered = await mergeAndPrintPdf(tpl, record.values)
  const pdf = args.encrypt ? await args.encrypt(rendered) : rendered
  // When the invoice has an active hosted payment link, include it as a
  // pay-online call-to-action. Creating the link is the opt-in; nothing is
  // attached for invoices without one.
  let paymentUrl: string | undefined
  if (args.recordType === 'customer_invoice') {
    const link = (await db.execute<{ token: string }>(sql`
      select token from payment_links
       where org_id = ${args.orgId} and document_id = ${args.id} and status = 'active'
       order by created_at desc limit 1
    `))
    if (link.rows[0]) paymentUrl = `${appBaseUrl()}/pay/${link.rows[0].token}`
  }
  const body = documentEmail({
    orgName,
    docTitle: meta.docTitle,
    reference: record.reference,
    partyName,
    message: args.message,
    attachmentName,
    paymentUrl,
  })

  const logId = await insertEmailLog({
    orgId: args.orgId,
    recipients: [to],
    subject: body.subject,
    status: 'queued',
    categoryKey: 'document',
    meta: { recordType: args.recordType, recordId: args.id },
  })
  try {
    const { id } = await sendVia(transport, {
      to,
      subject: body.subject,
      html: body.html,
      text: body.text,
      attachments: [{ filename: attachmentName, content: pdf.toString('base64'), contentType: 'application/pdf' }],
    })
    await markEmailSent(args.orgId, logId, id)
  } catch (e) {
    await markEmailFailed(args.orgId, logId, e instanceof Error ? e.message : String(e))
    throw e
  }
  return { to, subject: body.subject }
}
