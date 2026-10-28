import "server-only";
import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
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
import { RATIO_INPUT_KEYS } from "../analytics/financial-health";
import { RatioInputError, loadRatioInputs, saveRatioInput } from "../analytics/ratio-inputs";
import { loadCashflowCategories } from "@openbooks/engine/reports/cashflow-categories";
import { replaceCashflowCategories } from "../analytics/cashflow-category-write";
import { loadTrueCostSnapshot, replaceTrueCostConfig } from "../analytics/true-cost-config-write";
import { isFeatureEnabled } from "../features";
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

async function assertFinancialHealthAvailable(context: ApplicationContext): Promise<void> {
  const dashboard = ANALYTICS_DASHBOARD_MAP["financial-health"];
  if (!dashboard || !(await analyticsDashboardAvailable(context.authz, dashboard))) {
    throw notFound("financial health dashboard");
  }
}

export const WORKSPACE_ANALYTICS_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "get_true_cost_config",
    title: "Get True Cost Configuration",
    description:
      "Read the active True Cost profile, all profile settings, and the exact revision for the next replacement. Requires reports.read and the Projects feature; use update_true_cost_config only after reviewing the complete returned aggregate.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "projects",
    visibleTo: (authz) => can(authz, "reports.read"),
    execute: async (context) => {
      assertApplicationPermission(context, "reports.read");
      if (!(await isFeatureEnabled(context.authz.user.orgId, "projects"))) {
        throw notFound("true cost dashboard");
      }
      return {
        ...(await loadTrueCostSnapshot(context.authz.user.orgId)),
        href: "/analytics/true-cost",
      };
    },
  }),
  definition({
    name: "update_true_cost_config",
    title: "Update True Cost Configuration",
    description:
      "Replace the complete True Cost profiles using the exact revision from get_true_cost_config. Requires admin.setup.manage, unrestricted subsidiary access, and the Projects feature; amounts and rates must be decimal strings.",
    inputSchema: z.object({
      activeProfileId: z
        .string()
        .trim()
        .min(1)
        .max(80)
        .describe("Id of one profile in the complete replacement list."),
      expectedRevision: z
        .number()
        .int()
        .nonnegative()
        .describe("Exact revision returned by get_true_cost_config."),
      profiles: z
        .array(z.json())
        .min(1)
        .max(20)
        .describe(
          "Complete replacement profile list; monetary rates and amounts are decimal strings.",
        ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    featureKey: "projects",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      assertUnrestricted(context);
      if (!(await isFeatureEnabled(context.authz.user.orgId, "projects"))) {
        throw notFound("true cost dashboard");
      }
      const result = await replaceTrueCostConfig({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        body: {
          activeProfileId: input.activeProfileId,
          expectedRevision: input.expectedRevision,
          profiles: input.profiles,
        },
      });
      if (result.kind === "invalid_body") throw invalidInput(result.message);
      if (result.kind === "revision_required") {
        throw conflict(
          "the True Cost configuration revision is required; reload and review the latest revision",
        );
      }
      if (result.kind === "invalid_amount") {
        throw invalidInput("rates and amounts must be non-negative decimals");
      }
      if (result.kind === "invalid_configuration") {
        throw invalidInput(
          "profiles and nested categories must be valid; correct every item before saving",
        );
      }
      if (result.kind === "conflict") {
        throw conflict(
          "this True Cost configuration changed after you opened it; reload and review the latest revision",
        );
      }
      return {
        ok: true,
        revision: result.revision,
        activeProfileId: result.activeProfileId,
        profiles: result.profiles,
        href: "/analytics/true-cost",
      };
    },
  }),
  definition({
    name: "get_cashflow_categories",
    title: "Get Cashflow Categories",
    description:
      "Read the current cash-flow forecast categories and exact revision used for the next replacement. Requires reports.read and unrestricted subsidiary access; use the account and vendor read tools to choose category references.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "reports.read"),
    execute: async (context) => {
      assertApplicationPermission(context, "reports.read");
      assertUnrestricted(context);
      const snapshot = await loadCashflowCategories(context.authz.user.orgId);
      return { ...snapshot, href: "/analytics/cashflow" };
    },
  }),
  definition({
    name: "replace_cashflow_categories",
    title: "Replace Cashflow Categories",
    description:
      "Replace the full cash-flow forecast category list using the exact revision from get_cashflow_categories. Requires admin.setup.manage and unrestricted subsidiary access; account, vendor, and subsidiary references must exist in this organization and within the caller's scope.",
    inputSchema: z.object({
      categories: z
        .array(z.json())
        .max(50)
        .describe("Complete replacement list of forecast categories."),
      expectedRevision: z
        .number()
        .int()
        .nonnegative()
        .describe("Exact revision returned by get_cashflow_categories."),
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
      const result = await replaceCashflowCategories({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
        categories: input.categories,
        expectedRevision: input.expectedRevision,
      });
      if (result.kind === "invalid_body") throw invalidInput(result.message);
      if (result.kind === "revision_required") throw invalidInput("expectedRevision required.");
      if (result.kind === "invalid_category") {
        throw new ApplicationError("invalid_input", result.message, result.status, {
          index: result.index,
        });
      }
      if (result.kind === "missing") throw notFound("organization");
      if (result.kind === "conflict") {
        throw new ApplicationError(
          "conflict",
          `Cashflow categories changed since revision ${input.expectedRevision} (now at ${result.revision}): reload and reapply your edit.`,
          409,
          { revision: result.revision },
        );
      }
      if (result.kind === "unwritten") {
        throw conflict("Cashflow categories were not saved; reload and retry.");
      }
      return {
        ok: true,
        categories: result.categories,
        revision: result.revision,
        href: "/analytics/cashflow",
      };
    },
  }),
  definition({
    name: "get_financial_health_ratio_inputs",
    title: "Get Financial Health Ratio Inputs",
    description:
      "Read the organization-wide account classifications used by Financial Health leverage ratios, plus eligible account candidates. Requires reports.read and Financial Health dashboard access; use the returned account ids when updating a classification.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "reports.read"),
    execute: async (context) => {
      assertApplicationPermission(context, "reports.read");
      await assertFinancialHealthAvailable(context);
      return {
        inputs: await loadRatioInputs(context.authz.user.orgId),
        href: "/analytics/financial-health",
      };
    },
  }),
  definition({
    name: "update_financial_health_ratio_input",
    title: "Update Financial Health Ratio Input",
    description:
      "Replace the accounts classified as interest expense or interest-bearing debt. Requires admin.setup.manage, unrestricted subsidiary access, and Financial Health dashboard access; use get_financial_health_ratio_inputs for the current revision and eligible account ids.",
    inputSchema: z.object({
      key: z
        .enum(RATIO_INPUT_KEYS)
        .describe("Classification key from get_financial_health_ratio_inputs."),
      accountIds: z
        .array(z.string().regex(UUID_RE))
        .max(500)
        .describe("Complete list of eligible account UUIDs for this classification."),
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
      await assertFinancialHealthAvailable(context);
      const t = await getTranslations("analytics.financialHealth.ratioInputs");
      try {
        const accounts = await saveRatioInput(
          context.authz.user.orgId,
          context.authz.user.id,
          input.key,
          input.accountIds,
          t(`${input.key}.title`),
        );
        return {
          ok: true,
          accounts,
          href: "/analytics/financial-health",
        };
      } catch (error) {
        if (error instanceof RatioInputError) throw invalidInput(error.message);
        throw error;
      }
    },
  }),
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
