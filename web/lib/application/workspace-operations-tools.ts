import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  listSchema,
  runUserSql,
  UserSqlRefusal,
  validateUserSql,
} from "@openbooks/engine/platform/sqlapi";
import { actOnInboxItem, InboxError } from "@openbooks/engine/inbox/runtime";
import { can } from "../authz";
import { expenseScope } from "../expense-access";
import { hasUnrestrictedQueryScope } from "../query-console-access";
import { inboxContext } from "../inbox-context";
import { TimeApprovalRefusal } from "../time-approval-refusal";
import { isFeatureEnabled } from "../features";
import { setInsightDashboardPin } from "../insight-dashboard-pin";
import { setInsightPublication } from "../insight-mutations";
import { markNotificationsReadForRoute } from "../notification-mutations";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, forbidden, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from the relevant inbox or notification read.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

function selfVisible(authz: Parameters<ApplicationToolDefinition["visibleTo"]>[0]): boolean {
  return typeof authz.user.id === "string" && authz.user.id.length > 0;
}

function settleSqlRefusal(error: unknown): never {
  if (error instanceof UserSqlRefusal) {
    if (error.status === 403) throw new ApplicationError("forbidden", error.message, 403);
    throw invalidInput(error.message);
  }
  throw error;
}

function settleInboxError(error: unknown): never {
  if (error instanceof InboxError) {
    throw new ApplicationError(
      error.code === "NOT_FOUND" ? "not_found" : "invalid_input",
      error.message,
      error.code === "NOT_FOUND" ? 404 : 422,
    );
  }
  if (error instanceof TimeApprovalRefusal) {
    throw new ApplicationError("conflict", error.message, error.status, {
      code: error.code,
      remedy: error.remedy,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  if (error instanceof Error) throw error;
  throw invalidInput("The inbox action was refused.");
}

async function markOwnNotificationsRead(
  context: ApplicationContext,
  input: { ids?: string[]; all?: boolean },
) {
  const { orgId, id: userId } = context.authz.user;
  const ids = [...new Set(input.ids ?? [])];
  if (!input.all && ids.length === 0)
    throw invalidInput("Pass notification ids or set all to true.");
  const result = await markNotificationsReadForRoute({ orgId, userId, ids, all: input.all });
  if (!input.all && result.own < ids.length) throw notFound("notification");
  return { ok: true, updated: result.own };
}

async function publishInsight(
  context: ApplicationContext,
  target: "card" | "dashboard",
  input: { id: string; publish?: boolean; expectedUpdatedAt: string },
) {
  const response = await setInsightPublication(
    context.authz,
    target,
    input.id,
    input.publish !== false,
    input.expectedUpdatedAt,
  );
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof body.error === "string" ? body.error : "The insight publication was refused.";
    const code =
      response.status === 404
        ? "not_found"
        : response.status === 403
          ? "forbidden"
          : response.status === 409
            ? "conflict"
            : "invalid_input";
    throw new ApplicationError(code, message, response.status);
  }
  const noun = target === "card" ? "card" : "dashboard";
  return {
    ok: true,
    [`${noun}Id`]: input.id,
    [noun]: body,
    status: input.publish === false ? "draft" : "published",
    href: target === "card" ? `/insights/cards/${input.id}` : `/insights/dashboards/${input.id}`,
  };
}

export const WORKSPACE_OPERATION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "set_dashboard_pin",
    title: "Set Dashboard Pin",
    description:
      "Pin or unpin a visible insights dashboard on your home surface. Requires insights.read; use the dashboard list to copy its id and verify the personal pin state.",
    inputSchema: z.object({
      dashboardId: UUID,
      pin: z.boolean().describe("true pins the dashboard; false removes your pin."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "insights.read"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "insights.read");
      const pinned = await setInsightDashboardPin(context.authz, input.dashboardId, input.pin);
      if (pinned === null) throw notFound("dashboard");
      return { ok: true, dashboardId: input.dashboardId, pinned, href: "/insights" };
    },
  }),
  ...(["card", "dashboard"] as const).map((target) =>
    definition({
      name: `publish_insight_${target}`,
      title: `Publish Insight ${target === "card" ? "Card" : "Dashboard"}`,
      description: `Publish or return an insight ${target} to draft. Publishing requires insights.publish, a real name, and ${target === "card" ? "a valid query" : "a complete dashboard"}; copy expectedUpdatedAt from the corresponding insight read before making a change.`,
      inputSchema: z.object({
        id: UUID,
        publish: z.boolean().optional().describe("Set false to return the record to draft."),
        expectedUpdatedAt: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
          .describe("Exact revision token from the insight read."),
        idempotencyKey: IDEMPOTENCY_KEY,
      }),
      readOnly: false,
      destructive: false,
      openWorld: false,
      assistantConfirmation: "always",
      visibleTo: (authz) => can(authz, "insights.publish"),
      execute: async (context, input) => {
        assertApplicationPermission(context, "insights.publish");
        return publishInsight(context, target, input);
      },
    }),
  ),
  definition({
    name: "query_console",
    title: "Run Read-Only Query",
    description:
      "Run one read-only SQL statement through the Query Console safety validator. Requires sql.execute, queryConsole enabled, and unrestricted subsidiary access; use only catalogued tables and columns returned by the query schema.",
    inputSchema: z.object({
      sql: z.string().trim().min(1).max(100_000).describe("One read-only SQL statement."),
      maxRows: z
        .number()
        .finite()
        .optional()
        .describe("Maximum rows to return (default 500, capped at 5,000)."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "queryConsole",
    visibleTo: (authz) => can(authz, "sql.execute"),
    execute: async (context, input) => {
      assertApplicationPermission(context, "sql.execute");
      if (!(await isFeatureEnabled(context.authz.user.orgId, "queryConsole"))) {
        throw new ApplicationError(
          "unsupported_operation",
          "The query console is disabled for this organization.",
          404,
          { featureKey: "queryConsole" },
        );
      }
      if (!hasUnrestrictedQueryScope(context.authz.allowedSubsidiaryIds)) {
        throw forbidden("queryConsole.unrestricted_scope");
      }
      try {
        validateUserSql(input.sql);
      } catch (error) {
        settleSqlRefusal(error);
      }
      try {
        return await runUserSql(input.sql, {
          orgId: context.authz.user.orgId,
          maxRows: Math.min(Math.max(Math.trunc(input.maxRows ?? 500) || 500, 1), 5_000),
          timeoutMs: 30_000,
          payrollRead: can(context.authz, "payroll.read"),
          expenseRead: expenseScope(context.authz, "read") === "all",
        });
      } catch (error) {
        if (error instanceof UserSqlRefusal) settleSqlRefusal(error);
        console.error("[query-console] execution failed", error);
        throw new ApplicationError("invalid_input", "query failed", 400);
      }
    },
  }),
  definition({
    name: "list_query_schema",
    title: "List Query Console Schema",
    description:
      "List the live schema browser used by the Query Console. Requires sql.execute, queryConsole enabled, and unrestricted subsidiary access; use the returned table and column names to prepare a read-only query_console request.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    featureKey: "queryConsole",
    visibleTo: (authz) => can(authz, "sql.execute"),
    execute: async (context) => {
      assertApplicationPermission(context, "sql.execute");
      if (!(await isFeatureEnabled(context.authz.user.orgId, "queryConsole"))) {
        throw new ApplicationError(
          "unsupported_operation",
          "The query console is disabled for this organization.",
          404,
          { featureKey: "queryConsole" },
        );
      }
      if (!hasUnrestrictedQueryScope(context.authz.allowedSubsidiaryIds)) {
        throw forbidden("queryConsole.unrestricted_scope");
      }
      try {
        const tables = await listSchema(context.authz.user.orgId, {
          payrollRead: can(context.authz, "payroll.read"),
          expenseRead: expenseScope(context.authz, "read") === "all",
        });
        return { tables, href: "/admin/query" };
      } catch (error) {
        console.error("[query-console] schema discovery failed", error);
        throw new ApplicationError("invalid_input", "query schema unavailable", 500);
      }
    },
  }),
  definition({
    name: "mark_notifications_read",
    title: "Mark Notifications Read",
    description:
      "Mark your own notifications as read by id, or mark all of your unread notifications. Use the notification inbox to resolve ids; organization and user scope are always taken from the authenticated actor.",
    inputSchema: z
      .object({
        ids: z.array(UUID).min(1).max(100).optional().describe("Notification ids to mark read."),
        all: z
          .boolean()
          .optional()
          .describe("Set true to mark every unread notification for yourself."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .refine(
        (input) => input.all === true || input.ids !== undefined,
        "Pass ids or set all to true.",
      ),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: selfVisible,
    execute: async (context, input) => markOwnNotificationsRead(context, input),
  }),
  definition({
    name: "act_on_inbox_item",
    title: "Act on Inbox Item",
    description:
      "Complete an action offered by an inbox item, such as approve, reject, complete, or mark read. The source module enforces the item's current state, actor authority, reason rules, and subsidiary scope; use the inbox list to copy itemId and actionKey.",
    inputSchema: z.object({
      itemId: z.string().min(1).max(300).describe("Opaque item id returned by the inbox list."),
      actionKey: z.string().min(1).max(80).describe("Action key advertised by that inbox item."),
      reason: z
        .string()
        .max(2000)
        .optional()
        .describe("Reason when the selected action requires one."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: selfVisible,
    execute: async (context, input) => {
      try {
        await actOnInboxItem(
          await inboxContext(context.authz),
          input.itemId,
          input.actionKey,
          input.reason,
        );
      } catch (error) {
        settleInboxError(error);
      }
      return { ok: true, itemId: input.itemId, status: "completed", href: "/inbox" };
    },
  }),
];
