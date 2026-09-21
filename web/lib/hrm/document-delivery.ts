import { sql } from "drizzle-orm";
import {
  deriveEmailDeliveryKey,
  hrmSignatureRequestEmail,
  hrmSurveyInvitationEmail,
  sendVia,
} from "@openbooks/emails";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransport,
} from "@openbooks/engine/src/delivery/email-config.ts";
import { writeNotification } from "@openbooks/engine/src/inbox/adapters/notification.ts";

/**
 * HR-19 invitation delivery (route-side).
 *
 * The engine services open signer/invitation rows and return delivery
 * intents (email, user, token); THIS module performs the sends web-side —
 * the engine graph cannot reach the inbox or the mail transport. Every
 * recipient gets an in-app notification when they hold a login; email
 * goes out when an address resolves and the org configured a transport.
 * The token link is always returned to HR regardless, so a missing
 * mailbox never blocks a send — it just skips that channel by name in
 * the per-recipient result.
 */

export interface DeliveryRecipient {
  partyId: string;
  email: string | null;
  userId: string | null;
  token: string;
}

export interface DeliveryResult {
  partyId: string;
  notified: boolean;
  emailed: boolean;
  emailSkippedReason: string | null;
}

async function partyName(orgId: string, partyId: string): Promise<string | null> {
  const row = (await db.execute<{ name: string }>(sql`
    select coalesce(display_name, legal_name, 'Unnamed') as name
      from parties where org_id = ${orgId} and id = ${partyId}
  `)).rows[0];
  return row?.name ?? null;
}

async function orgName(orgId: string): Promise<string> {
  const row = (await db.execute<{ name: string }>(sql`
    select name from orgs where id = ${orgId}
  `)).rows[0];
  return row?.name ?? "Your organization";
}

async function sendEmail(args: {
  orgId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  scope: string;
}): Promise<{ sent: boolean; skippedReason: string | null }> {
  const transport = await resolveOrgEmailTransport(args.orgId);
  if (!transport) {
    return { sent: false, skippedReason: "Email delivery is not configured — set it up in Admin → Email" };
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(args.to)) {
    return { sent: false, skippedReason: "no valid recipient email — the signing link below still works" };
  }
  const logId = await insertEmailLog({
    orgId: args.orgId,
    jobId: null,
    provider: null,
    recipients: [args.to],
    fromAddr: null,
    replyToAddr: null,
    subject: args.subject,
    status: "queued",
    categoryKey: "hrm.invitation",
    meta: {},
  });
  try {
    const outcome = await sendVia(
      transport,
      { to: args.to, subject: args.subject, html: args.html, text: args.text },
      { deliveryKey: deriveEmailDeliveryKey({ orgId: args.orgId, scope: `direct:${logId}`, to: args.to }) },
    );
    if (outcome.kind === "sent") {
      await markEmailSent(args.orgId, logId, outcome.providerMessageId);
      return { sent: true, skippedReason: null };
    }
    // Uncertain acceptance is fail-closed and named, never retried blind:
    // the link below still works and the log carries the reason.
    await markEmailUncertain(args.orgId, logId, outcome.reason);
    return { sent: false, skippedReason: `email acceptance is uncertain (${outcome.reason}) — the link below still works` };
  } catch (e) {
    await markEmailFailed(args.orgId, logId, e instanceof Error ? e.message : String(e));
    return { sent: false, skippedReason: "email send threw — the link below still works" };
  }
}

/** Deliver ordered signature invitations (send + remind share this). */
export async function deliverSignatureInvitations(args: {
  orgId: string;
  actorId: string;
  appBaseUrl: string;
  docTitle: string;
  expiresDate?: string;
  recipients: DeliveryRecipient[];
  reminder?: boolean;
}): Promise<DeliveryResult[]> {
  const org = await orgName(args.orgId);
  const results: DeliveryResult[] = [];
  for (const recipient of args.recipients) {
    const name = await partyName(args.orgId, recipient.partyId);
    const signUrl = `${args.appBaseUrl.replace(/\/$/, "")}/sign/${recipient.token}`;
    const email = hrmSignatureRequestEmail({
      orgName: org,
      docTitle: args.reminder ? `${args.docTitle} (reminder)` : args.docTitle,
      signerName: name ?? undefined,
      signUrl,
      expiresDate: args.expiresDate,
    });
    let emailed = false;
    let skipped: string | null = "no email address on file — the signing link below still works";
    if (recipient.email) {
      const sent = await sendEmail({
        orgId: args.orgId,
        to: recipient.email,
        subject: email.subject,
        html: email.html,
        text: email.text,
        scope: "hrm-signature",
      });
      emailed = sent.sent;
      skipped = sent.skippedReason;
    }
    let notified = false;
    if (recipient.userId) {
      await writeNotification(db, {
        orgId: args.orgId,
        userId: recipient.userId,
        kind: args.reminder ? "hrm.document.reminder" : "hrm.document.signature",
        title: args.reminder ? `Reminder: sign ${args.docTitle}` : `Signature requested: ${args.docTitle}`,
        body: `${org} asks you to sign ${args.docTitle}. Open the document to review and sign.${emailed ? "" : " The signing link is with HR."}`,
        href: `/me/documents`,
        actorId: args.actorId,
      });
      notified = true;
    }
    results.push({ partyId: recipient.partyId, notified, emailed, emailSkippedReason: emailed ? null : skipped });
  }
  return results;
}

/** Deliver survey invitations. */
export async function deliverSurveyInvitations(args: {
  orgId: string;
  actorId: string;
  appBaseUrl: string;
  surveyName: string;
  anonymity: string;
  closesDate?: string;
  recipients: DeliveryRecipient[];
}): Promise<DeliveryResult[]> {
  const org = await orgName(args.orgId);
  const results: DeliveryResult[] = [];
  for (const recipient of args.recipients) {
    const name = await partyName(args.orgId, recipient.partyId);
    const respondUrl = `${args.appBaseUrl.replace(/\/$/, "")}/survey/${recipient.token}`;
    const email = hrmSurveyInvitationEmail({
      orgName: org,
      surveyName: args.surveyName,
      anonymity: args.anonymity,
      respondentName: name ?? undefined,
      respondUrl,
      closesDate: args.closesDate,
    });
    let emailed = false;
    let skipped: string | null = "no email address on file — the response link is with HR";
    if (recipient.email) {
      const sent = await sendEmail({
        orgId: args.orgId,
        to: recipient.email,
        subject: email.subject,
        html: email.html,
        text: email.text,
        scope: "hrm-survey",
      });
      emailed = sent.sent;
      skipped = sent.skippedReason;
    }
    let notified = false;
    if (recipient.userId) {
      await writeNotification(db, {
        orgId: args.orgId,
        userId: recipient.userId,
        kind: "hrm.survey.invitation",
        title: `Survey invitation: ${args.surveyName}`,
        body: `${org} invites you to respond to ${args.surveyName} (${args.anonymity}). One response per invitation.`,
        href: `/me`,
        actorId: args.actorId,
      });
      notified = true;
    }
    results.push({ partyId: recipient.partyId, notified, emailed, emailSkippedReason: emailed ? null : skipped });
  }
  return results;
}
