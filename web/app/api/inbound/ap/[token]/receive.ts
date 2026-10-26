import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { db, withOrgContext } from "@openbooks/engine/platform/db";
import {
  beginInboundMessage,
  captureAttachments,
  consumeMailboxDelivery,
  finishInboundMessage,
  INBOUND_MESSAGE_LEASE_MINUTES,
  InboundEmailError,
  mailboxOwnerAuthority,
  parseInboundEmail,
  resolveMailboxByToken,
  senderAllowed,
  verifyInboundSignature,
  type InboundSignatureEvidence,
  type MailboxOwnerAuthority,
} from "@openbooks/engine/payables/ap-capture-service";
import { readBoundedBodyBytes } from "@/lib/bounded-body";
import {
  CAPTURE_MAX_BATCH_BYTES,
  captureIntakeRefusalReason,
  ingestCaptureFiles,
} from "../../../ap-capture/ingest";

/**
 * A provider envelope carries attachments base64-encoded (Postmark, generic
 * JSON) or as multipart parts: the cap admits a full capture batch in either
 * encoding plus the message text, and nothing larger is read.
 */
export const MAX_INBOUND_BYTES = Math.ceil((CAPTURE_MAX_BATCH_BYTES * 4) / 3) + 4 * 1024 * 1024;

export type InboundDeps = {
  resolveMailboxByToken: typeof resolveMailboxByToken;
  consumeMailboxDelivery: typeof consumeMailboxDelivery;
  beginInboundMessage: typeof beginInboundMessage;
  finishInboundMessage: typeof finishInboundMessage;
  authorizeMailboxOwner: (
    orgId: string,
    ownerId: string,
    subsidiaryId: string,
  ) => Promise<MailboxOwnerAuthority>;
  ingestCaptureFiles: typeof ingestCaptureFiles;
  withOrgContext: <T>(orgId: string, fn: () => Promise<T>) => Promise<T>;
  now?: () => Date;
};

const DEFAULT_DEPS: InboundDeps = {
  resolveMailboxByToken,
  consumeMailboxDelivery,
  beginInboundMessage,
  finishInboundMessage,
  authorizeMailboxOwner: (orgId, ownerId, subsidiaryId) =>
    mailboxOwnerAuthority(db, orgId, ownerId, subsidiaryId),
  ingestCaptureFiles,
  withOrgContext,
};

const SIGNATURE_CODES = new Set(["signature_required", "signature_invalid", "signature_replayed"]);

type RecordedOutcome = "captured" | "rejected_sender" | "no_attachments" | "duplicate" | "error";

/**
 * The webhook reply names the outcome class only. Detailed reasons (sender
 * addresses, file names, configuration and decoder errors) are recorded on
 * the message, where administrators read them in the inbox activity; the
 * sender's mail system never sees them.
 */
const REPLY_MESSAGES: Record<RecordedOutcome, string | null> = {
  captured: null,
  rejected_sender: "The sender is not allowed for this address.",
  no_attachments: "The message carries no bill attachment.",
  duplicate: "The message was already captured.",
  error: "The message was received but could not be captured.",
};

/**
 * Receive one inbound AP email for the address its token names.
 *
 * Order matters: an unknown token answers 404 with no detail before anything
 * is read; an inactive address refuses; the per-address rate limit and the
 * body cap apply before parsing; the provider signature is verified (and a
 * replayed signed token refused) before anything is logged. Every
 * authenticated delivery is then logged exactly once per message id with
 * what its signature established, the address owner's standing is re-checked,
 * and its attachments go through the same capture intake the upload button
 * uses. Sender, owner and attachment refusals are recorded outcomes answered
 * with 200, so providers do not retry a decision; a message another attempt
 * is still processing answers 409 so the provider retries after the lease.
 */
