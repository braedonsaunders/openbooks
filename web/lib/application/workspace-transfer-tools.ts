import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { db, withOrgTransaction } from "@openbooks/engine/platform/database";
import { can } from "../authz";
import { TransferRefusal, type TransferSummary } from "../data-io/transfer-contract";
import { commandTransfer, uploadTransferPart } from "../data-io/transfer-commands";
import {
  createTransfer,
  loadTransfer,
  publicTransfer,
  transferAuthority,
  transferMetadataScope,
} from "../data-io/transfer-store";
import { TRANSFER_CHUNK_BYTES } from "../data-io/transfer-contract";
import type { ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput } from "./errors";
import { assertApplicationPermission } from "./context";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("UUID copied from the transfer result or read.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function transferRequestKey(orgId: string, key: string): string {
  const hash = createHash("sha256").update(`data-transfer:${orgId}:${key}`).digest("hex");
  const variant = ((Number.parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function assertTransferPermission(context: ApplicationContext, kind?: "import" | "export") {
  if (kind === "import") return assertApplicationPermission(context, "data.import");
  if (kind === "export") return assertApplicationPermission(context, "data.export");
  if (!can(context.authz, "data.import") && !can(context.authz, "data.export")) {
    throw forbidden("data.import or data.export");
  }
}

function settleTransferRefusal(error: unknown): never {
  if (error instanceof TransferRefusal) {
    if (error.status === 403)
      throw new ApplicationError("forbidden", error.message, 403, { code: error.code });
    if (error.status === 404)
      throw new ApplicationError("not_found", error.message, 404, { code: error.code });
    if (error.status === 409) throw conflict(error.message, { code: error.code });
    throw new ApplicationError("invalid_input", error.message, error.status, { code: error.code });
  }
  throw error;
}

export const WORKSPACE_TRANSFER_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_data_transfers",
    title: "List Data Transfers",
    description:
      "List your recent data transfer jobs and their state. Requires data.import or data.export; use the returned transfer id with get_data_transfer, prepare_import, or manage_data_transfer.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "data.import") || can(authz, "data.export"),
    execute: async (context) => {
      assertTransferPermission(context);
      const jobs = await withOrgTransaction(context.authz.user.orgId, () =>
        db.execute<TransferSummary>(
          sql`
          select id, kind, file_name as filename, state
            from data_transfer_jobs
           where org_id = ${context.authz.user.orgId}
             and actor_id = ${context.authz.user.id}
             and ${transferMetadataScope(context.authz.allowedSubsidiaryIds, sql`scope`)}
           order by created_at desc, id desc limit 20
        `,
          "objects",
        ),
      );
      return { total: jobs.length, jobs, href: "/data/transfers" };
    },
  }),
  definition({
    name: "get_data_transfer",
    title: "Get Data Transfer",
    description:
      "Read a transfer's current revision, state, preview, and result. Requires the transfer's resource authority and subsidiary scope; use list_data_transfers or a create command to resolve its id.",
    inputSchema: z.object({ transferId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "data.import") || can(authz, "data.export"),
    execute: async (context, input) => {
      assertTransferPermission(context);
      const job = await withOrgTransaction(context.authz.user.orgId, async () => {
        const transfer = await loadTransfer(context.authz.user.orgId, input.transferId);
        await transferAuthority(transfer, context.authz);
        return publicTransfer(transfer);
      });
      return { job, href: `/data/transfers/${job.id}` };
    },
  }),
  definition({
    name: "create_data_transfer",
    title: "Create Data Transfer",
    description:
      "Start a durable CSV, XLSX, or JSON data import or export. Resource-level permissions, feature gates, subsidiary scope, and schema are checked by the transfer service; use list_import_templates for import resources and inspect the returned transfer before continuing.",
    inputSchema: z
      .object({
        kind: z.enum(["import", "export"]).describe("Import records or export a resource."),
        resource: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("Resource key from the data resource list."),
        format: z.enum(["csv", "xlsx", "json"]).describe("Transfer file format."),
        filename: z
          .string()
          .min(1)
          .max(255)
          .regex(/^[^\r\n/\\]+$/)
          .describe("File name without path separators."),
        bytes: z
          .number()
          .int()
          .min(0)
          .max(1_099_511_627_776)
          .describe("Expected source byte count for an import; use zero for an export."),
        columns: z
          .array(z.string().min(1).max(200).describe("Resource field key."))
          .min(1)
          .max(16_384)
          .optional()
          .describe("Export fields to include."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (input) => input.kind !== "export" || (input.columns?.length ?? 0) > 0,
        "Select one or more export columns.",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "data.import") || can(authz, "data.export"),
    execute: async (context, input) => {
      assertTransferPermission(context, input.kind);
      try {
        const job = await createTransfer(context.authz, {
          requestKey: transferRequestKey(context.authz.user.orgId, input.idempotencyKey),
          kind: input.kind,
          resource: input.resource,
          format: input.format,
          filename: input.filename,
          bytes: input.bytes,
          ...(input.columns ? { options: { columns: input.columns } } : {}),
        });
        return {
          ok: true,
          transferId: job.id,
          job,
          status: job.state,
          href: `/data/transfers/${job.id}`,
        };
      } catch (error) {
        settleTransferRefusal(error);
      }
    },
  }),
  definition({
    name: "upload_data_transfer_part",
    title: "Upload Data Transfer Part",
    description:
      "Upload one base64 file part to an import transfer in the uploading state. Each part is limited to 4 MiB decoded; use the returned transfer revision and continue through finish_data_transfer_upload before preparing the import.",
    inputSchema: z.object({
      transferId: UUID,
      part: z.number().int().min(0).max(262_144).describe("Zero-based part number."),
      contentBase64: z
        .string()
        .max(Math.ceil(TRANSFER_CHUNK_BYTES / 3) * 4 + 4)
        .describe("One transfer part encoded as base64, at most 4 MiB decoded."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "data.import"),
    execute: async (context, input) => {
      assertTransferPermission(context, "import");
      const compact = input.contentBase64.replace(/\s+/g, "");
      if (!BASE64.test(compact)) throw invalidInput("contentBase64 is not valid base64.");
      const bytes = Buffer.from(compact, "base64");
      if (
        bytes.length === 0 ||
        bytes.length > TRANSFER_CHUNK_BYTES ||
        bytes.toString("base64") !== compact
      ) {
        throw invalidInput(
          "The transfer part must contain valid base64 for 1 byte to 4 MiB of content.",
        );
      }
      try {
        const job = await uploadTransferPart(context.authz, input.transferId, input.part, bytes);
        return {
          ok: true,
          transferId: job.id,
          job,
          status: job.state,
          href: `/data/transfers/${job.id}`,
        };
      } catch (error) {
        settleTransferRefusal(error);
      }
    },
  }),
  definition({
    name: "manage_data_transfer",
    title: "Manage Data Transfer",
    description:
      "Finish an uploaded source file, cancel a transfer, or retry a failed worker phase. State and revision are checked by the native transfer command; use inspect_import_file or the transfer read to copy the current revision before acting.",
    inputSchema: z.object({
      transferId: UUID,
      action: z
        .enum(["finish-upload", "select-resource", "preview", "commit", "cancel", "retry"])
        .describe("Allowed lifecycle action for the current transfer state."),
      revision: z
        .number()
        .int()
        .positive()
        .describe("Current transfer revision from the transfer read."),
      resource: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Resource key when selecting an import target."),
      approvalHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional()
        .describe("Preview approval hash required to commit the current preview."),
      options: z
        .object({
          mapping: z
            .record(z.string(), z.string())
            .describe("Source header to resource field mapping."),
          importMode: z
            .enum(["insert", "upsert"])
            .describe("Insert new records or upsert by native keys."),
          post: z.boolean().describe("Post imported records when the resource supports posting."),
        })
        .optional()
        .describe("Import options required for preview and commit."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "data.import") || can(authz, "data.export"),
    execute: async (context, input) => {
      if (["finish-upload", "select-resource", "preview", "commit"].includes(input.action)) {
        assertTransferPermission(context, "import");
      } else {
        assertTransferPermission(context);
      }
      try {
        const job = await commandTransfer(context.authz, input.transferId, {
          action: input.action,
          revision: input.revision,
          ...(input.resource ? { resource: input.resource } : {}),
          ...(input.approvalHash ? { approvalHash: input.approvalHash } : {}),
          ...(input.options ? { options: input.options } : {}),
        });
        return {
          ok: true,
          transferId: job.id,
          job,
          status: job.state,
          href: `/data/transfers/${job.id}`,
        };
      } catch (error) {
        settleTransferRefusal(error);
      }
    },
  }),
];
