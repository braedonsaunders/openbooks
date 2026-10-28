import "server-only";
import { can, guardSubsidiaryScope } from "../authz";
import { db, withOrgTransaction } from "@openbooks/engine/platform/database";
import {
  confirmPlanSuggestion,
  convertTransferSuggestion,
  DemandPlanningError,
  dismissPlanSuggestion,
  getDemandRun,
  getPlanSuggestion,
  listDemandPolicies,
  listDemandRuns,
  listPlanSuggestions,
  runDemandPlan,
  saveDemandPolicy,
  saveForecastOverride,
  listForecastOverrides,
} from "@openbooks/engine/inventory";
import { convertBuyGroup } from "../../app/api/inventory/planning/_buy";
import { type ApplicationToolDefinition } from "./tool-definition";
import {
  inventoryDefinition as definition,
  DATE,
  IDEMPOTENCY_KEY,
  nativeIdempotencyUuid,
  settleInventoryRefusal,
  UUID,
} from "./inventory-tools-common";
import { assertApplicationPermission } from "./context";
import { notFound } from "./errors";
import { z } from "zod";

const visibleTo = (authz: Parameters<ApplicationToolDefinition["visibleTo"]>[0]) =>
  can(authz, "inventory.plan");
const QUANTITY = z
  .string()
  .regex(/^\d+(?:\.\d{1,8})?$/)
  .describe("Exact non-negative quantity string; never use a JSON number.");

