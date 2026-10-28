import "server-only";
import { z } from "zod";
import {
  loadAnalyticsDashboardConfig,
  saveAnalyticsDashboardConfig,
} from "@openbooks/engine/reports/analytics-dashboard-config";
import { can } from "../authz";
import { presentationCurrency } from "../fx-presentation";
import { ANALYTICS_DASHBOARD_MAP } from "../analytics/dashboard-catalog";
import { analyticsDashboardAvailable } from "../analytics/dashboard-access";
import {
  ANALYTICS_CONFIG,
  cleanConfigValues,
  configCurrencyKey,
  isAnalyticsDashboard,
  mergeConfig,
  type AnalyticsDashboard,
} from "../analytics/config-spec";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact configuration update.");

function revisionKey(dashboard: string): string {
  return `${dashboard}Revision`;
}

async function assertDashboardAvailable(context: ApplicationContext, dashboard: string) {
  if (!isAnalyticsDashboard(dashboard)) throw notFound("analytics dashboard");
  const entry = ANALYTICS_DASHBOARD_MAP[ANALYTICS_CONFIG[dashboard].slug];
  if (!entry || !(await analyticsDashboardAvailable(context.authz, entry))) {
    throw notFound("analytics dashboard");
  }
  return dashboard as AnalyticsDashboard;
}

function assertUnrestricted(context: ApplicationContext): void {
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.restricted");
}

export const WORKSPACE_ANALYTICS_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_analytics_dashboard_config",
    title: "Get Analytics Dashboard Configuration",
    description:
      "Read the effective thresholds, presentation currency, and exact revision for a dashboard you can open. Requires reports.read; use the analytics dashboard list to choose its configuration key.",
    inputSchema: z.object({
      dashboard: z
        .string()
        .min(1)
        .max(80)
        .describe("Configuration key such as receivables or financialHealth."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "reports.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "reports.read");
      const dashboard = await assertDashboardAvailable(context, input.dashboard);
      const spec = ANALYTICS_CONFIG[dashboard];
      const [stored, currency] = await Promise.all([
        loadAnalyticsDashboardConfig(
          context.authz.user.orgId,
          dashboard,
          revisionKey(dashboard),
          configCurrencyKey(dashboard),
        ),
        presentationCurrency(context.authz.user.orgId),
      ]);
      if (!stored) throw notFound("organization");
      return {
        dashboard,
        values: mergeConfig(dashboard, stored.cfg, {
          stored: stored.currency,
          presentation: currency,
        }),
        defaults: spec.defaults,
        currency,
        revision: Number(stored.rev),
        href: `/analytics/${spec.slug}`,
      };
    },
  }),
  definition({
    name: "update_analytics_dashboard_config",
    title: "Update Analytics Dashboard Configuration",
    description:
      "Replace every threshold for an analytics dashboard using its exact revision from get_analytics_dashboard_config. Requires admin.setup.manage, unrestricted subsidiary access, and current access to the selected dashboard; money thresholds must be decimal strings in the returned currency.",
    inputSchema: z.object({
      dashboard: z.string().min(1).max(80).describe("Configuration key from the dashboard read."),
      expectedRevision: z
        .number()
        .int()
        .nonnegative()
        .describe("Exact revision returned by get_analytics_dashboard_config."),
      values: z
        .record(z.string(), z.union([z.number().finite(), z.string(), z.boolean()]))
        .describe("Complete replacement threshold values; money values are exact decimal strings."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      assertUnrestricted(context);
      const dashboard = await assertDashboardAvailable(context, input.dashboard);
      const spec = ANALYTICS_CONFIG[dashboard];
      try {
        for (const field of spec.fields) {
          if (field.kind === "money" && typeof input.values[field.key] !== "string") {
            throw invalidInput(`Threshold ${field.key} must be an exact decimal string.`);
          }
        }
        const cleaned = cleanConfigValues(dashboard, input.values);
        const currency = await presentationCurrency(context.authz.user.orgId);
        const outcome = await saveAnalyticsDashboardConfig({
          orgId: context.authz.user.orgId,
          actorId: context.authz.user.id,
          dashboard,
          revisionKey: revisionKey(dashboard),
          currencyKey: configCurrencyKey(dashboard),
          expectedRevision: input.expectedRevision,
          cleaned,
          currency,
        });
        if (outcome.kind === "missing") throw notFound("organization");
        if (outcome.kind === "unwritten") {
          throw conflict("The analytics configuration was not saved; reload and retry.");
        }
        if (outcome.kind === "conflict") {
          const values = mergeConfig(dashboard, outcome.row.cfg ?? null, {
            stored: outcome.row.currency,
            presentation: currency,
          });
          throw new ApplicationError(
            "conflict",
            `this ${dashboard} configuration changed after you opened it; the latest values are returned — reapply your change and save again`,
            409,
            { revision: Number(outcome.row.rev), values },
          );
        }
        return {
          ok: true,
          dashboard,
          values: cleaned,
          revision: outcome.revision,
          href: `/analytics/${spec.slug}`,
        };
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw invalidInput(error instanceof Error ? error.message : "Invalid analytics config.");
      }
    },
  }),
];
