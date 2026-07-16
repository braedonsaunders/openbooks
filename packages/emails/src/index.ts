// Email delivery for OpenBooks. Provider abstraction (Resend, SendGrid, Mailgun,
// Postmark, SMTP) in ./providers + ./transport. Delivery always uses an
// explicitly resolved per-org transport; this package has no implicit provider.

export * from './providers'
export * from './transport'
export * from './delivery-input'
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
