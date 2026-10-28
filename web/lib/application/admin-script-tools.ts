import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { db } from "@openbooks/engine/platform/db";
import {
  advanceScheduledScriptCursor,
  createUserScript,
  deleteUserScript,
  findUserScriptForRun,
  updateUserScript,
} from "@openbooks/engine/scripting/admin";
import {
  bulkRunClientKey,
  bulkRunIdempotencyScope,
  claimBulkRunKey,
  completeBulkRunKey,
} from "@openbooks/engine/scripting/bulk-run-claim";
import {
  computeScheduledScriptNextRunAt,
  runBulkScript,
  runScheduledScript,
  scriptSaveRefusal,
} from "@openbooks/engine/scripting/scripting";
import { validateScriptConfiguration } from "@openbooks/engine/scripting/script-config";
import {
  assertProductionEnvForScheduledScript,
  ScheduledScriptNonProductionError,
} from "@openbooks/engine/scripting/scheduled-env";
import { can } from "../authz";
import { isFeatureEnabled } from "../features";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("Script id returned by list_user_scripts.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
const writeFields = {
  name: z.string().trim().min(1).max(200).describe("Script name shown in administration."),
  triggerPoint: z
    .enum([
      "before_submit",
      "before_post",
      "after_post",
      "before_void",
      "custom_gl_lines",
      "scheduled",
      "endpoint",
      "bulk",
      "client",
    ])
    .describe("Native script lifecycle or execution trigger."),
  source: z.string().min(1).max(100_000).describe("JavaScript source defining function main(ctx)."),
  documentKind: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .nullable()
    .optional()
    .describe("Document kind for document-scoped triggers."),
  endpointSlug: z
    .string()
    .max(80)
    .nullable()
    .optional()
    .describe("Public slug for endpoint scripts."),
  cron: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe("UTC cron expression for scheduled scripts."),
  isActive: z.boolean().optional().describe("Whether the script is deployed and enabled."),
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .optional()
    .describe("Execution timeout in milliseconds."),
  sortOrder: z
    .number()
    .int()
    .min(-2_147_483_648)
    .max(2_147_483_647)
    .optional()
    .describe("Order among scripts for the same trigger."),
};

async function assertScripts(context: ApplicationContext): Promise<void> {
  assertApplicationPermission(context, "scripts.manage");
  if (!(await isFeatureEnabled(context.authz.user.orgId, "scripts"))) throw notFound("route");
}

function settleScriptWriteError(error: unknown): never {
  if (error instanceof ScheduledScriptNonProductionError)
    throw conflict(error.message, { code: error.code, envKind: error.envKind });
  throw error;
}

function assertScriptConfiguration(input: Record<string, unknown>): void {
  const failure = validateScriptConfiguration(input);
  if (failure) {
    const status = failure.code === "invalid_scheduled_script_cron" ? 422 : 400;
    throw new ApplicationError("invalid_input", failure.message, status, {
      ...(failure.code ? { code: failure.code } : {}),
      ...(failure.field ? { field: failure.field } : {}),
    });
  }
}

async function assertScriptSaver(
  orgId: string,
  actorId: string,
  input: { triggerPoint: string; source: string },
) {
  if (input.triggerPoint === "endpoint") return;
  const refusal = await scriptSaveRefusal(orgId, actorId, input.source);
  if (refusal) throw new ApplicationError("forbidden", refusal, 403);
}

function scriptHref(scriptId?: string): string {
  return scriptId ? `/admin/scripts?script=${scriptId}` : "/admin/scripts";
}

export const ADMIN_SCRIPT_TOOLS: ApplicationToolDefinition[] = [
  definition({
    name: "list_user_scripts",
    title: "List User Scripts",
    description:
      "List saved scripts and their activation and run summary. Use the returned ids with update_user_script, delete_user_script or run_user_script.",
    inputSchema: z.object({
      triggerPoint: writeFields.triggerPoint
        .optional()
        .describe("Optionally filter to one trigger."),
      search: z.string().max(200).optional().describe("Optional case-insensitive name search."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => can(authz, "scripts.manage"),
    featureKey: "scripts",
    execute: async (context, input) => {
      await assertScripts(context);
      const rows = await db.execute<Record<string, unknown>>(
        sql`
          select s.id, s.name, s.trigger_point as "triggerPoint", s.document_kind as "documentKind",
                 s.endpoint_slug as "endpointSlug", s.cron, s.is_active as "isActive",
                 s.timeout_ms as "timeoutMs", s.sort_order as "sortOrder", s.last_run_at as "lastRunAt",
                 s.created_at as "createdAt", s.updated_at as "updatedAt",
                 (select count(*)::int from script_runs r where r.org_id = s.org_id and r.script_id = s.id) as "runCount",
                 (select max(r.at) from script_runs r where r.org_id = s.org_id and r.script_id = s.id) as "lastRun"
            from user_scripts s
           where s.org_id = ${context.authz.user.orgId}
             and (${input.triggerPoint ?? null}::text is null or s.trigger_point = ${input.triggerPoint ?? null})
             and (${input.search ?? null}::text is null or s.name ilike ${input.search ? `%${input.search}%` : null})
           order by s.trigger_point, s.sort_order, s.name
           limit 200
        `,
        "objects",
      );
      return { scripts: rows, href: "/admin/scripts" };
    },
  }),
  definition({
    name: "save_user_script",
    title: "Save User Script",
    description:
      "Create and validate a script. Set isActive to true to deploy it; active scheduled scripts require a production organization. Use list_user_scripts to verify the saved row.",
    inputSchema: z.object({ ...writeFields, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "scripts.manage"),
    featureKey: "scripts",
    execute: async (context, input) => {
      await assertScripts(context);
      const orgId = context.authz.user.orgId;
      const actorId = context.authz.user.id;
      assertScriptConfiguration(input);
      await assertScriptSaver(orgId, actorId, input);
      const cron = input.triggerPoint === "scheduled" ? String(input.cron ?? "").trim() : null;
      const endpointSlug =
        input.triggerPoint === "endpoint" ? String(input.endpointSlug ?? "").trim() : null;
      let nextRunAt: Date | null = null;
      if (cron && input.isActive !== false) {
        try {
          await assertProductionEnvForScheduledScript(orgId);
          nextRunAt = computeScheduledScriptNextRunAt(cron);
        } catch (error) {
          settleScriptWriteError(error);
        }
      }
      const result = await createUserScript({
        orgId,
        actorId,
        requestId: context.requestId,
        input: { ...input, endpointSlug, cron },
        nextRunAt,
      });
      if (result.kind === "feature_disabled") throw notFound("script");
      const id = String(result.row.id);
      return {
        ok: true,
        scriptId: id,
        status: input.isActive === false ? "inactive" : "active",
        href: scriptHref(id),
      };
    },
  }),
  definition({
    name: "update_user_script",
    title: "Update User Script",
    description:
      "Replace a saved script's configuration and deployment state. Supply the current fields from list_user_scripts and the script source; set isActive true to deploy or false to deactivate it.",
    inputSchema: z.object({ id: UUID, ...writeFields, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "scripts.manage"),
    featureKey: "scripts",
    execute: async (context, input) => {
      await assertScripts(context);
      const orgId = context.authz.user.orgId;
      const actorId = context.authz.user.id;
      assertScriptConfiguration(input);
      await assertScriptSaver(orgId, actorId, input);
      const cron = input.triggerPoint === "scheduled" ? String(input.cron ?? "").trim() : null;
      const endpointSlug =
        input.triggerPoint === "endpoint" ? String(input.endpointSlug ?? "").trim() : null;
      try {
        const result = await updateUserScript({
          orgId,
          actorId,
          requestId: context.requestId,
          id: input.id,
          input: { ...input, endpointSlug, cron },
        });
        if (result.kind === "feature_disabled" || result.kind === "missing")
          throw notFound("script");
        return {
          ok: true,
          scriptId: input.id,
          status: input.isActive === false ? "inactive" : "active",
          href: scriptHref(input.id),
        };
      } catch (error) {
        settleScriptWriteError(error);
      }
    },
  }),
  definition({
    name: "delete_user_script",
    title: "Delete User Script",
    description:
      "Delete a script only when it has no execution history. If history exists, deactivate it with update_user_script to preserve the audit trail.",
    inputSchema: z.object({ id: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "scripts.manage"),
    featureKey: "scripts",
    execute: async (context, input) => {
      await assertScripts(context);
      const result = await deleteUserScript({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        requestId: context.requestId,
        id: input.id,
      });
      if (result.kind === "feature_disabled" || result.kind === "missing") throw notFound("script");
      if (result.kind === "history")
        throw conflict(
          "This script has run history and cannot be deleted. Deactivate it instead to preserve its audit history.",
          { code: "SCRIPT_HAS_RUN_HISTORY" },
        );
      return { ok: true, scriptId: input.id, status: "deleted", href: "/admin/scripts" };
    },
  }),
  definition({
    name: "run_user_script",
    title: "Run User Script",
    description:
      "Run an active scheduled or bulk script now; other trigger types run only when their native event occurs. Use list_user_scripts for the id, then inspect the run in the script drawer.",
    inputSchema: z.object({ id: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "scripts.manage"),
    featureKey: "scripts",
    execute: async (context, input) => {
      await assertScripts(context);
      const orgId = context.authz.user.orgId;
      const actorId = context.authz.user.id;
      const existing = await findUserScriptForRun(orgId, input.id);
      if (!existing) throw notFound("script");
      if (!existing.is_active)
        throw conflict("Activate this script before running it.", { code: "SCRIPT_INACTIVE" });
      if (existing.trigger_point !== "scheduled" && existing.trigger_point !== "bulk")
        throw invalidInput("Run now is available only for scheduled and bulk scripts.", {
          code: "SCRIPT_TRIGGER_NOT_RUNNABLE",
        });
      if (existing.trigger_point === "bulk") {
        const runKey = bulkRunClientKey(input.idempotencyKey);
        const claim = await claimBulkRunKey({ orgId, actorId, scriptId: input.id, key: runKey });
        if (claim.status === "completed")
          return {
            ...(claim.response as Record<string, unknown>),
            replayed: true,
            href: scriptHref(input.id),
          };
        if (claim.status === "inflight")
          throw conflict("A run with this key is already in progress.", {
            code: "SCRIPT_RUN_IN_PROGRESS",
          });
        if (claim.status === "mismatched")
          throw conflict("This run key is already in use by a different script.", {
            code: "SCRIPT_RUN_KEY_MISMATCH",
          });
        const outcome = await runBulkScript(input.id, orgId, {
          actorId,
          idempotencyScope: bulkRunIdempotencyScope(runKey),
        });
        const response = { queued: false, ...outcome };
        const completed = await completeBulkRunKey({
          orgId,
          actorId,
          scriptId: input.id,
          key: runKey,
          response,
        });
        if (!completed)
          throw conflict("The script ran but its retry key could not be finalized.", {
            code: "SCRIPT_RUN_KEY_NOT_FINALIZED",
          });
        return { ok: true, ...response, scriptId: input.id, href: scriptHref(input.id) };
      }
      let nextRunAt: Date;
      try {
        nextRunAt = computeScheduledScriptNextRunAt(existing.cron);
      } catch (error) {
        throw invalidInput(error instanceof Error ? error.message : "invalid cron expression", {
          code: "invalid_scheduled_script_cron",
          field: "cron",
        });
      }
      const outcome = await runScheduledScript(input.id, orgId, { actorId });
      await advanceScheduledScriptCursor({
        orgId,
        id: input.id,
        cron: existing.cron,
        cursor: existing.cursor,
        nextRunAt,
      });
      return {
        ok: true,
        ...outcome,
        scriptId: input.id,
        status: outcome.status,
        href: scriptHref(input.id),
      };
    },
  }),
];
