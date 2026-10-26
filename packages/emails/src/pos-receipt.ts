import { esc, shell, type EmailOut } from "./shell";

export type PosReceiptEmailLine = { description: string; quantity: string; amount: string };

export type PosReceiptEmail = {
  orgName: string;
  recipientName?: string | null;
  receiptNumber: string;
  kind: "sale" | "refund";
  date: string;
  currency: string;
  lines: PosReceiptEmailLine[];
  subtotal: string;
  tax: string;
  total: string;
  tenders: Array<{ label: string; amount: string }>;
  change?: string | null;
  header?: string | null;
  footer?: string | null;
};

/** A register receipt, emailed to the customer instead of (or as well as) printed. */
export function posReceiptEmail(args: PosReceiptEmail): EmailOut {
  const greeting = args.recipientName ? `Hello ${args.recipientName},` : "Hello,";
  const noun = args.kind === "refund" ? "refund receipt" : "receipt";
  const subject = `Your ${noun} ${args.receiptNumber} — ${args.orgName}`;
  const money = (value: string) => `${value} ${args.currency}`;
  // A receipt discounted or comped in full settles with no tender at all.
  const noCharge = args.tenders.length === 0 && /^0+(\.0+)?$/.test(args.total.trim());
  const textLines = [
    greeting,
    "",
    `Here is your ${noun} ${args.receiptNumber} from ${args.date}.`,
    ...(args.header ? ["", args.header] : []),
    "",
    ...args.lines.map((line) => `${line.quantity} × ${line.description}  ${money(line.amount)}`),
    "",
    `Subtotal  ${money(args.subtotal)}`,
    `Tax  ${money(args.tax)}`,
    `Total  ${money(args.total)}`,
    ...args.tenders.map((tender) => `${tender.label}  ${money(tender.amount)}`),
    ...(noCharge ? ["No charge"] : []),
    ...(args.change ? [`Change  ${money(args.change)}`] : []),
    ...(args.footer ? ["", args.footer] : []),
    "",
    `— ${args.orgName} via OpenBooks`,
  ];
  const row = (label: string, value: string, strong = false) =>
    `<tr><td style="padding:2px 0">${strong ? `<strong>${esc(label)}</strong>` : esc(label)}</td><td style="padding:2px 0;text-align:right">${strong ? `<strong>${esc(value)}</strong>` : esc(value)}</td></tr>`;
  const html = shell({
    heading: `${args.kind === "refund" ? "Refund receipt" : "Receipt"} ${esc(args.receiptNumber)}`,
    bodyHtml: `<p>${esc(greeting)}</p>
      <p>Here is your ${esc(noun)} from ${esc(args.date)}.</p>
      ${args.header ? `<p style="white-space:pre-line">${esc(args.header)}</p>` : ""}
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:12px 0">
        ${args.lines.map((line) => row(`${line.quantity} × ${line.description}`, money(line.amount))).join("")}
        <tr><td colspan="2" style="border-top:1px solid #ddd;padding-top:6px"></td></tr>
        ${row("Subtotal", money(args.subtotal))}
        ${row("Tax", money(args.tax))}
        ${row("Total", money(args.total), true)}
        ${args.tenders.map((tender) => row(tender.label, money(tender.amount))).join("")}
        ${noCharge ? row("No charge", "") : ""}
        ${args.change ? row("Change", money(args.change)) : ""}
      </table>
      ${args.footer ? `<p style="white-space:pre-line">${esc(args.footer)}</p>` : ""}`,
    footer: `Sent by ${args.orgName} via OpenBooks.`,
  });
  return { subject, text: textLines.join("\n"), html };
}
