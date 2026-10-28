import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  CaptureMaterializationError,
  MailboxConfigurationError,
  listInboundMessages,
  listMailboxes,
  materializeCapture,
  createMailbox,
  takeMailboxOwnership,
  updateMailbox,
} from "@openbooks/engine/payables/ap-capture-service";
import { listInbox, type InboxKind } from "@openbooks/engine/inbox/runtime";
import { can } from "../authz";
import { inboxContext, INBOX_FILTER_KINDS, toInboxNoticeViews } from "../inbox-context";
import { findVisibleApCapture, rejectApCapture, reprocessApCapture } from "../ap-capture-actions";
import { readApCaptureDetail } from "../ap-capture-reads";
import {
  CAPTURE_MAX_BYTES,
  ingestCaptureFiles,
  type CaptureIntakeAccepted,
} from "@/app/api/ap-capture/ingest";
import { assertApplicationPermission, assertSubsidiaryAccess } from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import { db } from "@openbooks/engine/platform/db";
import { apCaptureSubsidiaryScope } from "@openbooks/engine/records/file-cabinet-access";
import { apCaptureReviewBodySchema } from "@/app/api/ap-capture/[id]/route";
import { reviewApCapture } from "../ap-capture-actions";

const UUID = z.string().regex(UUID_RE).describe("UUID copied from the relevant capture record.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

function settleCaptureRefusal(error: unknown): never {
  if (error instanceof CaptureMaterializationError) {
    const status = error.status;
    const code = status === 404 ? "not_found" : status === 409 ? "conflict" : "invalid_input";
    throw new ApplicationError(code, error.message, status, {
      ...(error.code ? { code: error.code } : {}),
      ...(error.details ? { details: error.details } : {}),
    });
  }
  if (error instanceof MailboxConfigurationError) {
    const status = error.status;
    const code = status === 404 ? "not_found" : status === 409 ? "conflict" : "invalid_input";
    throw new ApplicationError(code, error.message, status);
  }
  throw error;
}

function captureActionRefusal(error: unknown): never {
  if (error instanceof Error && error.name === "ApCaptureActionRefusal") {
    const refusal = error as Error & { code: string; corrections?: number };
    const status =
      refusal.code === "not_rejectable" || refusal.code === "not_reprocessable" ? 409 : 422;
    throw new ApplicationError(
      status === 409 ? "conflict" : "invalid_input",
      error.message,
      status,
      {
        code: refusal.code,
        ...(refusal.corrections === undefined ? {} : { corrections: refusal.corrections }),
      },
    );
  }
  throw error;
}

function captureHref(id: string): string {
  return `/ap/capture?capture=${encodeURIComponent(id)}`;
}

const mailboxFields = {
  label: z.string().trim().min(1).max(120).describe("Human-readable inbound address label."),
  emailAddress: z
    .string()
    .trim()
    .max(320)
    .nullable()
    .describe("Mailbox address, or null when none is configured."),
  provider: z.enum(["generic", "microsoft", "google"]).describe("Inbound mail provider."),
  allowedSenders: z
    .array(z.string().max(320))
    .max(200)
    .describe("Sender addresses accepted by this mailbox."),
  isActive: z.boolean().describe("Whether the mailbox accepts inbound documents."),
  signingSecret: z
    .string()
    .max(512)
    .nullable()
    .describe("Optional webhook signing secret; never returned by reads."),
};

export const PURCHASING_AP_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_ap_capture_items",
    title: "List AP Capture Items",
    description:
      "Find captured supplier documents by status or text before reviewing, converting, or rejecting them. Results are limited to your subsidiary scope and include the ids used by the capture actions.",
    inputSchema: z.object({
      status: z
        .enum([
          "queued",
          "extracting",
          "needs_review",
          "ready",
          "duplicate",
          "failed",
          "materialized",
          "rejected",
        ])
        .optional()
        .describe("Optional capture status filter."),
      query: z
        .string()
        .trim()
        .max(200)
        .optional()
        .describe("Optional filename, supplier, or invoice-number search."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Maximum rows to return; defaults to 50."),
      offset: z.number().int().min(0).optional().describe("Rows to skip for pagination."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "ap.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ap.read");
      const orgId = context.authz.user.orgId;
      const search = input.query ? `%${input.query.replace(/[\\%_]/g, "\\$&")}%` : null;
      const rows = await db.execute<Record<string, unknown>>(
        sql`
          select ci.id, ci.status, ci.original_filename as "filename", ci.document_kind as "documentKind",
                 ci.normalized->>'vendorName' as "vendorName", ci.normalized->>'invoiceNumber' as "invoiceNumber",
                 ci.normalized->>'invoiceDate' as "invoiceDate", ci.normalized->>'currency' as currency,
                 ci.normalized->>'total' as total, ci.overall_confidence as "overallConfidence",
                 ci.validation_issues as "validationIssues", ci.document_id as "documentId",
                 ci.received_at as "receivedAt", vendor.display_name as "resolvedVendor", ci.source
            from ap_capture_items ci
            left join parties vendor on vendor.id = ci.vendor_candidate_id and vendor.org_id = ci.org_id
            left join documents po on po.id = ci.purchase_order_id and po.org_id = ci.org_id
           where ci.org_id = ${orgId}
             ${input.status ? sql`and ci.status = ${input.status}` : sql``}
             ${search ? sql`and (ci.original_filename ilike ${search} escape '\\' or ci.normalized->>'vendorName' ilike ${search} escape '\\' or ci.normalized->>'invoiceNumber' ilike ${search} escape '\\' or vendor.display_name ilike ${search} escape '\\')` : sql``}
             ${apCaptureSubsidiaryScope(context.authz.allowedSubsidiaryIds)}
           order by ci.received_at desc, ci.id desc
           limit ${input.limit ?? 50} offset ${input.offset ?? 0}
        `,
        "objects",
      );
      return {
        items: rows.map((row) => ({ ...row, href: captureHref(String(row.id)) })),
      };
    },
  }),
  definition({
    name: "get_ap_capture_item",
    title: "Get AP Capture Item",
    description:
      "Read a captured supplier document, its extracted fields, and its review events before correcting or converting it. Find the capture id with list_ap_capture_items.",
    inputSchema: z.object({
      captureItemId: UUID.describe("Capture item UUID from the capture list."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "ap.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ap.read");
      const detail = await readApCaptureDetail({
        orgId: context.authz.user.orgId,
        captureItemId: input.captureItemId,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
      });
      if (!detail) throw notFound("AP capture item");
      return { ...detail, href: captureHref(input.captureItemId) };
    },
  }),
  definition({
    name: "review_ap_capture_item",
    title: "Review AP Capture Item",
    description:
      "Correct a captured supplier document's extracted fields, supplier, purchase order, or bill-versus-credit kind while it is editable. Include the current revision from get_ap_capture_item; use that read again to verify saved corrections.",
    inputSchema: z.object({
      captureItemId: UUID.describe("Capture item UUID from the capture list."),
      review: apCaptureReviewBodySchema.describe("Corrected capture fields and linked records."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ap.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ap.create");
      const response = await reviewApCapture(context.authz, input.captureItemId, input.review);
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        const status = response.status;
        const code =
          status === 404
            ? "not_found"
            : status === 403
              ? "forbidden"
              : status === 409
                ? "conflict"
                : "invalid_input";
        const message =
          typeof result.error === "string" ? result.error : "Capture review was refused";
        throw new ApplicationError(code, message, status, result);
      }
      return {
        ok: true,
        id: input.captureItemId,
        ...result,
        href: captureHref(input.captureItemId),
      };
    },
  }),
  definition({
    name: "ingest_ap_capture_documents",
    title: "Ingest AP Capture Documents",
    description:
      "Upload supplier invoice or credit documents for extraction when the files are not yet in the AP capture queue. Supported files are PDF, JPEG, PNG, TIFF, and e-invoice XML; find queued records with list_ap_capture_items.",
    inputSchema: z.object({
      files: z
        .array(
          z.object({
            filename: z.string().min(1).max(512).describe("Original filename with its extension."),
            contentType: z
              .enum([
                "application/pdf",
                "image/jpeg",
                "image/png",
                "image/tiff",
                "application/xml",
                "text/xml",
              ])
              .describe("Verified MIME type of the document bytes."),
            base64: z
              .string()
              .min(4)
              .max(Math.ceil((CAPTURE_MAX_BYTES * 4) / 3))
              .describe(
                "Base64-encoded document bytes; each file is limited to the capture service's 20 MiB limit.",
              ),
          }),
        )
        .min(1)
        .max(50)
        .describe("Documents to store and queue for extraction."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ap.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ap.create");
      const intake = await ingestCaptureFiles({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        source: "upload",
        files: input.files.map((file) => ({
          filename: file.filename,
          contentType: file.contentType,
          bytes: Buffer.from(file.base64, "base64"),
        })),
      });
      if (!intake.ok) {
        if ("body" in intake) {
          throw new ApplicationError(
            intake.status >= 500
              ? "internal_error"
              : intake.status === 409
                ? "conflict"
                : "invalid_input",
            String(intake.body.error),
            intake.status,
            intake.body,
          );
        }
        if (intake.safeStatus) {
          throw new ApplicationError(
            "invalid_input",
            intake.thrown instanceof Error ? intake.thrown.message : "capture intake refused",
            intake.safeStatus,
          );
        }
        throw intake.thrown;
      }
      const accepted = intake as CaptureIntakeAccepted;
      return { ...accepted, href: accepted.ids[0] ? captureHref(accepted.ids[0]) : "/ap/capture" };
    },
  }),
  definition({
    name: "reject_ap_capture_item",
    title: "Reject AP Capture Item",
    description:
      "Reject a captured supplier document that should not become an AP bill or credit. The item must still be reviewable; find it with list_ap_capture_items.",
    inputSchema: z.object({
      captureItemId: UUID.describe("Capture item UUID from the capture list."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ap.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ap.create");
      try {
        await rejectApCapture({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          captureItemId: input.captureItemId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
      } catch (error) {
        captureActionRefusal(error);
      }
      return {
        ok: true,
        id: input.captureItemId,
        status: "rejected",
        href: captureHref(input.captureItemId),
      };
    },
  }),
  definition({
    name: "reprocess_ap_capture_item",
    title: "Reprocess AP Capture Item",
    description:
      "Queue extraction again for a failed or reviewable supplier document after correcting capture configuration or source evidence. The item must be failed, needs review, ready, or duplicate; find it with list_ap_capture_items.",
    inputSchema: z.object({
      captureItemId: UUID.describe("Capture item UUID from the capture list."),
      confirmDiscardCorrections: z
        .boolean()
        .optional()
        .describe("Set true only after deciding that saved operator corrections may be discarded."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ap.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ap.create");
      try {
        const result = await reprocessApCapture({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          captureItemId: input.captureItemId,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
          confirmDiscardCorrections: input.confirmDiscardCorrections === true,
        });
        return {
          ok: true,
          id: input.captureItemId,
          status: "queued",
          ...result,
          href: captureHref(input.captureItemId),
        };
      } catch (error) {
        captureActionRefusal(error);
      }
    },
  }),
  definition({
    name: "materialize_ap_capture_item",
    title: "Convert AP Capture Item",
    description:
      "Convert a ready, fully reviewed supplier capture into its native vendor bill or credit, with the same purchase-order matching and rule activation used by the AP capture page. Find the item with list_ap_capture_items and review details with get_ap_capture_item.",
    inputSchema: z.object({
      captureItemId: UUID.describe("Capture item UUID from the capture list."),
      priceOverride: z
        .boolean()
        .optional()
        .describe("Request the AP-approved PO price variance override."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "ap.create"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ap.create");
      const visible = await findVisibleApCapture({
        orgId: context.authz.user.orgId,
        captureItemId: input.captureItemId,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
      });
      if (!visible) throw invalidInput("Capture item not found");
      try {
        const result = await materializeCapture({
          orgId: context.authz.user.orgId,
          captureItemId: input.captureItemId,
          actorId: context.authz.user.id,
          priceOverride: input.priceOverride === true,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, href: `/ap/bills?bill=${result.documentId}` };
      } catch (error) {
        settleCaptureRefusal(error);
      }
    },
  }),
  definition({
    name: "list_ap_capture_mailboxes",
    title: "List AP Capture Mailboxes",
    description:
      "List inbound AP addresses and their legal entities before configuring or transferring one. Mailbox ids are also shown on the AP capture page; webhook credentials are never returned here.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context) => {
      assertApplicationPermission(context, "admin.setup.manage");
      return {
        mailboxes: await listMailboxes(
          context.authz.user.orgId,
          context.authz.allowedSubsidiaryIds,
        ),
      };
    },
  }),
  definition({
    name: "create_ap_capture_mailbox",
    title: "Create AP Capture Mailbox",
    description:
      "Create a new inbound AP address for a legal entity that you can access. Find subsidiary ids in setup records and verify the new mailbox with list_ap_capture_mailboxes.",
    inputSchema: z.object({
      subsidiaryId: UUID.describe("Legal entity UUID allowed for this mailbox."),
      ...mailboxFields,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      assertSubsidiaryAccess(context, input.subsidiaryId);
      try {
        const result = await createMailbox({
          ...input,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, id: result.id, href: `/ap/capture?view=mailboxes` };
      } catch (error) {
        settleCaptureRefusal(error);
      }
    },
  }),
  definition({
    name: "update_ap_capture_mailbox",
    title: "Update AP Capture Mailbox",
    description:
      "Change an inbound AP address, rotate its webhook token, or clear or replace its signing secret. The mailbox legal entity cannot change; find mailbox ids with list_ap_capture_mailboxes.",
    inputSchema: z.object({
      mailboxId: UUID.describe("Mailbox UUID from list_ap_capture_mailboxes."),
      ...mailboxFields,
      clearSigningSecret: z
        .boolean()
        .optional()
        .describe("Remove the currently saved signing secret."),
      rotateToken: z
        .boolean()
        .optional()
        .describe("Invalidate the previous webhook token and issue a replacement."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      try {
        const result = await updateMailbox({
          ...input,
          id: input.mailboxId,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          clearSigningSecret: input.clearSigningSecret === true,
          rotateToken: input.rotateToken === true,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, href: `/ap/capture?view=mailboxes` };
      } catch (error) {
        settleCaptureRefusal(error);
      }
    },
  }),
  definition({
    name: "transfer_ap_capture_mailbox_ownership",
    title: "Transfer AP Capture Mailbox Ownership",
    description:
      "Make yourself the owner of an inbound AP address when its current owner cannot operate it. The caller must be able to create bills in the mailbox entity; find mailbox ids with list_ap_capture_mailboxes.",
    inputSchema: z.object({
      mailboxId: UUID.describe("Mailbox UUID from list_ap_capture_mailboxes."),
      reason: z.string().trim().min(5).max(2000).describe("Audit reason for taking ownership."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      try {
        const result = await takeMailboxOwnership({
          id: input.mailboxId,
          reason: input.reason,
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        });
        return { ok: true, ...result, href: `/ap/capture?view=mailboxes` };
      } catch (error) {
        settleCaptureRefusal(error);
      }
    },
  }),
  definition({
    name: "list_ap_capture_inbound_messages",
    title: "List AP Capture Inbound Messages",
    description:
      "Review recent inbound email delivery outcomes and the capture ids created from each message. The list is restricted to your subsidiary scope; open a capture with get_ap_capture_item.",
    inputSchema: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Number of messages to return; defaults to 50."),
      offset: z.number().int().min(0).optional().describe("Rows to skip for pagination."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "ap.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "ap.read");
      return {
        ...(await listInboundMessages(
          context.authz.user.orgId,
          context.authz.allowedSubsidiaryIds,
          { limit: input.limit ?? 50, offset: input.offset ?? 0 },
        )),
      };
    },
  }),
  definition({
    name: "list_inbox_items",
    title: "List Inbox Items",
    description:
      "List personal approvals, tasks, signatures, and notices visible to the authenticated actor. Use the returned item ids and action keys with act_on_inbox_item.",
    inputSchema: z.object({
      filter: z
        .enum(["all", "approvals", "my_tasks", "signatures", "notices", "overdue"])
        .optional()
        .describe("Inbox category; defaults to all."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Optional maximum number returned per source."),
      offset: z.number().int().min(0).optional().describe("Optional rows to skip per source."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "assistant.use"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "assistant.use");
      const notices: Parameters<typeof toInboxNoticeViews>[0] = [];
      const filter = input.filter ?? "all";
      const kinds =
        filter === "all" || filter === "overdue" ? undefined : INBOX_FILTER_KINDS[filter];
      const items = await listInbox(await inboxContext(context.authz), {
        ...(kinds ? { kinds: kinds as InboxKind[] } : {}),
        ...(input.limit === undefined && input.offset === undefined
          ? {}
          : { page: { limit: input.limit ?? 100, offset: input.offset ?? 0 } }),
        notices,
      });
      return {
        items: filter === "overdue" ? items.filter((item) => item.priority === "overdue") : items,
        notices: toInboxNoticeViews(notices),
      };
    },
  }),
];
