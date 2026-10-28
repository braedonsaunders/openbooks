import "server-only";
import { z } from "zod";
import { can } from "../authz";
import {
  acceptBillingImportRun,
  BillingHistoryError,
  listBillingImportMappingOptions,
  listBillingImportRuns,
  runBillingImportById,
  runBillingPreflight,
  type BillingHistoryProvider,
} from "@openbooks/engine/sync";
import {
  acceptBillingImportBody,
  billingImportByIdBody,
  billingPreflightBody,
} from "../billing-import-schemas";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, forbidden } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const visible = (authz: Parameters<typeof can>[0]) =>
  can(authz, "sync.run") && authz.allowedSubsidiaryIds === null;
const HREF = "/sync/billing-history";

function assertUnrestricted(context: Parameters<typeof assertApplicationPermission>[0]) {
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

function settleBillingImport(error: unknown): never {
  if (error instanceof BillingHistoryError) {
    const details = { code: error.code, remedy: error.remedy };
    if (error.status === 409) throw conflict(error.message, details);
    throw new ApplicationError("invalid_input", error.message, error.status, details);
  }
  throw error;
}

export const SALES_BILLING_IMPORT_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_billing_history_import_runs",
    title: "List Billing History Import Runs",
    description:
      "List provider import runs and their current state before accepting mappings or continuing an import. Use the returned run id with get_billing_history_import_options, accept_billing_history_import, or run_billing_history_import.",
    inputSchema: z.object({
      provider: z
        .enum(["chargebee", "recurly", "maxio", "zuora"])
        .optional()
        .describe("Limit runs to one billing history provider."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "billingHistoryImport",
    visibleTo: visible,
    execute: async (context, input) => {
      assertApplicationPermission(context, "sync.run");
      assertUnrestricted(context);
      const runs = await listBillingImportRuns(
        context.authz.user.orgId,
        input.provider as BillingHistoryProvider | undefined,
      );
      return { ok: true, runs, href: HREF };
    },
  }),
  definition({
    name: "get_billing_history_import_options",
    title: "Get Billing History Import Options",
    description:
      "Read the plans, customers, accounts, and tax codes available for billing history mappings. Use these organization-owned ids when accepting a preflight run from list_billing_history_import_runs.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "billingHistoryImport",
    visibleTo: visible,
    execute: async (context) => {
      assertApplicationPermission(context, "sync.run");
      assertUnrestricted(context);
      return {
        ok: true,
        options: await listBillingImportMappingOptions(context.authz.user.orgId),
        href: HREF,
      };
    },
  }),
  definition({
    name: "start_billing_history_import",
    title: "Start Billing History Import",
    description:
      "Create a preflight run by connecting to Chargebee, Recurly, Maxio, or Zuora with an API key. Use list_billing_history_import_runs to find the new run id before reviewing mappings or importing records.",
    inputSchema: billingPreflightBody.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    featureKey: "billingHistoryImport",
    visibleTo: visible,
    execute: async (context, input) => {
      assertApplicationPermission(context, "sync.run");
      assertUnrestricted(context);
      const { idempotencyKey: _key, ...body } = input;
      try {
        const result = await runBillingPreflight(
          context.authz.user.orgId,
          context.authz.user.id,
          body.provider,
          body.externalAccount,
          body.site ? { apiKey: body.apiKey, site: body.site } : { apiKey: body.apiKey },
          {},
        );
        return { ok: true, ...result, href: `${HREF}?run=${result.runId}` };
      } catch (error) {
        settleBillingImport(error);
      }
    },
  }),
  definition({
    name: "accept_billing_history_import",
    title: "Accept Billing History Import",
    description:
      "Accept mappings and accounting policy for a preflight, ready, or failed billing import run after reviewing its counts and unresolved mappings. Find the run with list_billing_history_import_runs and mapping ids with get_billing_history_import_options.",
    inputSchema: acceptBillingImportBody.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "billingHistoryImport",
    visibleTo: visible,
    execute: async (context, input) => {
      assertApplicationPermission(context, "sync.run");
      assertUnrestricted(context);
      const { idempotencyKey: _key, ...body } = input;
      try {
        const result = await acceptBillingImportRun(
          context.authz.user.orgId,
          context.authz.user.id,
          body.runId,
          body.config,
        );
        return { ok: true, ...result, href: `${HREF}?run=${result.runId}` };
      } catch (error) {
        settleBillingImport(error);
      }
    },
  }),
  definition({
    name: "run_billing_history_import",
    title: "Run Billing History Import",
    description:
      "Import or resume history for an eligible billing provider run after preflight review and acceptance. Find the run id and verify its current state with list_billing_history_import_runs.",
    inputSchema: billingImportByIdBody.extend({ idempotencyKey: KEY }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    featureKey: "billingHistoryImport",
    visibleTo: visible,
    execute: async (context, input) => {
      assertApplicationPermission(context, "sync.run");
      assertUnrestricted(context);
      const { idempotencyKey: _key, ...body } = input;
      try {
        const result = await runBillingImportById(
          context.authz.user.orgId,
          context.authz.user.id,
          body.runId,
        );
        return { ok: true, ...result, href: `${HREF}?run=${body.runId}` };
      } catch (error) {
        settleBillingImport(error);
      }
    },
  }),
];
