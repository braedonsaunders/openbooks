import { esc, shell, type EmailOut } from './shell'

type PaymentMethodSetupEmail = {
  orgName: string
  customerName: string
  linkUrl: string
}

/**
 * The hosted payment-method setup link sent to a customer contact. The
 * customer saves a card or bank mandate with the provider on the hosted
 * page; nothing is charged by opening or completing it.
 */
export function paymentMethodSetupEmail(args: PaymentMethodSetupEmail): EmailOut {
  const subject = `Set up a payment method for ${args.orgName}`
  const text = `Hello,\n\n${args.orgName} has asked you to save a payment method for ${args.customerName} so invoices can be collected automatically. Open the secure link below to save a card or bank account with our payment provider. Nothing is charged when you save it.\n\n${args.linkUrl}\n\nIf you were not expecting this, contact ${args.orgName} before using the link.\n\n— ${args.orgName} via OpenBooks`
  const html = shell({
    heading: 'Set up a payment method',
    bodyHtml: `<p>Hello,</p><p>${esc(args.orgName)} has asked you to save a payment method for ${esc(args.customerName)} so invoices can be collected automatically. Open the secure link below to save a card or bank account with our payment provider. Nothing is charged when you save it.</p><p><a href="${esc(args.linkUrl)}">Save a payment method</a></p><p>If you were not expecting this, contact ${esc(args.orgName)} before using the link.</p>`,
    footer: `Sent by ${esc(args.orgName)} via OpenBooks.`,
  })
  return { subject, text, html }
}