export async function receiveInboundApEmail(
  request: Request,
  token: string,
  deps: InboundDeps = DEFAULT_DEPS,
): Promise<NextResponse> {
  const mailbox = await deps.resolveMailboxByToken(token);
  if (!mailbox) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!mailbox.isActive)
    return NextResponse.json({ error: "This inbound address is inactive." }, { status: 403 });
  return deps.withOrgContext(mailbox.orgId, async () => {
    if (!(await deps.consumeMailboxDelivery(mailbox.orgId, mailbox.id))) {
      return NextResponse.json(
        { error: "Too many messages for this address; retry later." },
        { status: 429, headers: { "retry-after": "60" } },
      );
    }
    const bounded = await readBoundedBodyBytes(request, MAX_INBOUND_BYTES);
    if (!bounded.ok) {
      return bounded.reason === "too_large"
        ? NextResponse.json(
            { error: "The message exceeds the inbound size limit." },
            { status: 413 },
          )
        : NextResponse.json({ error: "The message body could not be read." }, { status: 400 });
    }
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    let email;
    let signature: InboundSignatureEvidence;
    try {
      email = await parseInboundEmail({
        contentType: headers["content-type"] ?? "",
        body: bounded.bytes,
        expectedProvider: mailbox.provider,
      });
      signature = verifyInboundSignature({
        provider: mailbox.provider,
        secret: mailbox.signingSecret,
        headers,
        rawBody: bounded.bytes,
        email,
        now: deps.now?.(),
      });
    } catch (error) {
      if (error instanceof InboundEmailError) {
        if (SIGNATURE_CODES.has(error.code))
          return NextResponse.json({ error: "invalid signature" }, { status: 401 });
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.code === "malformed" ? 400 : 422 },
        );
      }
      throw error;
    }
    let begun: Awaited<ReturnType<InboundDeps["beginInboundMessage"]>>;
    try {
      begun = await deps.beginInboundMessage({
        orgId: mailbox.orgId,
        mailboxId: mailbox.id,
        email,
        attachmentCount: email.attachments.length,
        signature,
        contentDigest: createHash("sha256").update(bounded.bytes).digest("hex"),
      });
    } catch (error) {
      if (error instanceof InboundEmailError && SIGNATURE_CODES.has(error.code)) {
        return NextResponse.json({ error: "invalid signature" }, { status: 401 });
      }
      throw error;
    }
    if (begun.status === "repeat") {
      if (begun.outcome === "received") {
        return NextResponse.json(
          { error: "This message is still being processed; retry later." },
          { status: 409, headers: { "retry-after": String(INBOUND_MESSAGE_LEASE_MINUTES * 60) } },
        );
      }
      return NextResponse.json({
        status: "duplicate",
        outcome: begun.outcome,
        captureIds: begun.captureItemIds,
      });
    }
    const attempt = begun.attempt;
    const finish = async (
      outcome: RecordedOutcome,
      reason: string | null,
      captureItemIds: string[] = [],
    ) => {
      await deps.finishInboundMessage({
        orgId: mailbox.orgId,
        id: begun.id,
        attempt,
        outcome,
        reason,
        captureItemIds,
      });
      const message = REPLY_MESSAGES[outcome];
      return NextResponse.json({
        status: outcome,
        captureIds: captureItemIds,
        ...(message ? { message } : {}),
      });
    };
    try {
      if (!senderAllowed(email.from, mailbox.allowedSenders)) {
        return await finish(
          "rejected_sender",
          email.from
            ? `${email.from} is not an allowed sender for this address`
            : "The message names no sender",
        );
      }
      const attachments = captureAttachments(email.attachments);
      if (attachments.length === 0) {
        return await finish(
          "no_attachments",
          email.attachments.length ? "No attachment is a PDF, image or XML invoice" : null,
        );
      }
      // Captures are attributed to the owner, so the owner's standing is
      // re-checked on every delivery: an owner who left, lost AP create or
      // lost access to the address's entity refuses with the remedy.
      const owner = await deps.authorizeMailboxOwner(
        mailbox.orgId,
        mailbox.ownerId,
        mailbox.subsidiaryId,
      );
      if (!owner.ok) return await finish("error", owner.message);
      const intake = await deps.ingestCaptureFiles({
        orgId: mailbox.orgId,
        actorId: mailbox.ownerId,
        // The address's entity intersected with the owner's current access:
        // extraction and any auto-created draft stay within it.
        allowedSubsidiaryIds: owner.allowedSubsidiaryIds,
        subsidiaryId: mailbox.subsidiaryId,
        source: "email",
        files: attachments,
        skipKnownContent: true,
        evidence: { inboundMessageId: begun.id, from: email.from, subject: email.subject },
      });
      if (!intake.ok) return await finish("error", captureIntakeRefusalReason(intake));
      const created = intake.ids;
      if (created.length > 0) {
        const failed = intake.results.filter((result) => result.status === "failed");
        return await finish(
          "captured",
          failed.length
            ? `${failed.length} attachment(s) could not be stored or queued: ${failed.map((result) => result.filename).join(", ")}`
            : null,
          created,
        );
      }
      if (intake.results.every((result) => result.status === "duplicate")) {
        return await finish("duplicate", "Every attachment is already captured");
      }
      return await finish("error", "No attachment could be stored or queued");
    } catch (error) {
      // The outcome must still be recorded: a provider retry finds this
      // message logged and is answered with the same refusal.
      const reason = error instanceof Error ? error.message.slice(0, 500) : "Processing failed";
      await deps
        .finishInboundMessage({
          orgId: mailbox.orgId,
          id: begun.id,
          attempt,
          outcome: "error",
          reason,
        })
        .catch(() => undefined);
      throw error;
    }
  });
}
