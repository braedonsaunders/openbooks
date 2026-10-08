import { esc, shell, type EmailOut } from './shell'

/**
 * A person's published schedule changed. Lists each day that changed in
 * date order with a link to their schedule; every string arrives already
 * written in the recipient's language.
 */
export function scheduleChangeEmail(args: {
  orgName: string
  subject: string
  intro: string
  lines: readonly string[]
  linkLabel: string
  link: string
  footer: string
}): EmailOut {
  const text = `${args.intro}\n\n${args.lines.map((line) => `• ${line}`).join('\n')}\n\n${args.linkLabel}: ${args.link}\n\n— ${args.orgName}`
  const html = shell({
    heading: args.subject,
    bodyHtml: `
      <p>${esc(args.intro)}</p>
      <ul style="padding-left:18px">${args.lines.map((line) => `<li style="margin:4px 0">${esc(line)}</li>`).join('')}</ul>
      <p><a href="${esc(args.link)}">${esc(args.linkLabel)}</a></p>
      <p style="color:#666">${esc(args.orgName)}</p>`,
    footer: args.footer,
  })
  return { subject: args.subject, html, text }
}
