import { Worker } from "bullmq";
import {
  STATEMENT_BATCH_QUEUE,
  assertStatementBatchJob,
  getBlockingConnection,
  statementBatchEmailScope,
  type StatementBatchJobData,
} from "@openbooks/jobs";
import {
  deriveEmailDeliveryKey,
  documentEmail,
  emailDeliveryBlockedMessage,
  reconcileDeliveryAttempts,
  sendVia,
  type EmailTransport,
} from "@openbooks/emails";
import {
  appendEmailAttemptEvent,
  claimEmailDeliveryLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransportDetailed,
} from "../delivery/email-config.ts";
import { withOrgContext } from "../platform/db.ts";
import {
  claimStatementBatchItem,
  getStatementBatchRun,
  settleStatementBatchItemFailed,
  settleStatementBatchItemSent,
} from "../receivables/statement-batches.ts";
import { appBaseUrl } from "./render-client.ts";

/**
 * Batched customer statements: one job renders one customer's statement PDF
 * (through the web app's internal render endpoint — rendering lives in
 * web/lib, which the engine cannot import) and sends it through the native
 * email delivery, the same sendVia + email_log path as the single send.
 *
 * Idempotency per (run, customer): a sent or skipped item never transmits
 * again, and the email delivery key is stable per (run, mailbox), so a
 * retried job collapses onto the same email_log row — prior acceptance
 * closes it, prior uncertainty suppresses a blind re-send, and only clean
 * lineage transmits.
 */

export interface StatementBatchRender {
  pdf: Buffer;
  attachmentName: string;
  orgName: string;
  reference: string;
}

export type StatementBatchRenderer = (
  orgId: string,
  runId: string,
  partyId: string,
) => Promise<StatementBatchRender>;

export interface StatementBatchTransmitInput {
  orgId: string;
  transport: EmailTransport;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachment: { filename: string; content: string; contentType: string };
  deliveryKey: string;
  senderId: string;
  partyId: string;
  runId: string;
}

export type StatementBatchTransmitter = (
  input: StatementBatchTransmitInput,
) => Promise<{ emailLogId: string; alreadySent: boolean }>;

