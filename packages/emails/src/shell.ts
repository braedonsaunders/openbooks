/** HTML-escape a value for an email body. */
export function esc(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export type EmailOut = { subject: string; html: string; text: string }

/** The shared layout every OpenBooks email body renders inside. */
export function shell(args: { heading: string; bodyHtml: string; footer?: string }): string {
  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="font-family:ui-sans-serif,system-ui,sans-serif;color:#111;line-height:1.5">
      <tr><td>
        <h2 style="margin:0 0 16px">${esc(args.heading)}</h2>
        ${args.bodyHtml}
        <p style="color:#666;font-size:12px;margin-top:24px">${args.footer ? esc(args.footer) : 'Manage scheduled reports in OpenBooks → Reports.'}</p>
      </td></tr>
    </table>`
}
