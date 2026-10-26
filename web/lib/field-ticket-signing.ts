import "server-only";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { db, withOrg } from "@openbooks/engine/platform/db";
import { deriveEmailDeliveryKey, sendVia, emailDeliveryBlockedMessage } from "@openbooks/emails";
import {
  insertEmailLog,
  markEmailFailed,
  markEmailUncertain,
  markEmailSent,
  resolveOrgEmailTransportDetailed,
} from "@openbooks/engine/delivery/email-config/module";
import { mintSigningToken, signingTokenDigest } from "./field-ticket-token";
import { FieldTicketError, lockTicketLifecycleRevision } from "./field-tickets";
import { resolvePdfTemplate } from "./pdf-templates/store";
import { mergeAndPrintPdf } from "./pdf-templates/render";
import { loadPdfRecordValues } from "./pdf-templates/values";

/**
 * Send an approved ticket to the customer for signature: the email carries the
 * ticket PDF and a possession-authenticated signing link (14-day HMAC token).
 * Kept out of field-tickets.ts to avoid an import cycle with the PDF value
 * loader.
 */
export async function sendTicketForSignature(args: {
  orgId: string;
  userId: string;
  ticketId: string;
  expectedRevision: string;
  to: string;
  message?: string | null;
  appBaseUrl: string;
  /**
   * The sender's subsidiary scope, enforced inside the ticket load — the
   * attached PDF must never render a legal entity hidden from the sender.
   */
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<{ to: string }> {
  const lockApproved = async () => {
    const row = await lockTicketLifecycleRevision(
      args.orgId,
      args.userId,
      args.ticketId,
      args.expectedRevision,
      args.allowedSubsidiaryIds,
    );
    if (row.status !== "approved")
      throw new FieldTicketError("Approve the ticket before sending it for signature");
    return row;
  };
  const row = await withOrg(args.orgId, lockApproved);
  const to = args.to.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to))
    throw new FieldTicketError("A valid recipient email is required");

  const [tpl, record, delivery, org] = await Promise.all([
    resolvePdfTemplate(args.orgId, "field_ticket", null),
    loadPdfRecordValues("field_ticket", args.orgId, args.ticketId, args.allowedSubsidiaryIds),
    resolveOrgEmailTransportDetailed(args.orgId),
    db.execute<{ name: string }>(sql`select name from orgs where id = ${args.orgId}`, "objects"),
  ]);
  if (!tpl || !record) throw new FieldTicketError("Could not render the ticket PDF");
  if (delivery.state !== "ready") throw new FieldTicketError(emailDeliveryBlockedMessage(delivery));
  const transport = delivery.transport;

  const requestId = randomUUID();
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const token = mintSigningToken(args.orgId, args.ticketId, requestId, expiresAt);
  const signUrl = `${args.appBaseUrl.replace(/\/$/, "")}/sign/field-tickets/${token}`;
  const orgName = org[0]?.name ?? "OpenBooks";
  const subject = `${orgName} — timesheet ${row.document_number} for your approval`;
  const messageHtml = args.message
    ? `<p style="margin:0 0 16px;color:#334155;font-size:14px;line-height:1.6;">${args.message
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</p>`
    : "";
  const html =
    `<div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;">` +
    `<h2 style="margin:0 0 4px;font-size:18px;color:#0f172a;">${orgName}</h2>` +
    `<p style="margin:0 0 16px;color:#64748b;font-size:13px;">Field ticket ${row.document_number}</p>` +
    messageHtml +
    `<p style="margin:0 0 16px;color:#334155;font-size:14px;line-height:1.6;">Please review the attached timesheet and sign it online:</p>` +
    `<p style="margin:0 0 20px;"><a href="${signUrl}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:10px 22px;border-radius:6px;font-size:14px;font-weight:600;">Review &amp; sign</a></p>` +
    `<p style="margin:0;color:#94a3b8;font-size:12px;">The link is valid for 14 days. If the button doesn't work, copy this address:<br/>${signUrl}</p>` +
    `</div>`;
  const text = `${orgName} — field ticket ${row.document_number}\n\n${args.message ?? ""}\n\nReview and sign: ${signUrl}\n(The link is valid for 14 days.)`;

  const stamp = await businessToday(args.orgId);
  const attachmentName = `Field-Ticket-${row.document_number}-${stamp}.pdf`;
  const pdf = await mergeAndPrintPdf(tpl, record.values);

  const logId = await withOrg(args.orgId, async () => {
    // The rendered attachment and retained signing request must describe the same reviewed version.
    await lockApproved();
    const logId = await insertEmailLog({
      orgId: args.orgId,
      recipients: [to],
      subject,
      status: "queued",
      categoryKey: "document",
      meta: {
        recordType: "field_ticket",
        recordId: args.ticketId,
        purpose: "signature_request",
        documentRevision: args.expectedRevision,
      },
      actor: { kind: "user", userId: args.userId },
    });
    const request = await db.execute<{ id: string }>(
      sql`
      insert into field_ticket_signature_requests
        (id, org_id, field_ticket_id, recipient, message, sent_at, expires_at,
         token_digest, email_log_id, created_by)
      values (${requestId}, ${args.orgId}, ${args.ticketId}, ${to},
              ${args.message ?? null}, null, ${expiresAt.toISOString()},
              ${signingTokenDigest(token)}, ${logId}, ${args.userId})
      returning id
    `,
      "objects",
    );
    if (request.length !== 1)
      throw new FieldTicketError(
        "The signature request was not saved; reload the ticket and retry",
      );
    return logId;
  });
  let providerMessageId: string;
  try {
    const outcome = await sendVia(
      transport,
      {
        to,
        subject,
        html,
        text,
        attachments: [
          {
            filename: attachmentName,
            content: pdf.toString("base64"),
            contentType: "application/pdf",
          },
        ],
        // The log row scope keeps this direct send's identity durable and
        // distinct from every other send to the same mailbox.
      },
      { deliveryKey: deriveEmailDeliveryKey({ orgId: args.orgId, scope: `direct:${logId}`, to }) },
    );
    if (outcome.kind === "sent") {
      providerMessageId = outcome.providerMessageId;
    } else {
      // Acceptance unknown: the request email may still arrive. Fail closed —
      // the signing token is revoked and the log keeps its uncertainty.
      await markEmailUncertain(args.orgId, logId, outcome.reason);
      throw new Error(outcome.reason);
    }
  } catch (e) {
    await markEmailFailed(args.orgId, logId, e instanceof Error ? e.message : String(e));
    await db.execute(sql`
      update field_ticket_signature_requests
         set revoked_at = coalesce(revoked_at, now())
       where id = ${requestId} and org_id = ${args.orgId}
    `);
    throw e;
  }
  await markEmailSent(args.orgId, logId, providerMessageId);
  await db.execute(sql`
    update field_ticket_signature_requests
       set sent_at = now()
     where id = ${requestId} and org_id = ${args.orgId}
       and sent_at is null and revoked_at is null
  `);

  return { to };
}
