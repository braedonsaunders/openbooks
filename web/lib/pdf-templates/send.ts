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
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { appBaseUrl } from '@openbooks/engine/src/flows/email-tokens.ts'
import { verifyPdfEncryption } from '@openbooks/pdf'
import { isFeatureEnabled } from '../features'
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

// Payroll PDFs can expose compensation detail under more than one record key:
// payroll_cheque, for example, includes the pay-stub earnings and deductions
// as its voucher. Derive protection from the catalog's payroll boundary so a
// future alias cannot quietly fall back to the generic plaintext path.
export function isProtectedPayrollRecordType(recordType: string): boolean {
  return PDF_RECORD_TYPE_BY_KEY[recordType]?.readPermission === 'payroll.read'
}

async function requireEncryptedPayrollPdf(plaintext: Buffer, candidate: Buffer): Promise<Buffer> {
  const invalidEncryption = (cause?: unknown) => new Error(
    `payroll compensation PDF encryption must return a valid encrypted PDF`
      + (cause ? ` (${cause instanceof Error ? cause.message : String(cause)})` : ''),
  )
  if (!Buffer.isBuffer(candidate) || candidate.length === 0 || candidate.equals(plaintext)) {
    throw invalidEncryption()
  }

  try {
    // Independent certification, not parser-reported markers: any writer can
    // forge an /Encrypt trailer entry that lenient parsers report as
    // "encrypted" over fully readable plaintext. qpdf must be able to open
    // the document only under a real security handler that rejects the empty
    // password — identity, copy, alternate-plaintext, and marker-only forgeries
    // all fail that certification and the send is refused.
    await verifyPdfEncryption(candidate)
  } catch (e) {
    throw invalidEncryption(e)
  }
  return candidate
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

  // A protected payroll attachment must leave as ciphertext or not at all.
  // Enforced before any dependency work so no caller can reach the render or
  // send path for a compensation PDF without a protection pass supplied.
  const protectedPayrollRecord = isProtectedPayrollRecordType(args.recordType)
  if (protectedPayrollRecord && !args.encrypt) {
    throw new Error('payroll compensation PDFs must be encrypted before email delivery')
  }

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
  const stamp = await businessToday(args.orgId)
  const attachmentName = `${meta.docTitle}-${record.reference}-${stamp}.pdf`.replace(/\s+/g, '-')
  const rendered = await mergeAndPrintPdf(tpl, record.values)
  // Give post-processors a copy so they cannot mutate the plaintext baseline
  // used to verify that protected output was actually transformed.
  const processed = args.encrypt ? await args.encrypt(Buffer.from(rendered)) : rendered
  const pdf = protectedPayrollRecord
    // Fail closed: identity, copy, and alternate-plaintext outputs are refused
    // here — the attachment is either verified ciphertext or there is no send.
    ? await requireEncryptedPayrollPdf(rendered, processed)
    : processed
  // When the invoice has an active hosted payment link, include it as a
  // pay-online call-to-action. Creating the link is the opt-in; nothing is
  // attached for invoices without one. Stored links stay when the feature is
  // off — the email just omits the CTA.
  let paymentUrl: string | undefined
  if (args.recordType === 'customer_invoice' && (await isFeatureEnabled(args.orgId, 'onlinePayments'))) {
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
