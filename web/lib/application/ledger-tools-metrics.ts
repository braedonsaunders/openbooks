import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  recomputeSaasMetrics,
  listSaasMetricsMonths,
} from "@openbooks/engine/billing/metrics/metrics-ledger";
import {
  createNormalizationRequest,
  listNormalizationMonthStates,
} from "@openbooks/engine/billing/metrics/metrics-normalization-service";
import { readRetentionStrip } from "@openbooks/engine/billing";
import { UsageBillingError } from "@openbooks/engine/billing/usage/errors";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const MONTH = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-01$/)
  .describe("First calendar day of the month (YYYY-MM-01).");
const hasPermission = (permission: string) => (authz: ApplicationContext["authz"]) =>
  can(authz, permission);

function assertUnrestricted(context: ApplicationContext): void {
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

function normalizationRequestId(idempotencyKey: string): string {
  const hex = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function settleRefusal(error: unknown): never {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof UsageBillingError) {
    const details = {
      code: error.code,
      remedy: error.remedy,
      ...(error.field ? { field: error.field } : {}),
    };
    if (error.status === 409) throw conflict(error.message, details);
    throw new ApplicationError("invalid_input", error.message, 422, details);
  }
  throw error;
}

export const LEDGER_METRICS_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_saas_metrics_months",
    title: "List SaaS Metrics Months",
    description:
      "List the computed SaaS metrics months and their stored calculation status. Use this to choose a month for recompute or normalization review.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("usage.read"),
    featureKey: "saasMetrics",
    execute: async (context) => {
      assertApplicationPermission(context, "usage.read");
      assertUnrestricted(context);
      const months = await listSaasMetricsMonths(context.authz.user.orgId);
      return { ok: true, months, href: "/admin/setup/saas-metrics" };
    },
  }),
  definition({
    name: "list_saas_metrics_normalization_states",
    title: "List SaaS Metrics Normalization States",
    description:
      "List months eligible for a governed normalization request and any existing request state. Use the returned month and request ids to review or correct legacy metrics.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("usage.read"),
    featureKey: "saasMetrics",
    execute: async (context) => {
      assertApplicationPermission(context, "usage.read");
      assertUnrestricted(context);
      const months = await listNormalizationMonthStates(context.authz.user.orgId);
      return { ok: true, months, href: "/admin/setup/saas-metrics" };
    },
  }),
  definition({
    name: "get_saas_metrics_retention",
    title: "Get SaaS Metrics Retention",
    description:
      "Read the latest stored recurring revenue and retention ratios by reporting currency. Use list_saas_metrics_months to inspect the underlying month calculations.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: hasPermission("usage.read"),
    featureKey: "saasMetrics",
    execute: async (context) => {
      assertApplicationPermission(context, "usage.read");
      assertUnrestricted(context);
      const result = await readRetentionStrip(context.authz.user.orgId);
      return { ok: true, ...result, href: "/admin/setup/saas-metrics" };
    },
  }),
  definition({
    name: "recompute_saas_metrics_month",
    title: "Recompute SaaS Metrics Month",
    description:
      "Recompute stored SaaS usage metrics for one open calendar month. Find valid months with list_saas_metrics_months; closed months with changed inputs require an approved normalization request.",
    inputSchema: z.object({
      month: MONTH,
      idempotencyKey: z
        .string()
        .min(8)
        .max(200)
        .describe("Unique retry key for this recompute request."),
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("usage.manage"),
    featureKey: "saasMetrics",
    execute: async (context, input) => {
      assertApplicationPermission(context, "usage.manage");
      assertUnrestricted(context);
      try {
        const result = await recomputeSaasMetrics(context.authz.user.orgId, input.month);
        return { ok: true, ...result, status: "recomputed", href: "/admin/setup/saas-metrics" };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
  definition({
    name: "request_saas_metrics_normalization",
    title: "Request SaaS Metrics Normalization",
    description:
      "Submit an audited normalization request for one eligible SaaS metrics month. Use list_saas_metrics_normalization_states first; configured Flow approval controls whether it runs immediately or waits for approval.",
    inputSchema: z.object({
      month: MONTH,
      reason: z
        .string()
        .trim()
        .min(8)
        .max(1000)
        .describe("Reason the stored month requires correction."),
      idempotencyKey: z
        .string()
        .regex(/^[A-Za-z0-9._:-]{8,200}$/)
        .describe("Unique retry key for this normalization request."),
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: hasPermission("usage.manage"),
    featureKey: "saasMetrics",
    execute: async (context, input) => {
      assertApplicationPermission(context, "usage.manage");
      assertUnrestricted(context);
      try {
        const result = await createNormalizationRequest({
          orgId: context.authz.user.orgId,
          month: input.month,
          reason: input.reason,
          requestedBy: context.authz.user.id,
          idempotencyKey: normalizationRequestId(input.idempotencyKey),
        });
        return {
          ok: true,
          ...result,
          status: result.request.status,
          href: "/admin/setup/saas-metrics",
        };
      } catch (error) {
        settleRefusal(error);
      }
    },
  }),
];
