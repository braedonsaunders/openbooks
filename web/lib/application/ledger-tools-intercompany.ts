import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { can } from "../authz";
import { generateIntercompanyCounterpart } from "../intercompany-counterparts";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, invalidInput } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import {
  intercompanyWorkspace,
  linkIntercompanyDocuments,
  loadIntercompanyPairDetail,
  unlinkIntercompanyPair,
} from "@openbooks/engine/intercompany";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID returned by an intercompany read or document tool.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const hasPermission = (permission: string) => (authz: ApplicationContext["authz"]) =>
  can(authz, permission);

function settleRefusal(error: unknown): never {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof Error) {
    const typed = error as Error & { status?: unknown; code?: unknown; remedy?: unknown };
    if (typeof typed.status === "number") {
      const details = {
        ...(typeof typed.code === "string" ? { code: typed.code } : {}),
        ...(typeof typed.remedy === "string" ? { remedy: typed.remedy } : {}),
      };
      if (typed.status === 403)
        throw new ApplicationError("forbidden", typed.message, 403, details);
      if (typed.status === 404)
        throw new ApplicationError("not_found", typed.message, 404, details);
      if (typed.status === 409) throw conflict(typed.message, details);
      throw invalidInput(typed.message, details);
    }
  }
  throw error;
}

export const LEDGER_INTERCOMPANY_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_intercompany_workspace",
    title: "List Intercompany Workspace",
    description:
      "Read unpaired, mismatched and paired intercompany documents in the caller's subsidiary scope. Use returned document ids with create_intercompany_counterpart or link_intercompany_documents.",
    inputSchema: z.object({
      subsidiaryId: UUID.optional().describe("Limit the workspace to one visible subsidiary."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("intercompany.read"),
    featureKey: "intercompanyTransactions",
    execute: async (context, input) => {
      assertApplicationPermission(context, "intercompany.read");
      try {
        const workspace = await intercompanyWorkspace(
          context.authz.user.orgId,
          context.authz.allowedSubsidiaryIds,
          { subsidiaryId: input.subsidiaryId },
        );
        return { ok: true, ...workspace, href: "/intercompany" };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "get_intercompany_pair",
    title: "Get Intercompany Pair",
    description:
      "Read a linked customer and vendor document pair with its comparison and lifecycle state. Find the pair id with list_intercompany_workspace.",
    inputSchema: z.object({ pairId: UUID.describe("Pair id from list_intercompany_workspace.") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("intercompany.read"),
    featureKey: "intercompanyTransactions",
    execute: async (context, input) => {
      assertApplicationPermission(context, "intercompany.read");
      try {
        const pair = await loadIntercompanyPairDetail(
          context.authz.user.orgId,
          input.pairId,
          context.authz.allowedSubsidiaryIds,
        );
        return { ok: true, pair, href: "/intercompany" };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "create_intercompany_counterpart",
    title: "Create Intercompany Counterpart",
    description:
      "Create the other entity's mirror of an intercompany document as a draft and link the pair through the native document writer. Find the source document with find_documents or list_intercompany_workspace.",
    inputSchema: z.object({
      documentId: UUID.describe("Seller or buyer document id."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("intercompany.manage"),
    featureKey: "intercompanyTransactions",
    execute: async (context, input) => {
      assertApplicationPermission(context, "intercompany.manage");
      try {
        const result = await generateIntercompanyCounterpart(context.authz, input.documentId);
        return { ok: true, ...result, href: "/intercompany" };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "link_intercompany_documents",
    title: "Link Intercompany Documents",
    description:
      "Link an existing seller document to its buyer counterpart with a reason. Find both document ids in find_documents or list_intercompany_workspace; both must represent each other and be in the caller's scope.",
    inputSchema: z.object({
      sellerDocumentId: UUID,
      buyerDocumentId: UUID,
      reason: z.string().trim().min(1).max(2000).describe("Reason for linking these documents."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("intercompany.manage"),
    featureKey: "intercompanyTransactions",
    execute: async (context, input) => {
      assertApplicationPermission(context, "intercompany.manage");
      try {
        const result = await linkIntercompanyDocuments(
          context.authz.user.orgId,
          context.authz.user.id,
          context.authz.allowedSubsidiaryIds,
          {
            sellerDocumentId: input.sellerDocumentId,
            buyerDocumentId: input.buyerDocumentId,
            reason: input.reason,
            origin: "linked",
          },
        );
        return { ok: true, ...result, href: "/intercompany" };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "unlink_intercompany_documents",
    title: "Unlink Intercompany Documents",
    description:
      "End a live intercompany document pair while preserving its history. Find the pair with list_intercompany_workspace and provide the business reason for unlinking it.",
    inputSchema: z.object({
      pairId: UUID.describe("Pair id from list_intercompany_workspace."),
      reason: z.string().trim().min(1).max(2000).describe("Reason for ending the pair."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("intercompany.manage"),
    featureKey: "intercompanyTransactions",
    execute: async (context, input) => {
      assertApplicationPermission(context, "intercompany.manage");
      try {
        const result = await unlinkIntercompanyPair(
          context.authz.user.orgId,
          context.authz.user.id,
          context.authz.allowedSubsidiaryIds,
          input.pairId,
          input.reason,
        );
        return { ok: true, ...result, href: "/intercompany" };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
];
