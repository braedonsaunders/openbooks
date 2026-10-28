import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";
import type { ApplicationContext } from "./context";
import type { ApplicationToolDefinition } from "./tool-definition";
import { definition } from "./tool-definition";
import { isFeatureEnabled } from "../features";
import { FieldTimeError } from "@openbooks/engine/hrm/field-time/errors";
import { ResourcingRefusal } from "@openbooks/engine/resourcing/errors";
import { ScheduleError } from "@openbooks/engine/schedule-boards/errors";
import { TimeApprovalRefusal } from "../time-approval-refusal";
import { TimeWorkTargetError } from "@openbooks/engine/projects/time-work-target";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { TimeAmendmentRefusal } from "../time-amendment";

export function timeDefinition<TSchema extends z.ZodType>(
  args: Omit<ApplicationToolDefinition, "execute" | "inputSchema" | "mutationProtection"> & {
    inputSchema: TSchema;
    execute: (
      context: ApplicationContext,
      input: z.infer<TSchema>,
    ) => Promise<Record<string, unknown>>;
    authorizeReplay?: (context: ApplicationContext, input: z.infer<TSchema>) => Promise<void>;
  },
): ApplicationToolDefinition {
  const featureKey = args.featureKey;
  const execute = args.execute;
  const authorizeReplay = args.authorizeReplay;
  const assertFeature = async (context: ApplicationContext) => {
    if (featureKey && !(await isFeatureEnabled(context.authz.user.orgId, featureKey))) {
      throw notFound("record");
    }
  };
  return definition({
    ...args,
    authorizeReplay: async (context, input) => {
      await assertFeature(context);
      if (!args.visibleTo(context.authz)) {
        throw new ApplicationError(
          "forbidden",
          "You do not have permission to use this time operation.",
          403,
        );
      }
      await authorizeReplay?.(context, input);
    },
    execute: async (context, input) => {
      await assertFeature(context);
      return execute(context, input);
    },
  });
}

export const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a native list or detail result.");

export const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Civil date in YYYY-MM-DD format.");

export const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

export const DECIMAL = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/)
  .describe("Exact non-negative decimal string; do not send a JSON number.");

export function actor(context: ApplicationContext) {
  return { orgId: context.authz.user.orgId, actorId: context.authz.user.id };
}

/** Preserve the domain refusal's message, status, code and actionable remedy. */
export function settleTimeRefusal(error: unknown): never {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof ResourcingRefusal) {
    const details = {
      code: error.code,
      remedy: error.remedy,
      ...(error.field ? { field: error.field } : {}),
    };
    if (error.status === 409) throw conflict(error.message, details);
    if (error.status === 400)
      throw new ApplicationError("invalid_input", error.message, 400, details);
    throw invalidInput(error.message, details);
  }
  if (error instanceof ScheduleError) {
    const details = { code: error.code, ...(error.remedy ? { remedy: error.remedy } : {}) };
    if (error.status === 403) throw new ApplicationError("forbidden", error.message, 403, details);
    if (error.status === 404) throw new ApplicationError("not_found", error.message, 404, details);
    if (error.status === 409) throw conflict(error.message, details);
    if (error.status === 400)
      throw new ApplicationError("invalid_input", error.message, 400, details);
    throw invalidInput(error.message, details);
  }
  if (error instanceof TimeApprovalRefusal || error instanceof TimeWorkTargetError) {
    const refusal = error as Error & { status?: number; code?: string; remedy?: string };
    const status = refusal.status ?? 422;
    const details = {
      ...(refusal.code ? { code: refusal.code } : {}),
      ...(refusal.remedy ? { remedy: refusal.remedy } : {}),
    };
    if (status === 403) throw new ApplicationError("forbidden", error.message, 403, details);
    if (status === 404) throw new ApplicationError("not_found", error.message, 404, details);
    if (status === 409) throw conflict(error.message, details);
    if (status === 400) throw new ApplicationError("invalid_input", error.message, 400, details);
    throw invalidInput(error.message, details);
  }
  if (error instanceof TimeAmendmentRefusal)
    throw invalidInput(error.message, { remedy: error.message });
  if (error instanceof ScopeNotFoundError) throw notFound("record");
  if (error instanceof FieldTimeError) {
    const details = { code: error.code };
    if (error.code === "client_event_conflict") throw conflict(error.message, details);
    throw invalidInput(error.message, details);
  }
  throw error;
}

export async function settleTimeResponse(response: Response): Promise<Record<string, unknown>> {
  if (response.ok) {
    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const message =
    typeof body.error === "string"
      ? body.error
      : typeof body.message === "string"
        ? body.message
        : "The time operation was refused.";
  const details =
    typeof body.remedy === "string" || typeof body.code === "string" ? body : undefined;
  if (response.status === 403) throw new ApplicationError("forbidden", message, 403, details);
  if (response.status === 404) throw new ApplicationError("not_found", message, 404, details);
  if (response.status === 409) throw conflict(message, details);
  if (response.status === 400) throw new ApplicationError("invalid_input", message, 400, details);
  throw invalidInput(message, details);
}
