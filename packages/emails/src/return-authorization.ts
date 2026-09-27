import { esc, shell, type EmailOut } from './shell'

type ReturnEmail = {
  orgName: string
  recipientName?: string | null
  rmaNumber: string
  customerCreditNumber?: string | null
  reason?: string | null
}

export function returnReceivedEmail(args: ReturnEmail): EmailOut {
  const greeting = args.recipientName ? `Hello ${args.recipientName},` : 'Hello,'
  const subject = `Return received — ${args.rmaNumber} — ${args.orgName}`
  const text = `${greeting}\n\nWe received the goods covered by return authorization ${args.rmaNumber}. Our team will inspect them and follow up with the outcome.\n\n— ${args.orgName} via OpenBooks`
  const html = shell({
    heading: `Return received: ${esc(args.rmaNumber)}`,
    bodyHtml: `<p>${esc(greeting)}</p><p>We received the goods covered by return authorization <strong>${esc(args.rmaNumber)}</strong>. Our team will inspect them and follow up with the outcome.</p>`,
    footer: `Sent by ${esc(args.orgName)} via OpenBooks.`,
  })
  return { subject, text, html }
}

export function returnDecisionEmail(args: ReturnEmail): EmailOut {
  const greeting = args.recipientName ? `Hello ${args.recipientName},` : 'Hello,'
  const rejected = Boolean(args.reason)
  const subject = rejected
    ? `Return authorization update — ${args.rmaNumber} — ${args.orgName}`
    : `Return inspected — ${args.rmaNumber} — ${args.orgName}`
  const outcome = rejected
    ? `The return authorization was not accepted. Reason: ${args.reason}`
    : `Inspection is complete${args.customerCreditNumber ? `; customer credit ${args.customerCreditNumber} has been issued` : ''}.`
  const text = `${greeting}\n\n${outcome}\nReturn authorization: ${args.rmaNumber}\n\n— ${args.orgName} via OpenBooks`
  const html = shell({
    heading: `Return update: ${esc(args.rmaNumber)}`,
    bodyHtml: `<p>${esc(greeting)}</p><p>${esc(outcome)}</p><p>Return authorization: <strong>${esc(args.rmaNumber)}</strong></p>`,
    footer: `Sent by ${esc(args.orgName)} via OpenBooks.`,
  })
  return { subject, text, html }
}
