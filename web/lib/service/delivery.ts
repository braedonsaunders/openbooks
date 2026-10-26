import "server-only";
import { sql } from "drizzle-orm";
import {
  deriveEmailDeliveryKey,
  emailDeliveryBlockedMessage,
  sendVia,
  serviceQuoteEmail,
} from "@openbooks/emails";
import { db } from "@openbooks/engine/platform/database";
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransportDetailed,
} from "@openbooks/engine/delivery/email-config";
import type { SentServiceQuote } from "@openbooks/engine/service/quotes";

/** The application origin links are built on: the configured URL, else the request's own. */
export function appBaseUrl(request: Request): string {
  const configured = process.env.OPENBOOKS_APP_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export interface ServiceLinkDelivery {
  readonly link: string;
  readonly emailed: boolean;
  readonly emailSkippedReason: string | null;
}

/**
 * Email a sent service quote's acceptance link through the organization's
 * native email delivery. The link is always returned, so a missing mailbox
 * never blocks sending; the reason it was not emailed is named instead.
 */
export async function deliverServiceQuote(input: {
  orgId: string;
  actorId: string;
  request: Request;
  sent: SentServiceQuote;
  quoteDocumentId: string;
  message?: string | null;
}): Promise<ServiceLinkDelivery> {
  const link = `${appBaseUrl(input.request)}/sign/service-quotes/${input.sent.token}`;
  const names = (
    await db.execute<{ orgName: string; memo: string | null }>(
      sql`select o.name as "orgName", d.memo from orgs o
    left join documents d on d.org_id = o.id and d.id = ${input.quoteDocumentId} where o.id = ${input.orgId}`,
      "objects",
    )
  )[0];
  const orgName = names?.orgName ?? "";
  const email = serviceQuoteEmail({
    orgName,
    recipientName: input.sent.signerName,
    quoteNumber: input.sent.quoteNumber,
    title: names?.memo?.trim() || input.sent.quoteNumber,
    total: input.sent.total,
    depositLabel: input.sent.depositLabel,
    link,
    expiresOn: input.sent.expiresAt.slice(0, 10),
    message: input.message ?? null,
  });
  const delivery = await resolveOrgEmailTransportDetailed(input.orgId);
  if (delivery.state !== "ready")
    return { link, emailed: false, emailSkippedReason: emailDeliveryBlockedMessage(delivery) };
  const logId = await insertEmailLog({
    orgId: input.orgId,
    recipients: [input.sent.signerEmail],
    subject: email.subject,
    status: "queued",
    categoryKey: "service",
    meta: { recordType: "quote", recordId: input.sent.requestId, event: "service_quote" },
    actor: { kind: "user", userId: input.actorId },
  });
  try {
    const outcome = await sendVia(
      delivery.transport,
      { to: input.sent.signerEmail, subject: email.subject, html: email.html, text: email.text },
      {
        deliveryKey: deriveEmailDeliveryKey({
          orgId: input.orgId,
          scope: `direct:${logId}`,
          to: input.sent.signerEmail,
        }),
      },
    );
    if (outcome.kind === "sent") {
      await markEmailSent(input.orgId, logId, outcome.providerMessageId);
      return { link, emailed: true, emailSkippedReason: null };
    }
    await markEmailUncertain(input.orgId, logId, outcome.reason);
    return {
      link,
      emailed: false,
      emailSkippedReason: `Email delivery is uncertain (${outcome.reason}); the link still works.`,
    };
  } catch (error) {
    await markEmailFailed(
      input.orgId,
      logId,
      error instanceof Error ? error.message : String(error),
    );
    return {
      link,
      emailed: false,
      emailSkippedReason: "The email could not be sent; the link still works.",
    };
  }
}
