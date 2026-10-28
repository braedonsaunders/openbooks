import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  deleteConnectionRecord,
  loadConnectionDashboardData,
} from "@openbooks/engine/sync/connection-admin";
import { CONNECTION_RUN_MODES } from "../sync/connection-run";
import { requestConnectionRun } from "../sync/connection-run";
import { connectionPatchBody, updateConnection } from "../sync/connection-update";
import { createConnectionAction, testConnectionAction } from "../sync/connection-admin-actions";
import { storageIdentityError } from "../../app/api/platform/connections/_storage-identity";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("Connection id returned by list_platform_connections.");
const RUN_MODES = [...CONNECTION_RUN_MODES] as [string, ...string[]];
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

function assertUnrestricted(context: ApplicationContext, permission: string): void {
  assertApplicationPermission(context, permission);
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

function settleOutcome(status: number, body: Record<string, unknown>): Record<string, unknown> {
  if (status < 300) return body;
  const code = typeof body.errorCode === "string" ? body.errorCode : "";
  const message = typeof body.error === "string" ? body.error : connectionRefusalMessage(code);
  if (status === 403) throw new ApplicationError("forbidden", message, status, body);
  if (status === 404) throw new ApplicationError("not_found", message, status, body);
  if (status === 409) throw conflict(message, body);
  throw new ApplicationError("invalid_input", message, status, body);
}

function connectionRefusalMessage(code: string): string {
  switch (code) {
    case "CONNECTION_NOT_FOUND":
      return "That connection does not exist in this organization.";
    case "CONNECTION_UNCONFIGURED":
      return "The connection has no credentials yet — finish configuring it on the Migrations & Mirror page.";
    case "RUN_ALREADY_ACTIVE":
      return "A run for this connection is already queued or running — wait for it to finish, then try again.";
    case "CONNECTION_CHANGED":
      return "The connection changed during the request — reload the current configuration and retry.";
    case "ATTACHMENTS_UNSUPPORTED":
      return "This connector does not support attachment runs.";
    case "PROJECT_FINANCIALS_UNSUPPORTED":
      return "This connector does not support project financials runs.";
    case "TARGETED_REPAIR_UNSUPPORTED":
      return "This connector does not support targeted repair.";
    case "SOURCE_REFS_REFUSED":
      return "The source references are invalid for a targeted repair.";
    default:
      return code || "request refused";
  }
}

function publicConnection(row: Record<string, unknown>) {
  return {
    id: row.id,
    source: row.source,
    displayName: row.displayName,
    authKind: row.authKind,
    status: row.status,
    config: row.config,
    hasSecrets: Boolean(row.secrets),
    mirrorEnabled: row.mirrorEnabled,
    mirrorSchedule: row.mirrorSchedule,
    postedChangePolicy: row.postedChangePolicy,
    postedChangeAuthorizedAt: row.postedChangeAuthorizedAt,
    outOfPeriodDatePolicy: row.outOfPeriodDatePolicy,
    cursor: row.cursor,
    lastRunAt: row.lastRunAt,
    lastError: row.lastError,
  };
}

async function listConnectionsForContext(context: ApplicationContext) {
  const dashboard = await loadConnectionDashboardData(context.authz.user.orgId);
  return {
    connections: dashboard.connections.map((row) =>
      publicConnection(row as unknown as Record<string, unknown>),
    ),
    runs: dashboard.runs,
    currencies: dashboard.currencies,
    href: "/sync",
  };
}

export const ADMIN_CONNECTION_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_platform_connections",
    title: "List Platform Connections",
    description:
      "Read organization connector configuration and recent run status; sealed credentials are represented only as hasSecrets. Use returned ids with test_platform_connection or run_platform_connection.",
    inputSchema: z.object({}),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "admin.setup.manage") || can(authz, "sync.run"),
    execute: async (context) => {
      const permission = can(context.authz, "admin.setup.manage")
        ? "admin.setup.manage"
        : "sync.run";
      assertApplicationPermission(context, permission);
      if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
      return listConnectionsForContext(context);
    },
  }),
  definition({
    name: "create_platform_connection",
    title: "Create Platform Connection",
    description:
      "Create a connector with manifest-validated configuration and sealed credentials. Use list_platform_connections to verify its status; OAuth connectors remain unconfigured until their consent flow is completed.",
    inputSchema: z
      .object({
        source: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .describe("Connector source key from the platform connection catalogue."),
        displayName: z
          .string()
          .max(200)
          .optional()
          .describe("Optional operator-facing name; defaults to the connector name."),
        config: z
          .record(z.string(), z.json())
          .optional()
          .describe("Manifest-declared connector configuration."),
        secrets: z
          .record(z.string(), z.string().max(4000).describe("Credential value sealed at rest."))
          .optional()
          .describe("Connector credential fields; secret values are never returned."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .strict(),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertUnrestricted(context, "admin.setup.manage");
      const result = await createConnectionAction(
        { orgId: context.authz.user.orgId, userId: context.authz.user.id },
        input,
      );
      const body = settleOutcome(result.status, result.body);
      const id = String(body.id);
      const dashboard = await loadConnectionDashboardData(context.authz.user.orgId);
      const row = dashboard.connections.find((connection) => connection.id === id);
      if (!row) throw notFound("connection");
      return {
        ok: true,
        connection: publicConnection(row as unknown as Record<string, unknown>),
        connectionId: id,
        href: `/sync?connection=${id}`,
      };
    },
  }),
  definition({
    name: "update_platform_connection",
    title: "Update Platform Connection",
    description:
      "Update connector configuration, credentials, mirror policy or status through the audited connection writer. Use list_platform_connections to read the current values; secret changes are never returned.",
    inputSchema: z.object({
      connectionId: UUID,
      patch: connectionPatchBody.describe(
        "Connection fields to update using the native connector schema.",
      ),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertUnrestricted(context, "admin.setup.manage");
      const result = await updateConnection(
        { orgId: context.authz.user.orgId, userId: context.authz.user.id },
        input.connectionId,
        input.patch,
      );
      const body = settleOutcome(result.status, result.body);
      const dashboard = await loadConnectionDashboardData(context.authz.user.orgId);
      const row = dashboard.connections.find((connection) => connection.id === input.connectionId);
      if (!row) throw notFound("connection");
      return {
        ok: true,
        connection: publicConnection(row as unknown as Record<string, unknown>),
        ...body,
        connectionId: input.connectionId,
        href: `/sync?connection=${input.connectionId}`,
      };
    },
  }),
  definition({
    name: "delete_platform_connection",
    title: "Delete Platform Connection",
    description:
      "Delete one organization connector through the native connection writer. Use list_platform_connections to confirm its id; active run history or dependent records may refuse deletion.",
    inputSchema: z.object({ connectionId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "admin.setup.manage"),
    execute: async (context, input) => {
      assertUnrestricted(context, "admin.setup.manage");
      const deleted = await deleteConnectionRecord(
        context.authz.user.orgId,
        input.connectionId,
        context.authz.user.id,
      ).catch((error) => {
        if (storageIdentityError(error)) return null;
        throw error;
      });
      if (!deleted) throw notFound("connection");
      return { ok: true, connectionId: input.connectionId, status: "deleted", href: "/sync" };
    },
  }),
  definition({
    name: "test_platform_connection",
    title: "Test Platform Connection",
    description:
      "Probe saved connector credentials and record the result on that connection version. Use list_platform_connections to find the id and verify the updated status.",
    inputSchema: z.object({ connectionId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "sync.run"),
    execute: async (context, input) => {
      assertUnrestricted(context, "sync.run");
      const result = await testConnectionAction(context.authz.user.orgId, input.connectionId);
      const body = settleOutcome(result.status, result.body);
      return {
        ok: true,
        ...body,
        connectionId: input.connectionId,
        href: `/sync?connection=${input.connectionId}`,
      };
    },
  }),
  definition({
    name: "run_platform_connection",
    title: "Run Platform Connection",
    description:
      "Queue a migration, mirror, project financials, attachment or targeted-repair run for one configured connector. Use list_platform_connections to confirm its id, then check the run status there.",
    inputSchema: z
      .object({
        connectionId: UUID,
        mode: z.enum(RUN_MODES).describe("Native connection run mode."),
        sourceRefs: z
          .array(z.string().min(1).max(500))
          .min(1)
          .max(500)
          .optional()
          .describe("Source transaction references, required only for targeted_repair."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .superRefine((input, ctx) => {
        if (input.mode === "targeted_repair" && !input.sourceRefs)
          ctx.addIssue({
            code: "custom",
            path: ["sourceRefs"],
            message: "sourceRefs are required for targeted_repair",
          });
        if (input.mode !== "targeted_repair" && input.sourceRefs)
          ctx.addIssue({
            code: "custom",
            path: ["sourceRefs"],
            message: "sourceRefs are only valid for targeted_repair",
          });
      }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "sync.run"),
    execute: async (context, input) => {
      assertUnrestricted(context, "sync.run");
      const result = await requestConnectionRun(
        { orgId: context.authz.user.orgId, userId: context.authz.user.id },
        input.connectionId,
        input.mode,
        input.mode === "targeted_repair" ? { sourceRefs: input.sourceRefs ?? [] } : undefined,
      );
      const body = settleOutcome(result.status, result.body);
      return {
        ok: true,
        ...body,
        connectionId: input.connectionId,
        href: `/platform/connections?connection=${input.connectionId}`,
      };
    },
  }),
];