/** Production render: the internal statements endpoint returns the PDF with its naming headers. */
export async function renderStatementBatchPdf(
  orgId: string,
  runId: string,
  partyId: string,
): Promise<StatementBatchRender> {
  const qs = new URLSearchParams({ orgId, runId, partyId });
  const res = await fetch(`${appBaseUrl()}/api/internal/statements/render?${qs.toString()}`, {
    redirect: "error",
    headers: { "x-internal-token": process.env.OPENBOOKS_INTERNAL_TOKEN || "" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`statement render failed: HTTP ${res.status} ${detail}`.slice(0, 300));
  }
  const pdf = Buffer.from(await res.arrayBuffer());
  if (pdf.length === 0)
    throw new Error("statement render returned an empty document — nothing was sent");
  const header = (name: string, fallback: string): string => {
    const raw = res.headers.get(name)?.trim();
    if (!raw) return fallback;
    try {
      return decodeURIComponent(raw);
    } catch {
      return fallback;
    }
  };
  return {
    pdf,
    attachmentName: header("x-statement-filename", `statement-${partyId}.pdf`),
    orgName: header("x-statement-org", "OpenBooks"),
    reference: header("x-statement-reference", ""),
  };
}

/** Production transmit: claim the canonical log row, reconcile its lineage, and send only on clean lineage. */
export async function transmitStatementBatchEmail(
  input: StatementBatchTransmitInput,
): Promise<{ emailLogId: string; alreadySent: boolean }> {
  const claim = await claimEmailDeliveryLog({
    orgId: input.orgId,
    deliveryKey: input.deliveryKey,
    recipients: [input.to],
    subject: input.subject,
    categoryKey: "statement",
    meta: { partyId: input.partyId, side: "ar", runId: input.runId },
    actor: { kind: "user", userId: input.senderId },
  });
  if (claim.status === "sent") return { emailLogId: claim.id, alreadySent: true };
  const reconciliation = reconcileDeliveryAttempts(claim.attempts);
  if (reconciliation.action === "complete") {
    return { emailLogId: claim.id, alreadySent: true };
  }
  if (reconciliation.action === "suppress") {
    await appendEmailAttemptEvent(input.orgId, claim.id, {
      outcome: "blocked",
      detail: reconciliation.reason,
    });
    throw new StatementBatchSuppressed(reconciliation.reason, claim.id);
  }
  await appendEmailAttemptEvent(input.orgId, claim.id, { outcome: "started" });
  try {
    const outcome = await sendVia(
      input.transport,
      {
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        attachments: [input.attachment],
      },
      { deliveryKey: input.deliveryKey },
    );
    if (outcome.kind === "sent") {
      await markEmailSent(input.orgId, claim.id, outcome.providerMessageId);
      await appendEmailAttemptEvent(input.orgId, claim.id, {
        outcome: "sent",
        detail: outcome.providerMessageId,
      });
      return { emailLogId: claim.id, alreadySent: false };
    }
    await markEmailUncertain(input.orgId, claim.id, outcome.reason);
    await appendEmailAttemptEvent(input.orgId, claim.id, {
      outcome: "uncertain",
      detail: outcome.reason,
    });
    throw new StatementBatchSuppressed(outcome.reason, claim.id);
  } catch (e) {
    if (e instanceof StatementBatchSuppressed) throw e;
    await markEmailFailed(input.orgId, claim.id, e instanceof Error ? e.message : String(e));
    await appendEmailAttemptEvent(input.orgId, claim.id, {
      outcome: "notSent",
      detail: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

/**
 * A suppressed send: the row stands as failed evidence (never silently
 * dropped), but the job is acked — BullMQ retries cannot clear an
 * uncertainty or a missing transport, so they would only re-record it.
 */
export class StatementBatchSuppressed extends Error {
  readonly emailLogId: string | null;
  constructor(reason: string, emailLogId: string | null) {
    super(reason);
    this.name = "StatementBatchSuppressed";
    this.emailLogId = emailLogId;
  }
}

export interface StatementBatchDeps {
  renderPdf?: StatementBatchRenderer;
  transmit?: StatementBatchTransmitter;
}

export async function processStatementBatchJob(
  data: StatementBatchJobData,
  deps: StatementBatchDeps = {},
): Promise<{ outcome: "sent" | "already-sent" | "skipped" | "refused" | "suppressed" }> {
  assertStatementBatchJob(data);
  const { orgId, runId, partyId, senderId } = data;
  return await withOrgContext(orgId, async () => {
    const run = await getStatementBatchRun(orgId, runId);
    if (!run)
      throw new Error(
        `statement batch run ${runId} was not found — nothing was rendered; re-create the run`,
      );
    const claimed = await claimStatementBatchItem(orgId, runId, partyId);
    if (!claimed) {
      throw new Error(
        `statement batch item for customer ${partyId} was not found — nothing was rendered`,
      );
    }
    if (claimed.state === "already-sent") return { outcome: "already-sent" };
    if (claimed.state === "skipped") return { outcome: "skipped" };
    const item = claimed.item;
    const to = item.toEmail?.trim() || "";
    if (!to) {
      await settleStatementBatchItemFailed(
        orgId,
        item.id,
        "no email on file — add an email address to the party first",
      );
      return { outcome: "refused" };
    }
    const resolution = await resolveOrgEmailTransportDetailed(orgId);
    if (resolution.state !== "ready") {
      await settleStatementBatchItemFailed(orgId, item.id, emailDeliveryBlockedMessage(resolution));
      return { outcome: "refused" };
    }
    const transport = resolution.transport;
    const renderPdf = deps.renderPdf ?? renderStatementBatchPdf;
    const transmit = deps.transmit ?? transmitStatementBatchEmail;
    let rendered: StatementBatchRender;
    try {
      rendered = await renderPdf(orgId, runId, partyId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await settleStatementBatchItemFailed(orgId, item.id, message);
      throw e;
    }
    const email = documentEmail({
      orgName: rendered.orgName,
      docTitle: "Statement",
      reference: rendered.reference || `as of ${run.periodTo}`,
      partyName: item.partyName?.trim() || undefined,
      attachmentName: rendered.attachmentName,
    });
    const deliveryKey = deriveEmailDeliveryKey({
      orgId,
      scope: statementBatchEmailScope(runId),
      to,
    });
    try {
      const result = await transmit({
        orgId,
        transport,
        to,
        subject: email.subject,
        html: email.html,
        text: email.text,
        attachment: {
          filename: rendered.attachmentName,
          content: rendered.pdf.toString("base64"),
          contentType: "application/pdf",
        },
        deliveryKey,
        senderId,
        partyId,
        runId,
      });
      await settleStatementBatchItemSent(orgId, item.id, result.emailLogId, deliveryKey);
      return { outcome: result.alreadySent ? "already-sent" : "sent" };
    } catch (e) {
      if (e instanceof StatementBatchSuppressed) {
        await settleStatementBatchItemFailed(orgId, item.id, e.message);
        return { outcome: "suppressed" };
      }
      await settleStatementBatchItemFailed(
        orgId,
        item.id,
        e instanceof Error ? e.message : String(e),
      );
      throw e;
    }
  });
}

export function createStatementBatchWorker(
  deps: StatementBatchDeps = {},
): Worker<StatementBatchJobData> {
  return new Worker<StatementBatchJobData>(
    STATEMENT_BATCH_QUEUE,
    async (job) => processStatementBatchJob(job.data, deps),
    { connection: getBlockingConnection(), concurrency: 3 },
  );
}
