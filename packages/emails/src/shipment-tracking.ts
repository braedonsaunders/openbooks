import { esc, shell, type EmailOut } from './shell'

/**
 * Tracking notice for a completed shipment, sent to the customer on the
 * operator's request. The tracking link comes from the carrier's template;
 * without one the number is shown on its own.
 */
export function shipmentTrackingEmail(args: {
  orgName: string
  shipmentNumber: string
  orderNumber?: string
  partyName?: string
  carrierName: string
  service: string
  trackingNumber: string
  trackingUrl?: string
  message?: string
}): EmailOut {
  const subject = `Your order has shipped — ${args.shipmentNumber} — ${args.orgName}`
  const greeting = args.partyName ? `Hello ${args.partyName},` : 'Hello,'
  const msg = args.message?.trim()
  const order = args.orderNumber ? ` for order ${args.orderNumber}` : ''
  const text =
    `${greeting}\n\n` +
    (msg ? `${msg}\n\n` : '') +
    `Shipment ${args.shipmentNumber}${order} is on its way with ${args.carrierName} (${args.service}).\n` +
    `Tracking number: ${args.trackingNumber}\n` +
    (args.trackingUrl ? `Track it: ${args.trackingUrl}\n` : '') +
    `\n— ${args.orgName} via OpenBooks`
  const html = shell({
    heading: `Shipment ${args.shipmentNumber}`,
    bodyHtml: `
      <p>${esc(greeting)}</p>
      ${msg ? `<p style="white-space:pre-wrap">${esc(msg)}</p>` : ''}
      <p>Shipment <strong>${esc(args.shipmentNumber)}</strong>${esc(order)} is on its way with <strong>${esc(args.carrierName)}</strong> (${esc(args.service)}).</p>
      <p>Tracking number: <strong>${esc(args.trackingNumber)}</strong></p>
      ${args.trackingUrl ? `<p style="margin:16px 0"><a href="${esc(args.trackingUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:600">Track shipment</a></p><p style="font-size:12px;color:#666;word-break:break-all">${esc(args.trackingUrl)}</p>` : ''}
      <p style="color:#666">${esc(args.orgName)} · OpenBooks</p>`,
    footer: `Sent by ${args.orgName} via OpenBooks.`,
  })
  return { subject, html, text }
}
