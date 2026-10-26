import { esc, shell, type EmailOut } from "./shell";

const button = (href: string, label: string) =>
  `<p style="margin:16px 0"><a href="${esc(href)}" style="display:inline-block;background:#0f766e;color:#ffffff;padding:10px 18px;border-radius:10px;text-decoration:none;font-weight:600">${esc(label)}</a></p><p style="font-size:12px;color:#666;word-break:break-all">${esc(href)}</p>`;

/**
 * The arrival window of a booked service visit, sent to the customer's site
 * contact when the organization opts in to arrival-window notices.
 */
export function serviceVisitArrivalWindowEmail(args: {
  orgName: string;
  recipientName?: string | null;
  jobNumber: string;
  jobTitle: string;
  serviceAddress?: string | null;
  /** The window as the customer reads it, already formatted in the business time zone. */
  windowLabel: string;
  technicianNames?: readonly string[];
}): EmailOut {
  const subject = `Your service visit is booked — ${args.jobNumber} — ${args.orgName}`;
  const greeting = args.recipientName ? `Hello ${args.recipientName},` : "Hello,";
  const who = args.technicianNames?.length
    ? ` ${args.technicianNames.join(", ")} will arrive`
    : " We will arrive";
  const text =
    `${greeting}\n\n` +
    `Your visit for ${args.jobTitle} (${args.jobNumber}) is booked.${who} ${args.windowLabel}.\n` +
    (args.serviceAddress ? `Service location: ${args.serviceAddress}\n` : "") +
    `\n— ${args.orgName} via OpenBooks`;
  const html = shell({
    heading: `Visit booked: ${args.jobTitle}`,
    bodyHtml: `
      <p>${esc(greeting)}</p>
      <p>Your visit for <strong>${esc(args.jobTitle)}</strong> (${esc(args.jobNumber)}) is booked.${esc(who)} <strong>${esc(args.windowLabel)}</strong>.</p>
      ${args.serviceAddress ? `<p>Service location: ${esc(args.serviceAddress)}</p>` : ""}
      <p style="color:#666">${esc(args.orgName)} · OpenBooks</p>`,
    footer: `Sent by ${args.orgName} via OpenBooks.`,
  });
  return { subject, html, text };
}

/** The technician is on the way, sent when the organization opts in to on-my-way notices. */
export function serviceVisitOnTheWayEmail(args: {
  orgName: string;
  recipientName?: string | null;
  jobNumber: string;
  jobTitle: string;
  technicianName?: string | null;
  /** Expected arrival as the customer reads it, already formatted. */
  arrivalLabel?: string | null;
}): EmailOut {
  const subject = `Your technician is on the way — ${args.jobNumber} — ${args.orgName}`;
  const greeting = args.recipientName ? `Hello ${args.recipientName},` : "Hello,";
  const who = args.technicianName ? `${args.technicianName} is` : "Your technician is";
  const when = args.arrivalLabel ? ` Expected arrival: ${args.arrivalLabel}.` : "";
  const text = `${greeting}\n\n${who} on the way for ${args.jobTitle} (${args.jobNumber}).${when}\n\n— ${args.orgName} via OpenBooks`;
  const html = shell({
    heading: "On the way",
    bodyHtml: `
      <p>${esc(greeting)}</p>
      <p>${esc(who)} on the way for <strong>${esc(args.jobTitle)}</strong> (${esc(args.jobNumber)}).${esc(when)}</p>
      <p style="color:#666">${esc(args.orgName)} · OpenBooks</p>`,
    footer: `Sent by ${args.orgName} via OpenBooks.`,
  });
  return { subject, html, text };
}

/** A service quote to review, choose add-ons on and accept with a signature. */
export function serviceQuoteEmail(args: {
  orgName: string;
  recipientName?: string | null;
  quoteNumber: string;
  title: string;
  total: string;
  depositLabel?: string | null;
  link: string;
  expiresOn: string;
  message?: string | null;
}): EmailOut {
  const subject = `Quote ${args.quoteNumber} from ${args.orgName}`;
  const greeting = args.recipientName ? `Hello ${args.recipientName},` : "Hello,";
  const msg = args.message?.trim();
  const deposit = args.depositLabel
    ? ` A deposit of ${args.depositLabel} is due on acceptance.`
    : "";
  const text =
    `${greeting}\n\n` +
    (msg ? `${msg}\n\n` : "") +
    `Quote ${args.quoteNumber} for ${args.title} totals ${args.total}.${deposit}\n` +
    `Review it, choose any optional add-ons and accept it here by ${args.expiresOn}: ${args.link}\n\n— ${args.orgName} via OpenBooks`;
  const html = shell({
    heading: `Quote ${args.quoteNumber}`,
    bodyHtml: `
      <p>${esc(greeting)}</p>
      ${msg ? `<p style="white-space:pre-wrap">${esc(msg)}</p>` : ""}
      <p>Quote <strong>${esc(args.quoteNumber)}</strong> for <strong>${esc(args.title)}</strong> totals <strong>${esc(args.total)}</strong>.${esc(deposit)}</p>
      <p>Review it, choose any optional add-ons and accept it by ${esc(args.expiresOn)}.</p>
      ${button(args.link, "Review and accept")}
      <p style="color:#666">${esc(args.orgName)} · OpenBooks</p>`,
    footer: `Sent by ${args.orgName} via OpenBooks.`,
  });
  return { subject, html, text };
}

/** A link for the customer to sign off a completed service visit. */
export function serviceVisitSignatureEmail(args: {
  orgName: string;
  recipientName?: string | null;
  jobNumber: string;
  jobTitle: string;
  link: string;
  expiresOn: string;
}): EmailOut {
  const subject = `Please sign off your service visit — ${args.jobNumber} — ${args.orgName}`;
  const greeting = args.recipientName ? `Hello ${args.recipientName},` : "Hello,";
  const text = `${greeting}\n\nPlease review and sign off the work done for ${args.jobTitle} (${args.jobNumber}) by ${args.expiresOn}: ${args.link}\n\n— ${args.orgName} via OpenBooks`;
  const html = shell({
    heading: "Sign off your service visit",
    bodyHtml: `
      <p>${esc(greeting)}</p>
      <p>Please review and sign off the work done for <strong>${esc(args.jobTitle)}</strong> (${esc(args.jobNumber)}) by ${esc(args.expiresOn)}.</p>
      ${button(args.link, "Review and sign")}
      <p style="color:#666">${esc(args.orgName)} · OpenBooks</p>`,
    footer: `Sent by ${args.orgName} via OpenBooks.`,
  });
  return { subject, html, text };
}
