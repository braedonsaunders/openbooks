import { sql } from "drizzle-orm";
import { deriveEmailDeliveryKey, quoteSignatureRequestEmail, sendVia } from "@openbooks/emails";
import { db } from "@openbooks/engine/platform/database";
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransport,
} from "@openbooks/engine/delivery/email-config";

/**
 * Quote signature delivery (route-side).
 *
 * The engine mints the signer's possession token and returns it; THIS module
 * performs the send web-side — the engine graph cannot reach the mail
 * transport. Email goes out when the org configured a transport; the token
 * link is always returned regardless, so a missing mailbox never blocks a
 * send — it just skips that channel by name.
 */

export interface QuoteSignatureDelivery {
  signUrl: string;
  emailed: boolean;
  emailSkippedReason: string | null;
}

function baseUrl(req: Request): string {
  const env = process.env.OPENBOOKS_APP_URL?.trim().replace(/\/+$/, "");
  if (env) return env;
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

async function orgName(orgId: string): Promise<string> {
  const row = (await db.execute<{ name: string }>(sql`
    select name from orgs where id = ${orgId}
  `)).rows[0];
  return row?.name ?? "Your organization";
}

/** Deliver the signing link for one quote signature request. */
export async function deliverQuoteSignature(args: {
  orgId: string;
  actorId: string;
  req: Request;
  quoteNumber: string;
  currency: string;
  totalContractValue: string;
  termMonths: number;
  token: string;
  signerName: string;
  signerEmail: string;
  expiresAt: Date;
}): Promise<QuoteSignatureDelivery> {
  const signUrl = `${baseUrl(args.req).replace(/\/$/, "")}/sign/quotes/${args.token}`;
  const email = quoteSignatureRequestEmail({
    orgName: await orgName(args.orgId),
    quoteNumber: args.quoteNumber,
    signerName: args.signerName,
    totalContractValue: args.totalContractValue,
    currency: args.currency,
    termMonths: args.termMonths,
    signUrl,
    expiresDate: args.expiresAt.toISOString().slice(0, 10),
  });
  const transport = await resolveOrgEmailTransport(args.orgId);
  if (!transport) {
    return { signUrl, emailed: false, emailSkippedReason: "Email delivery is not configured — set it up in Admin → Email" };
  }
  const logId = await insertEmailLog({
    orgId: args.orgId,
    jobId: null,
    provider: null,
    recipients: [args.signerEmail],
    fromAddr: null,
    replyToAddr: null,
    subject: email.subject,
    status: "queued",
    categoryKey: "quote.signature",
    meta: {},
    actor: { kind: "user", userId: args.actorId },
  });
  try {
    const outcome = await sendVia(
      transport,
      { to: args.signerEmail, subject: email.subject, html: email.html, text: email.text },
      { deliveryKey: deriveEmailDeliveryKey({ orgId: args.orgId, scope: `direct:${logId}`, to: args.signerEmail }) },
    );
    if (outcome.kind === "sent") {
      await markEmailSent(args.orgId, logId, outcome.providerMessageId);
      return { signUrl, emailed: true, emailSkippedReason: null };
    }
    await markEmailUncertain(args.orgId, logId, outcome.reason);
    return { signUrl, emailed: false, emailSkippedReason: `email acceptance is uncertain (${outcome.reason}) — the link above still works` };
  } catch (e) {
    await markEmailFailed(args.orgId, logId, e instanceof Error ? e.message : String(e));
    return { signUrl, emailed: false, emailSkippedReason: "email send threw — the link above still works" };
  }
}
