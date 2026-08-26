// Email delivery for OpenBooks. Provider abstraction (Resend, SendGrid, Mailgun,
// Postmark, SMTP) in ./providers + ./transport. Delivery always uses an
// explicitly resolved per-org transport; this package has no implicit provider.

export * from './providers'
export * from './transport'
export * from './delivery-input'
export * from './outcome'
export { sealSecret, unsealSecret, type SealedSecret } from './crypto'

function esc(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export type EmailOut = { subject: string; html: string; text: string }

function shell(args: { heading: string; bodyHtml: string; footer?: string }): string {
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="font-family:ui-sans-serif,system-ui,sans-serif;color:#111;line-height:1.5">
      <tr><td>
        <h2 style="margin:0 0 16px">${esc(args.heading)}</h2>
        ${args.bodyHtml}
        <p style="color:#666;font-size:12px;margin-top:24px">${args.footer ? esc(args.footer) : 'Manage scheduled reports in OpenBooks → Reports.'}</p>
      </td></tr>
    </table>`
}

// --- Flow / approval emails (engine/src/flows) -------------------------------
//
// Bodies for the flows engine's gate lifecycle (assignment / reminder /
// escalation) and its generic send_email action. Subject/body text arrives
// already {{field}}-interpolated by the engine; these builders only wrap it in
// the shared shell and HTML-escape it for the html part.

/**
 * One-click Approve / Reject buttons for gate emails. The URLs are HMAC-signed
 * per gate row + assignee (engine/src/flows/email-tokens.ts) and land on a
 * confirmation page — the email link itself never decides.
 */
function decisionButtonsHtml(approveUrl?: string, rejectUrl?: string): string {
  if (!approveUrl || !rejectUrl) return ''
  return `
      <p style="margin:20px 0">
        <a href="${esc(approveUrl)}" style="display:inline-block;padding:10px 20px;background:#16a34a;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Approve</a>
        <a href="${esc(rejectUrl)}" style="display:inline-block;padding:10px 20px;background:#dc2626;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;margin-left:12px">Reject</a>
      </p>`
}

function decisionLinksText(approveUrl?: string, rejectUrl?: string): string {
  if (!approveUrl || !rejectUrl) return ''
  return `Approve: ${approveUrl}\nReject: ${rejectUrl}\n\n`
}

/**
 * A gate was assigned: "your approval is requested". Pass `approveUrl` /
 * `rejectUrl` to render one-click decision buttons.
 */
export function flowApprovalRequestEmail(args: {
  orgName: string
  gateTitle: string
  subjectLabel: string
  flowName: string
  approveUrl?: string
  rejectUrl?: string
}): EmailOut {
  const subject = `Approval requested: ${args.gateTitle} — ${args.subjectLabel}`
  const text =
    `Your approval is requested.\n\n` +
    `${args.gateTitle}\n${args.subjectLabel}\n\n` +
    decisionLinksText(args.approveUrl, args.rejectUrl) +
    `Open OpenBooks → Approvals to decide.\n\n— ${args.orgName} via OpenBooks (flow "${args.flowName}")`
  const html = shell({
    heading: 'Approval requested',
    bodyHtml: `
      <p><strong>${esc(args.gateTitle)}</strong></p>
      <p>${esc(args.subjectLabel)}</p>
      ${decisionButtonsHtml(args.approveUrl, args.rejectUrl)}
      <p>Or open <strong>OpenBooks → Approvals</strong> to approve or reject.</p>
      <p style="color:#666">${esc(args.orgName)} · flow “${esc(args.flowName)}”</p>`,
    footer: 'You received this because a flow routed an approval to you.',
  })
  return { subject, html, text }
}

/**
 * Reminder: a gate assigned to the recipient is still pending. Pass
 * `approveUrl` / `rejectUrl` to render one-click decision buttons.
 */
export function flowApprovalReminderEmail(args: {
  orgName: string
  gateTitle: string
  subjectLabel: string
  approveUrl?: string
  rejectUrl?: string
}): EmailOut {
  const subject = `Reminder — approval pending: ${args.gateTitle}`
  const text =
    `A pending approval is still waiting on you.\n\n` +
    `${args.gateTitle}\n${args.subjectLabel}\n\n` +
    decisionLinksText(args.approveUrl, args.rejectUrl) +
    `Open OpenBooks → Approvals to decide.\n\n— ${args.orgName} via OpenBooks`
  const html = shell({
    heading: 'Approval still pending',
    bodyHtml: `
      <p><strong>${esc(args.gateTitle)}</strong> is still waiting on your decision.</p>
      <p>${esc(args.subjectLabel)}</p>
      ${decisionButtonsHtml(args.approveUrl, args.rejectUrl)}
      <p>Or open <strong>OpenBooks → Approvals</strong> to approve or reject.</p>
      <p style="color:#666">${esc(args.orgName)} · OpenBooks</p>`,
    footer: 'You received this because a flow routed an approval to you.',
  })
  return { subject, html, text }
}

/** Escalation: an overdue gate was re-targeted at the recipient. */
export function flowApprovalEscalationEmail(args: {
  orgName: string
  gateTitle: string
  subjectLabel: string
}): EmailOut {
  const subject = `Escalated approval: ${args.gateTitle} — ${args.subjectLabel}`
  const text =
    `An overdue approval was escalated to you.\n\n` +
    `${args.gateTitle}\n${args.subjectLabel}\n\n` +
    `Open OpenBooks → Approvals to decide.\n\n— ${args.orgName} via OpenBooks`
  const html = shell({
    heading: 'Approval escalated to you',
    bodyHtml: `
      <p>An overdue approval was escalated to you: <strong>${esc(args.gateTitle)}</strong></p>
      <p>${esc(args.subjectLabel)}</p>
      <p>Open <strong>OpenBooks → Approvals</strong> to approve or reject.</p>
      <p style="color:#666">${esc(args.orgName)} · OpenBooks</p>`,
    footer: 'You received this because an approval escalated to you.',
  })
  return { subject, html, text }
}

/** The generic flows send_email action (subject/body already interpolated). */
export function flowNotificationEmail(args: {
  orgName: string
  subject: string
  body: string
}): EmailOut {
  const text = `${args.body}\n\n— ${args.orgName} via OpenBooks`
  const html = shell({
    heading: args.subject,
    bodyHtml: `
      <p style="white-space:pre-wrap">${esc(args.body)}</p>
      <p style="color:#666">${esc(args.orgName)} · OpenBooks</p>`,
    footer: 'Sent by an automation flow in OpenBooks.',
  })
  return { subject: args.subject, html, text }
}

/** The body for a scheduled financial report; the PDF rides as an attachment. */
export function scheduledReportEmail(args: {
  orgName: string
  reportName: string
  periodPhrase?: string
  attachmentName: string
}): EmailOut {
  const subject = `${args.reportName} — ${args.orgName}`
  const period = args.periodPhrase ? ` for ${args.periodPhrase}` : ''
  const text =
    `Your scheduled report "${args.reportName}"${period} is attached (${args.attachmentName}).\n\n` +
    `— ${args.orgName} via OpenBooks`
  const html = shell({
    heading: args.reportName,
    bodyHtml: `
      <p>Your scheduled report${period ? ` <strong>${esc(args.periodPhrase!)}</strong>` : ''} is attached as <strong>${esc(args.attachmentName)}</strong>.</p>
      <p style="color:#666">${esc(args.orgName)} · OpenBooks</p>`,
  })
  return { subject, html, text }
}

/**
 * Self-service password reset. The link carries a one-use token that expires
 * quickly; the email states both so stale links explain themselves. Never
 * includes the account's org or any other identifying detail beyond the email
 * it was sent to.
 */
export function passwordResetEmail(args: {
  recipientName?: string | null
  resetUrl: string
  expiresMinutes: number
}): EmailOut {
  const subject = 'Reset your OpenBooks password'
  const greeting = args.recipientName ? `Hi ${args.recipientName},` : 'Hi,'
  const text =
    `${greeting}\n\n` +
    `A password reset was requested for your OpenBooks account. Open this link to choose a new password:\n\n` +
    `${args.resetUrl}\n\n` +
    `The link works once and expires in ${args.expiresMinutes} minutes. ` +
    `If you didn't request this, you can ignore this email — your password is unchanged.`
  const html = shell({
    heading: 'Reset your password',
    bodyHtml: `
      <p>${esc(greeting)}</p>
      <p>A password reset was requested for your OpenBooks account.</p>
      <p style="margin:20px 0">
        <a href="${esc(args.resetUrl)}" style="display:inline-block;padding:10px 20px;background:#0d9488;color:#fff;text-decoration:none;border-radius:6px;font-weight:600">Choose a new password</a>
      </p>
      <p style="color:#666">The link works once and expires in ${esc(args.expiresMinutes)} minutes.
      If you didn't request this, you can ignore this email — your password is unchanged.</p>`,
    footer: 'Sent by OpenBooks in response to a password reset request.',
  })
  return { subject, html, text }
}

/** Cover email for a transaction (invoice, quote, PO, …) sent to its party; the
 *  rendered document rides as a PDF attachment. An optional free-text `message`
 *  from the sender is shown above the standard line. */
export function documentEmail(args: {
  orgName: string
  docTitle: string
  reference: string
  partyName?: string
  message?: string
  attachmentName: string
  /** Optional hosted payment link rendered as a call-to-action. */
  paymentUrl?: string
}): EmailOut {
  const subject = `${args.docTitle} ${args.reference} — ${args.orgName}`
  const greeting = args.partyName ? `Hello ${args.partyName},` : 'Hello,'
  const msg = args.message?.trim()
  const text =
    `${greeting}\n\n` +
    (msg ? `${msg}\n\n` : '') +
    `Please find ${args.docTitle} ${args.reference} attached (${args.attachmentName}).\n\n` +
    (args.paymentUrl ? `Pay online: ${args.paymentUrl}\n\n` : '') +
    `— ${args.orgName} via OpenBooks`
  const html = shell({
    heading: `${args.docTitle} ${args.reference}`,
    bodyHtml: `
      <p>${esc(greeting)}</p>
      ${msg ? `<p style="white-space:pre-wrap">${esc(msg)}</p>` : ''}
      <p>Please find <strong>${esc(args.docTitle)} ${esc(args.reference)}</strong> attached as <strong>${esc(args.attachmentName)}</strong>.</p>
      ${args.paymentUrl ? `<p style="margin:16px 0"><a href="${esc(args.paymentUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:600">Pay online</a></p><p style="font-size:12px;color:#666;word-break:break-all">${esc(args.paymentUrl)}</p>` : ''}
      <p style="color:#666">${esc(args.orgName)} · OpenBooks</p>`,
    footer: `Sent by ${args.orgName} via OpenBooks.`,
  })
  return { subject, html, text }
}

/** Remittance advice for a completed outbound payment. */
export function paymentRemittanceEmail(args: {
  orgName: string
  payeeName: string
  paymentReference: string
  paymentDate: string
  amount: string
  currency: string
  documents: Array<{ number: string; amount: string; discount: string; credit: string }>
}): EmailOut {
  const subject = `Payment advice ${args.paymentReference} — ${args.orgName}`
  const rows = args.documents.map((d) => `${d.number}: ${d.amount} ${args.currency} (discount ${d.discount}, credit ${d.credit})`)
  const text = `A payment of ${args.amount} ${args.currency} was issued to ${args.payeeName} on ${args.paymentDate}.\nReference: ${args.paymentReference}\n\n${rows.join('\n')}\n\n— ${args.orgName} via OpenBooks`
  const htmlRows = args.documents.map((d) => `<tr><td style="padding:6px 12px 6px 0">${esc(d.number)}</td><td style="padding:6px 12px;text-align:right">${esc(d.amount)} ${esc(args.currency)}</td><td style="padding:6px 0;color:#666">${esc(d.discount)} / ${esc(d.credit)}</td></tr>`).join('')
  const html = shell({
    heading: 'Payment advice',
    bodyHtml: `<p>A payment of <strong>${esc(args.amount)} ${esc(args.currency)}</strong> was issued to ${esc(args.payeeName)} on ${esc(args.paymentDate)}.</p><p>Reference: <strong>${esc(args.paymentReference)}</strong></p><table cellpadding="0" cellspacing="0"><thead><tr><th align="left">Document</th><th align="right">Payment</th><th align="left">Discount / credit</th></tr></thead><tbody>${htmlRows}</tbody></table>`,
    footer: `Payment advice from ${args.orgName}.`,
  })
  return { subject, html, text }
}
