import "server-only";
import { z } from "zod";
import {
  deriveEmailDeliveryKey,
  emailDeliveryBlockedMessage,
  isEmailProvider,
  isValidEmailAddress,
  sendVia,
} from "@openbooks/emails";
import {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  readOrgEmailConfigView,
  resolveOrgEmailTransportDetailed,
  saveOrgEmailConfig,
  OrgEmailConfigConflictError,
} from "@openbooks/engine/delivery/email-config/module";
import { isDocumentRevisionToken } from "@openbooks/engine/records/revision";

export const emailSettingsFieldsSchema = z.object({
  enabled: z.boolean().optional().describe("Whether outbound email delivery is enabled."),
  expectedUpdatedAt: z
    .string()
    .max(64)
    .nullable()
    .optional()
    .describe("Exact org email settings revision returned by get_org_email_settings."),
  fromEmail: z
    .string()
    .max(320)
    .nullable()
    .optional()
    .describe("Sender email address; blank clears it."),
  fromName: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe("Sender display name; blank clears it."),
  mailgunDomain: z.string().max(255).nullable().optional().describe("Mailgun sending domain."),
  mailgunRegion: z.enum(["eu", "us"]).nullable().optional().describe("Mailgun region."),
  provider: z
    .enum(["resend", "sendgrid", "mailgun", "postmark", "smtp"])
    .nullable()
    .optional()
    .describe("Outbound email provider."),
  replyTo: z
    .string()
    .max(320)
    .nullable()
    .optional()
    .describe("Reply-to email address; blank clears it."),
  secret: z
    .string()
    .max(4000)
    .nullable()
    .optional()
    .describe("New provider credential, null clears it, omission preserves the sealed credential."),
  smtpHost: z.string().max(255).nullable().optional().describe("SMTP host."),
  smtpPort: z
    .union([z.number().int(), z.string().regex(/^\d+$/), z.null()])
    .optional()
    .describe("SMTP port."),
  smtpSecure: z.boolean().optional().describe("Whether SMTP uses TLS."),
  smtpUsername: z.string().max(255).nullable().optional().describe("SMTP username."),
});

export const emailSettingsBodySchema = emailSettingsFieldsSchema.refine(
  (body) => Object.keys(body).length > 0,
  "Provide an email setting to update or reload the page before saving",
);

export type EmailSettingsBody = z.infer<typeof emailSettingsBodySchema>;

export async function saveEmailSettingsAction(
  orgId: string,
  userId: string,
  body: EmailSettingsBody,
) {
  if (!isDocumentRevisionToken(body.expectedUpdatedAt))
    throw new OrgEmailConfigConflictError(body.expectedUpdatedAt ?? "", "");
  const clearableStr = (value: unknown) =>
    value === undefined
      ? undefined
      : value === null
        ? null
        : typeof value === "string"
          ? value.trim() || null
          : undefined;
  if (body.provider !== undefined && body.provider !== null && !isEmailProvider(body.provider))
    throw new Error("invalid provider");
  const saved = await saveOrgEmailConfig(
    orgId,
    {
      enabled: body.enabled,
      provider:
        body.provider === undefined
          ? undefined
          : isEmailProvider(body.provider)
            ? body.provider
            : null,
      fromName: clearableStr(body.fromName),
      fromEmail: clearableStr(body.fromEmail),
      replyTo: clearableStr(body.replyTo),
      mailgunDomain: clearableStr(body.mailgunDomain),
      mailgunRegion: body.mailgunRegion,
      smtpHost: clearableStr(body.smtpHost),
      smtpPort:
        body.smtpPort === undefined
          ? undefined
          : typeof body.smtpPort === "number"
            ? body.smtpPort
            : body.smtpPort
              ? Number(body.smtpPort)
              : null,
      smtpSecure: body.smtpSecure,
      smtpUsername: clearableStr(body.smtpUsername),
      secret:
        body.secret === null
          ? null
          : typeof body.secret === "string" && body.secret.trim()
            ? body.secret.trim()
            : undefined,
    },
    { kind: "user", userId },
    { expectedUpdatedAt: body.expectedUpdatedAt },
  );
  return saved;
}

export async function testEmailTransportAction(input: {
  orgId: string;
  userId: string;
  to: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { orgId, userId, to } = input;
  if (!isValidEmailAddress(to))
    return { status: 422, body: { error: "Enter a valid recipient email." } };
  const resolution = await resolveOrgEmailTransportDetailed(orgId);
  if (resolution.state !== "ready")
    return { status: 422, body: { error: emailDeliveryBlockedMessage(resolution) } };
  const transport = resolution.transport;
  const subject = "OpenBooks email test";
  const logId = await insertEmailLog({
    orgId,
    provider: transport.provider,
    recipients: [to],
    fromAddr: transport.from,
    replyToAddr: transport.replyTo ?? null,
    subject,
    status: "queued",
    categoryKey: "test",
    meta: { userId },
    actor: { kind: "user", userId },
  });
  try {
    const outcome = await sendVia(
      transport,
      {
        to,
        subject,
        text: `This is a test email from OpenBooks, sent via ${transport.provider}.`,
        html: `<p>This is a test email from OpenBooks, sent via <strong>${transport.provider}</strong>.</p>`,
      },
      { deliveryKey: deriveEmailDeliveryKey({ orgId, scope: `test:${logId}`, to }) },
    );
    if (outcome.kind === "sent") {
      await markEmailSent(orgId, logId, outcome.providerMessageId);
      return {
        status: 200,
        body: { ok: true, provider: transport.provider, messageId: outcome.providerMessageId },
      };
    }
    await markEmailUncertain(orgId, logId, outcome.reason);
    return { status: 422, body: { error: outcome.reason } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "send failed";
    await markEmailFailed(orgId, logId, message);
    return { status: 422, body: { error: message } };
  }
}

export async function readEmailSettingsAction(orgId: string) {
  return readOrgEmailConfigView(orgId);
}