export const INVENTORY_PLANNING_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_demand_runs",
    title: "List Demand Planning Runs",
    description:
      "List the saved forecast runs for one subsidiary before reviewing suggestions. Read details with get_demand_run and use its id to list_plan_suggestions.",
    inputSchema: z.object({ subsidiaryId: UUID.describe("Subsidiary id visible to the caller.") }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo,
    featureKey: "demandPlanning",
    execute: async (context, input) => {
      assertApplicationPermission(context, "inventory.plan");
      if (guardSubsidiaryScope(context.authz, input.subsidiaryId))
        throw notFound("planning record");
      return withOrgTransaction(context.authz.user.orgId, async () => ({
        runs: await listDemandRuns(db, context.authz.user.orgId, input.subsidiaryId),
        href: "/inventory/planning",
      }));
    },
  }),
  definition({
    name: "get_demand_run",
    title: "Get Demand Planning Run",
    description:
      "Read one forecast run and its totals before reviewing its suggestions. Find the run id with list_demand_runs.",
    inputSchema: z.object({
      subsidiaryId: UUID.describe("Subsidiary id visible to the caller."),
      runId: UUID.describe("Run id from list_demand_runs."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo,
    featureKey: "demandPlanning",
    execute: async (context, input) => {
      assertApplicationPermission(context, "inventory.plan");
      return withOrgTransaction(context.authz.user.orgId, async () => {
        if (guardSubsidiaryScope(context.authz, input.subsidiaryId)) throw notFound("planning run");
        const detail = await getDemandRun(
          db,
          context.authz.user.orgId,
          input.subsidiaryId,
          input.runId,
        );
        return { ...detail, href: "/inventory/planning" };
      });
    },
  }),
  definition({
    name: "list_plan_suggestions",
    title: "List Planning Suggestions",
    description:
      "List purchase or transfer suggestions for a subsidiary and status. Confirm a suggestion before converting it; find the subsidiary with list_demand_runs.",
    inputSchema: z.object({
      subsidiaryId: UUID.describe("Subsidiary id visible to the caller."),
      status: z
        .enum(["suggested", "confirmed", "converted", "dismissed", "open", "all"])
        .optional()
        .describe("Suggestion status filter; defaults to open."),
      runId: UUID.optional().describe("Optional run id from list_demand_runs to scope results."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo,
    featureKey: "demandPlanning",
    execute: async (context, input) => {
      assertApplicationPermission(context, "inventory.plan");
      if (guardSubsidiaryScope(context.authz, input.subsidiaryId))
        throw notFound("planning record");
      return withOrgTransaction(context.authz.user.orgId, async () => {
        const suggestions = await listPlanSuggestions(
          db,
          context.authz.user.orgId,
          input.subsidiaryId,
          input.status ?? "open",
        );
        const filtered = input.runId
          ? suggestions.filter((suggestion) => suggestion.runId === input.runId)
          : suggestions;
        return { suggestions: filtered, href: "/inventory/planning" };
      });
    },
  }),
  definition({
    name: "run_demand_plan",
    title: "Run Demand Plan",
    description:
      "Freeze current stock history and create a new demand forecast with reviewable purchase and transfer suggestions. Find the subsidiary with list_demand_runs; read the completed run with get_demand_run.",
    inputSchema: z.object({
      subsidiaryId: UUID.describe("Subsidiary id visible to the caller."),
      asOf: DATE.optional().describe(
        "Forecast anchor date; omitted uses the organization's business date.",
      ),
      horizonWeeks: z
        .number()
        .int()
        .min(1)
        .max(52)
        .optional()
        .describe("Forecast horizon from 1 to 52 weeks."),
      historyWeeks: z
        .number()
        .int()
        .min(4)
        .max(156)
        .optional()
        .describe("History window from 4 to 156 weeks."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo,
    featureKey: "demandPlanning",
    execute: async (context, input) => {
      assertApplicationPermission(context, "inventory.plan");
      if (guardSubsidiaryScope(context.authz, input.subsidiaryId))
        throw notFound("planning record");
      try {
        const run = await withOrgTransaction(context.authz.user.orgId, () =>
          runDemandPlan(db, context.authz.user.orgId, context.authz.user.id, {
            subsidiaryId: input.subsidiaryId,
            asOf: input.asOf,
            horizonWeeks: input.horizonWeeks,
            historyWeeks: input.historyWeeks,
            idempotencyKey: nativeIdempotencyUuid(input.idempotencyKey),
          }),
        );
        return { ok: true, run, replayed: run.replayed ?? false, href: "/inventory/planning" };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "save_demand_policy",
    title: "Save Demand Planning Policy",
    description:
      "Set item-specific lead time, review cadence, service level, supplier, and forecast method before the next planning run. Read the saved policy with list_demand_policies.",
    inputSchema: z.object({
      itemId: UUID.describe("Item id from search_items or get_item."),
      subsidiaryId: UUID.describe("Legal entity that owns the planning policy."),
      leadTimeDays: z.number().int().min(0).nullable().describe("Supplier lead time in days."),
      reviewCycleDays: z
        .number()
        .int()
        .min(0)
        .nullable()
        .describe("Planning review cycle in days."),
      serviceLevel: z
        .string()
        .nullable()
        .describe("Target service level as an exact decimal string."),
      moqQty: QUANTITY.nullable().describe("Minimum order quantity as an exact decimal string."),
      casePackQty: QUANTITY.nullable().describe("Case pack quantity as an exact decimal string."),
      preferredSupplierId: UUID.nullable().describe("Preferred supplier party id, or null."),
      forecastMethod: z
        .enum(["auto", "seasonal", "intermittent", "average"])
        .nullable()
        .describe("Forecast method, or null for the default."),
      historyWeeks: z
        .number()
        .int()
        .min(4)
        .max(156)
        .nullable()
        .describe("Item history window, or null for the default."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo,
    featureKey: "demandPlanning",
    execute: async (context, input) => {
      assertApplicationPermission(context, "inventory.plan");
      if (guardSubsidiaryScope(context.authz, input.subsidiaryId))
        throw notFound("planning record");
      try {
        const { subsidiaryId, idempotencyKey: _key, ...policy } = input;
        const saved = await withOrgTransaction(context.authz.user.orgId, () =>
          saveDemandPolicy(db, context.authz.user.orgId, context.authz.user.id, policy),
        );
        return { ok: true, policy: saved, href: "/inventory/planning" };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "list_demand_policies",
    title: "List Demand Planning Policies",
    description:
      "Read the saved item and subsidiary planning policies before changing replenishment settings. Use search_items to find item ids and list_demand_runs for subsidiary ids.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo,
    featureKey: "demandPlanning",
    execute: async (context) => {
      assertApplicationPermission(context, "inventory.plan");
      return withOrgTransaction(context.authz.user.orgId, async () => ({
        policies: [...(await listDemandPolicies(db, context.authz.user.orgId)).values()],
        href: "/inventory/planning",
      }));
    },
  }),
  definition({
    name: "save_forecast_override",
    title: "Save Forecast Override",
    description:
      "Replace one item's forecast quantity for a Monday-starting week and record why the statistical forecast is overridden. The next run reads it; find the item and location with inventory reads.",
    inputSchema: z.object({
      itemId: UUID.describe("Stocked item id."),
      stockLocationId: UUID.describe("Stock location id."),
      subsidiaryId: UUID.describe("Legal entity that owns this stock location."),
      periodStart: DATE.describe("Monday that begins the forecast week."),
      quantity: QUANTITY.describe("Exact forecast quantity string."),
      reason: z
        .string()
        .min(5)
        .max(500)
        .describe("Reason for overriding the statistical forecast."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo,
    featureKey: "demandPlanning",
    execute: async (context, input) => {
      assertApplicationPermission(context, "inventory.plan");
      if (guardSubsidiaryScope(context.authz, input.subsidiaryId))
        throw notFound("planning record");
      try {
        const { subsidiaryId, idempotencyKey: _key, ...override } = input;
        const saved = await withOrgTransaction(context.authz.user.orgId, () =>
          saveForecastOverride(db, context.authz.user.orgId, context.authz.user.id, override),
        );
        return { ok: true, override: saved, href: "/inventory/planning" };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "list_forecast_overrides",
    title: "List Forecast Overrides",
    description:
      "Read saved overrides for a subsidiary and run before changing a forecast. Find run ids with list_demand_runs.",
    inputSchema: z.object({
      subsidiaryId: UUID.describe("Subsidiary id visible to the caller."),
      runId: UUID.describe("Demand run id from list_demand_runs."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo,
    featureKey: "demandPlanning",
    execute: async (context, input) => {
      assertApplicationPermission(context, "inventory.plan");
      if (guardSubsidiaryScope(context.authz, input.subsidiaryId))
        throw notFound("planning record");
      return withOrgTransaction(context.authz.user.orgId, async () => ({
        overrides: await listForecastOverrides(
          db,
          context.authz.user.orgId,
          input.subsidiaryId,
          input.runId,
        ),
        href: "/inventory/planning",
      }));
    },
  }),
  definition({
    name: "confirm_plan_suggestion",
    title: "Confirm Planning Suggestion",
    description:
      "Confirm a suggested purchase or transfer before converting it into a draft order or transfer. Find suggestion ids with list_plan_suggestions and verify the status with that tool.",
    inputSchema: z.object({
      suggestionId: UUID.describe("Suggestion id from list_plan_suggestions."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo,
    featureKey: "demandPlanning",
    execute: async (context, input) => {
      assertApplicationPermission(context, "inventory.plan");
      try {
        const result = await withOrgTransaction(context.authz.user.orgId, async () => {
          const suggestion = await getPlanSuggestion(
            db,
            context.authz.user.orgId,
            input.suggestionId,
          );
          if (guardSubsidiaryScope(context.authz, suggestion.subsidiaryId))
            throw notFound("planning suggestion");
          return confirmPlanSuggestion(
            db,
            context.authz.user.orgId,
            context.authz.user.id,
            input.suggestionId,
          );
        });
        return { ok: true, ...result, href: "/inventory/planning" };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "dismiss_plan_suggestion",
    title: "Dismiss Planning Suggestion",
    description:
      "Dismiss an unconverted planning suggestion with a reason. Find the suggestion id with list_plan_suggestions and verify the final status there.",
    inputSchema: z.object({
      suggestionId: UUID.describe("Suggestion id from list_plan_suggestions."),
      reason: z.string().min(5).max(500).describe("Why this suggestion is not being acted on."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo,
    featureKey: "demandPlanning",
    execute: async (context, input) => {
      assertApplicationPermission(context, "inventory.plan");
      try {
        const result = await withOrgTransaction(context.authz.user.orgId, async () => {
          const suggestion = await getPlanSuggestion(
            db,
            context.authz.user.orgId,
            input.suggestionId,
          );
          if (guardSubsidiaryScope(context.authz, suggestion.subsidiaryId))
            throw notFound("planning suggestion");
          return dismissPlanSuggestion(
            db,
            context.authz.user.orgId,
            context.authz.user.id,
            input.suggestionId,
            input.reason,
          );
        });
        return { ok: true, ...result, href: "/inventory/planning" };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
  definition({
    name: "convert_plan_suggestion",
    title: "Convert Planning Suggestion",
    description:
      "Convert a confirmed purchase suggestion into a draft purchase order or a confirmed transfer suggestion into a transfer order. Find ids with list_plan_suggestions; already-converted suggestions return their saved target.",
    inputSchema: z.object({
      suggestionId: UUID.describe("Confirmed suggestion id from list_plan_suggestions."),
      vendorId: UUID.optional().describe(
        "Supplier id for a purchase suggestion when no preferred supplier is saved.",
      ),
      fromLocationId: UUID.optional().describe("Source stock location for a transfer suggestion."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo,
    featureKey: "demandPlanning",
    execute: async (context, input) => {
      assertApplicationPermission(context, "inventory.plan");
      try {
        const result = await withOrgTransaction(context.authz.user.orgId, async () => {
          const suggestion = await getPlanSuggestion(
            db,
            context.authz.user.orgId,
            input.suggestionId,
          );
          if (guardSubsidiaryScope(context.authz, suggestion.subsidiaryId))
            throw notFound("planning suggestion");
          if (suggestion.status === "converted" && suggestion.converted_ref_id)
            return { id: suggestion.converted_ref_id, action: suggestion.action, replayed: true };
          if (suggestion.action === "buy") {
            assertApplicationPermission(context, "purchase_orders.create");
            const resolved = (
              await listPlanSuggestions(
                db,
                context.authz.user.orgId,
                suggestion.subsidiaryId,
                "all",
              )
            ).find((row) => row.id === input.suggestionId);
            const supplierId = input.vendorId ?? resolved?.supplierId ?? null;
            if (!supplierId)
              throw new DemandPlanningError(
                `Choose a vendor for ${suggestion.item_code?.trim() || suggestion.item_name} before converting.`,
                "vendor_required",
                "choose a vendor before converting the suggestion",
                400,
              );
            if (!suggestion.base_unit)
              throw new DemandPlanningError(
                "This item has no inventory unit configured.",
                "item_not_stocked",
                "add an inventory costing profile with a base unit",
                409,
              );
            return {
              ...(await convertBuyGroup(
                {
                  user: context.authz.user,
                  allowedSubsidiaryIds: context.authz.allowedSubsidiaryIds,
                  permissions: context.authz.permissions,
                },
                {
                  subsidiaryId: suggestion.subsidiaryId,
                  supplierId,
                  dueDate: suggestion.due_date,
                  lines: [
                    {
                      suggestionId: input.suggestionId,
                      itemId: suggestion.item_id,
                      itemLabel: suggestion.item_code?.trim() || suggestion.item_name,
                      quantity: suggestion.quantity,
                      unit: suggestion.base_unit,
                      stockLocationId: suggestion.stock_location_id,
                      dueDate: suggestion.due_date,
                      runNumber: `run ${suggestion.run_number}`,
                    },
                  ],
                },
              )),
              action: "buy" as const,
            };
          }
          assertApplicationPermission(context, "items.post");
          if (!input.fromLocationId)
            throw new DemandPlanningError(
              "A transfer suggestion needs its source location.",
              "transfer_locations_required",
              "choose the location to move stock from",
              400,
            );
          return {
            ...(await convertTransferSuggestion(
              db,
              context.authz.user.orgId,
              context.authz.user.id,
              input.suggestionId,
              { fromStockLocationId: input.fromLocationId },
            )),
            action: "transfer" as const,
          };
        });
        const href =
          result.action === "buy"
            ? `/purchasing/orders?document=${encodeURIComponent(result.id)}`
            : `/inventory/transfers?transfer=${encodeURIComponent(result.id)}`;
        return { ok: true, ...result, href };
      } catch (error) {
        settleInventoryRefusal(error);
      }
    },
  }),
];
