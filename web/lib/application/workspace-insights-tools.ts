import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { INSIGHT_VIZ_TYPES, validateInsightQuery } from "@openbooks/analytics";
import { can } from "../authz";
import {
  listInsightCardsForAuthz,
  listInsightDashboardsForAuthz,
  loadCard,
  loadDashboard,
} from "../../app/api/insights/_lib";
import {
  createInsightCard,
  createInsightDashboard,
  deleteInsightCard,
  deleteInsightDashboard,
  updateInsightCard,
  updateInsightDashboard,
} from "../insight-mutations";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("UUID copied from an insight list or read.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const REVISION = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  .describe("Exact updatedAt revision from the insight read.");
const INSIGHT_QUERY = z
  .unknown()
  .refine((value) => {
    try {
      validateInsightQuery(value);
      return true;
    } catch {
      return false;
    }
  }, "query must follow the insight query schema")
  .describe("Validated insight data query plan.");
const ALLOWED_ROLES = z
  .array(z.string().trim().min(1).max(100).describe("Role key allowed to see the record."))
  .max(500)
  .nullable()
  .optional()
  .describe("Optional role allowlist; null clears the restriction.");
const LAYOUT = z
  .array(
    z
      .object({
        cardId: UUID.describe("Insight card id placed on the dashboard."),
        x: z.number().int().min(0).max(11).describe("Column position."),
        y: z.number().int().min(0).max(999).describe("Row position."),
        w: z.number().int().min(1).max(12).describe("Column span."),
        h: z.number().int().min(1).max(24).describe("Row span."),
      })
      .strict(),
  )
  .max(1000)
  .describe("Dashboard card placements.");

function requestId(orgId: string, key: string, target: "card" | "dashboard"): string {
  const hash = createHash("sha256").update(`insight-${target}:${orgId}:${key}`).digest("hex");
  const variant = ((Number.parseInt(hash[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function settleResponse(response: Response, noun: string, id?: string) {
  return response.json().then((body: unknown) => {
    const result =
      body && typeof body === "object" ? (body as Record<string, unknown>) : Object.create(null);
    if (!response.ok) {
      const message =
        typeof result.error === "string"
          ? result.error
          : `The insight ${noun} operation was refused.`;
      const code =
        response.status === 404
          ? "not_found"
          : response.status === 403
            ? "forbidden"
            : response.status === 409
              ? "conflict"
              : response.status >= 500
                ? "internal_error"
                : "invalid_input";
      throw new ApplicationError(code, message, response.status);
    }
    const recordId = typeof result.id === "string" ? result.id : id;
    return {
      ok: true,
      [`${noun}Id`]: recordId,
      [noun]: result,
      status: response.status === 201 ? "draft" : "updated",
      href: noun === "card" ? `/insights?card=${recordId}` : `/insights/dashboards/${recordId}`,
    };
  });
}

function assertInsightPermission(context: ApplicationContext) {
  assertApplicationPermission(context, "insights.create");
}

export const WORKSPACE_INSIGHT_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_insight_cards",
    title: "List Insight Cards",
    description:
      "List insight cards visible to you, including their ids, status, source query, and exact update revisions. Requires insights.read; use get_insight_card for a single card and copy updatedAt before saving it.",
    inputSchema: z.object({
      query: z.string().trim().max(100).optional().describe("Filter cards by name."),
      status: z.enum(["draft", "published"]).optional().describe("Filter by publication state."),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum rows; defaults to 25."),
      offset: z.number().int().min(0).max(100_000).optional().describe("Rows to skip."),
      sort: z.enum(["name", "updated"]).optional().describe("Sort field; defaults to updated."),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction; defaults to desc."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "insights.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "insights.read");
      const limit = input.limit ?? 25;
      const rows = await listInsightCardsForAuthz(context.authz, {
        ...(input.query ? { query: input.query } : {}),
        ...(input.status ? { status: input.status } : {}),
        limit: limit + 1,
        offset: input.offset ?? 0,
        sort: input.sort ?? "updated",
        direction: input.direction ?? "desc",
      });
      return {
        cards: rows.slice(0, limit),
        returned: Math.min(rows.length, limit),
        truncated: rows.length > limit,
        href: "/insights",
      };
    },
  }),
  definition({
    name: "get_insight_card",
    title: "Get Insight Card",
    description:
      "Read one visible insight card and its exact update revision. Requires insights.read; use list_insight_cards to resolve cardId before reading or editing.",
    inputSchema: z.object({ cardId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "insights.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "insights.read");
      const card = await loadCard(input.cardId, context.authz.user.orgId, context.authz);
      if (!card) throw notFound("insight card");
      return { card, href: `/insights?card=${input.cardId}` };
    },
  }),
  definition({
    name: "create_insight_card",
    title: "Create Insight Card",
    description:
      "Create a draft insight card with a validated query and visualization. Requires insights.create; the query source must be enabled and readable, and list_insight_cards verifies the new id.",
    inputSchema: z.object({
      name: z.string().trim().max(200).optional().describe("Card name."),
      description: z.string().trim().max(2000).nullable().optional().describe("Card description."),
      query: INSIGHT_QUERY.optional(),
      vizType: z.enum(INSIGHT_VIZ_TYPES).optional().describe("Visualization type."),
      vizSettings: z
        .record(z.string().min(1).max(100), z.unknown().describe("Visualization setting value."))
        .optional()
        .describe("Visualization options."),
      allowedRoles: ALLOWED_ROLES,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "insights.create"),
    execute: async (context, input) => {
      assertInsightPermission(context);
      const id = requestId(context.authz.user.orgId, input.idempotencyKey, "card");
      return settleResponse(await createInsightCard(context.authz, id, input), "card", id);
    },
    authorizeReplay: async (context, input) => {
      assertInsightPermission(context);
      const id = requestId(context.authz.user.orgId, input.idempotencyKey, "card");
      if (!(await loadCard(id, context.authz.user.orgId, context.authz))) {
        throw notFound("insight card");
      }
    },
  }),
  definition({
    name: "update_insight_card",
    title: "Update Insight Card",
    description:
      "Update a visible draft or published insight card using optimistic concurrency. Requires insights.create and the exact updatedAt revision from get_insight_card; stale revisions refuse and require a reload.",
    inputSchema: z
      .object({
        cardId: UUID,
        expectedUpdatedAt: REVISION,
        name: z.string().trim().min(1).max(200).optional().describe("Replacement card name."),
        description: z
          .string()
          .trim()
          .max(2000)
          .nullable()
          .optional()
          .describe("Replacement description."),
        query: INSIGHT_QUERY.optional(),
        vizType: z.enum(INSIGHT_VIZ_TYPES).optional().describe("Replacement visualization type."),
        vizSettings: z
          .record(z.string().min(1).max(100), z.unknown().describe("Visualization setting value."))
          .optional()
          .describe("Replacement visualization options."),
        allowedRoles: ALLOWED_ROLES,
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (input) =>
          Object.keys(input).some(
            (key) => !["cardId", "expectedUpdatedAt", "idempotencyKey"].includes(key),
          ),
        "provide at least one card field to update",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "insights.create"),
    execute: async (context, input) => {
      assertInsightPermission(context);
      return settleResponse(
        await updateInsightCard(context.authz, input.cardId, input),
        "card",
        input.cardId,
      );
    },
    authorizeReplay: async (context, input) => {
      assertInsightPermission(context);
      if (!(await loadCard(input.cardId, context.authz.user.orgId, context.authz))) {
        throw notFound("insight card");
      }
    },
  }),
  definition({
    name: "delete_insight_card",
    title: "Delete Insight Card",
    description:
      "Delete an insight card and remove it from any dashboards. Requires insights.create; use list_insight_cards to resolve cardId and verify it is gone.",
    inputSchema: z.object({ cardId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "insights.create"),
    authorizeReplay: async (context) => assertInsightPermission(context),
    execute: async (context, input) => {
      assertInsightPermission(context);
      return settleResponse(
        await deleteInsightCard(context.authz, input.cardId),
        "card",
        input.cardId,
      );
    },
  }),
  definition({
    name: "list_insight_dashboards",
    title: "List Insight Dashboards",
    description:
      "List dashboards visible to you with status, placement count, and exact update revisions. Requires insights.read; use get_insight_dashboard to resolve a dashboard before updating or publishing it.",
    inputSchema: z.object({
      query: z.string().trim().max(100).optional().describe("Filter dashboards by name."),
      status: z.enum(["draft", "published"]).optional().describe("Filter by publication state."),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum rows; defaults to 25."),
      offset: z.number().int().min(0).max(100_000).optional().describe("Rows to skip."),
      sort: z.enum(["name", "updated"]).optional().describe("Sort field; defaults to updated."),
      direction: z.enum(["asc", "desc"]).optional().describe("Sort direction; defaults to desc."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "insights.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "insights.read");
      const limit = input.limit ?? 25;
      const rows = await listInsightDashboardsForAuthz(context.authz, {
        ...(input.query ? { query: input.query } : {}),
        ...(input.status ? { status: input.status } : {}),
        limit: limit + 1,
        offset: input.offset ?? 0,
        sort: input.sort ?? "updated",
        direction: input.direction ?? "desc",
      });
      return {
        dashboards: rows.slice(0, limit),
        returned: Math.min(rows.length, limit),
        truncated: rows.length > limit,
        href: "/insights/dashboards",
      };
    },
  }),
  definition({
    name: "get_insight_dashboard",
    title: "Get Insight Dashboard",
    description:
      "Read one visible insight dashboard and its exact update revision. Requires insights.read; use list_insight_dashboards to resolve dashboardId before editing.",
    inputSchema: z.object({ dashboardId: UUID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "insights.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "insights.read");
      const dashboard = await loadDashboard(
        input.dashboardId,
        context.authz.user.orgId,
        context.authz,
      );
      if (!dashboard) throw notFound("insight dashboard");
      return { dashboard, href: `/insights/dashboards/${input.dashboardId}` };
    },
  }),
  definition({
    name: "create_insight_dashboard",
    title: "Create Insight Dashboard",
    description:
      "Create a draft insight dashboard with visible card placements. Requires insights.create; each layout card must be visible to you, and list_insight_dashboards verifies the new id.",
    inputSchema: z.object({
      name: z.string().trim().max(200).optional().describe("Dashboard name."),
      description: z
        .string()
        .trim()
        .max(2000)
        .nullable()
        .optional()
        .describe("Dashboard description."),
      layout: LAYOUT.optional(),
      allowedRoles: ALLOWED_ROLES,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "insights.create"),
    execute: async (context, input) => {
      assertInsightPermission(context);
      const id = requestId(context.authz.user.orgId, input.idempotencyKey, "dashboard");
      return settleResponse(
        await createInsightDashboard(context.authz, id, input),
        "dashboard",
        id,
      );
    },
    authorizeReplay: async (context, input) => {
      assertInsightPermission(context);
      const id = requestId(context.authz.user.orgId, input.idempotencyKey, "dashboard");
      if (!(await loadDashboard(id, context.authz.user.orgId, context.authz))) {
        throw notFound("insight dashboard");
      }
    },
  }),
  definition({
    name: "update_insight_dashboard",
    title: "Update Insight Dashboard",
    description:
      "Replace a visible dashboard's name, description, card layout, or role access using optimistic concurrency. Requires insights.create and the exact updatedAt revision from get_insight_dashboard.",
    inputSchema: z
      .object({
        dashboardId: UUID,
        expectedUpdatedAt: REVISION,
        name: z.string().trim().min(1).max(200).optional().describe("Replacement dashboard name."),
        description: z
          .string()
          .trim()
          .max(2000)
          .nullable()
          .optional()
          .describe("Replacement description."),
        layout: LAYOUT.optional(),
        allowedRoles: ALLOWED_ROLES,
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (input) =>
          Object.keys(input).some(
            (key) => !["dashboardId", "expectedUpdatedAt", "idempotencyKey"].includes(key),
          ),
        "provide at least one dashboard field to update",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "insights.create"),
    execute: async (context, input) => {
      assertInsightPermission(context);
      return settleResponse(
        await updateInsightDashboard(context.authz, input.dashboardId, input),
        "dashboard",
        input.dashboardId,
      );
    },
    authorizeReplay: async (context, input) => {
      assertInsightPermission(context);
      if (!(await loadDashboard(input.dashboardId, context.authz.user.orgId, context.authz))) {
        throw notFound("insight dashboard");
      }
    },
  }),
  definition({
    name: "delete_insight_dashboard",
    title: "Delete Insight Dashboard",
    description:
      "Delete an insight dashboard and its personal pins. Requires insights.create; use list_insight_dashboards to resolve dashboardId and verify it is gone.",
    inputSchema: z.object({ dashboardId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "insights.create"),
    authorizeReplay: async (context) => assertInsightPermission(context),
    execute: async (context, input) => {
      assertInsightPermission(context);
      return settleResponse(
        await deleteInsightDashboard(context.authz, input.dashboardId),
        "dashboard",
        input.dashboardId,
      );
    },
  }),
];
