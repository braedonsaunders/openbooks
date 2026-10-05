import { esc, shell, type EmailOut } from './shell'

type PortalMagicLinkEmail = {
  orgName: string
  portalName: string
  linkUrl: string
  expiresMinutes: number
}

export function portalMagicLinkEmail(args: PortalMagicLinkEmail): EmailOut {
  const subject = `Sign in to ${args.portalName} — ${args.orgName}`
  const text = `Hello,\n\nUse this link to sign in to ${args.portalName} at ${args.orgName}. It expires in ${args.expiresMinutes} minutes and works once — request a new one if it lapses.\n\n${args.linkUrl}\n\nIf you did not ask for this, ignore it: no account changes were made.\n\n— ${args.orgName} via OpenBooks`
  const html = shell({
    heading: `Sign in to ${esc(args.portalName)}`,
    bodyHtml: `<p>Hello,</p><p>Use the button below to sign in to ${esc(args.portalName)} at ${esc(args.orgName)}. It expires in ${esc(String(args.expiresMinutes))} minutes and works once — request a new one if it lapses.</p><p><a href="${esc(args.linkUrl)}">Sign in to ${esc(args.portalName)}</a></p><p>If you did not ask for this, ignore it: no account changes were made.</p>`,
    footer: `Sent by ${esc(args.orgName)} via OpenBooks.`,
  })
  return { subject, text, html }
}
