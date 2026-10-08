import { esc, shell, type EmailOut } from './shell'

type BillingReviewRequestEmail = {
  orgName: string
  portalName: string
  partyName: string | null
  reference: string
  projectName: string
  periodLabel: string
  amount: string
  reviewUrl: string
  expiresDays: number
  message?: string
}

/**
 * Invitation to review a billing package in the customer portal before it is
 * invoiced. The link signs the contact in once; the package itself lives in
 * the portal, where the customer accepts it or disputes individual lines.
 */
export function billingReviewRequestEmail(args: BillingReviewRequestEmail): EmailOut {
  const greeting = args.partyName ? `Hello ${args.partyName},` : 'Hello,'
  const subject = `Billing for review: ${args.projectName} (${args.reference}) — ${args.orgName}`
  const note = args.message?.trim() ? `${args.message.trim()}\n\n` : ''
  const text = `${greeting}\n\n${note}${args.orgName} has prepared billing for ${args.projectName} covering ${args.periodLabel}, totalling ${args.amount}. Please review the detail and accept it, or tell us which lines need attention, before it is invoiced.\n\n${args.reviewUrl}\n\nThis link signs you in to ${args.portalName} once and expires in ${args.expiresDays} days. You can always request a fresh sign-in link from the portal.\n\n— ${args.orgName} via OpenBooks`
  const html = shell({
    heading: `Billing ready for your review`,
    bodyHtml: `<p>${esc(greeting)}</p>${args.message?.trim() ? `<p>${esc(args.message.trim())}</p>` : ''}<p>${esc(args.orgName)} has prepared billing for <strong>${esc(args.projectName)}</strong> covering ${esc(args.periodLabel)}, totalling <strong>${esc(args.amount)}</strong>.</p><p>Please review the detail and accept it, or tell us which lines need attention, before it is invoiced.</p><p><a href="${esc(args.reviewUrl)}">Review billing ${esc(args.reference)}</a></p><p>This link signs you in to ${esc(args.portalName)} once and expires in ${esc(String(args.expiresDays))} days. You can always request a fresh sign-in link from the portal.</p>`,
    footer: `Sent by ${esc(args.orgName)} via OpenBooks.`,
  })
  return { subject, text, html }
}
