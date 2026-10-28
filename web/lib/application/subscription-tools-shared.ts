import "server-only";
import { z, type ZodTypeAny } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { isFeatureEnabled } from "@/lib/features";
import { can } from "../authz";
import {
  assertApplicationPermission,
  assertSubsidiaryAccess,
  type ApplicationContext,
} from "./context";
import { ApplicationError, conflict, forbidden, invalidInput, notFound } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

export const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID returned by a native list or get command; never invent one.");
export const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
export const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

export function requireUnrestrictedScope(context: ApplicationContext): void {
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

export function settleDomainRefusal(error: unknown): never {
  if (error instanceof ApplicationError) throw error;
  if (error && typeof error === "object") {
    const item = error as {
      name?: unknown;
      message?: unknown;
      status?: unknown;
      code?: unknown;
      remedy?: unknown;
      field?: unknown;
    };
    if (
      item.name === "CommerceError" &&
      ["channel_not_found", "channel_order_unknown", "inbound_event_not_found"].includes(
        String(item.code),
      ) &&
      typeof item.message === "string"
    ) {
      throw new ApplicationError("not_found", item.message, 404, { domainCode: item.code });
    }
    if (item.name === "ScopeNotFoundError" && typeof item.message === "string")
      throw new ApplicationError("not_found", item.message, 404);
    if (item.name === "RevenueRecognitionError" && typeof item.message === "string") {
      const details: Record<string, unknown> = {};
      if (typeof item.code === "string") details.domainCode = item.code;
      if (typeof item.remedy === "string") details.remedy = item.remedy;
      if (typeof item.field === "string") details.field = item.field;
      throw invalidInput(item.message, details);
    }
    if (item.name === "StaleRecognitionPreviewError" && typeof item.message === "string")
      throw conflict(item.message);
    if (typeof item.message === "string" && typeof item.status === "number") {
      const details: Record<string, unknown> = {};
      if (typeof item.code === "string") details.domainCode = item.code;
      if (typeof item.remedy === "string") details.remedy = item.remedy;
      if (typeof item.field === "string") details.field = item.field;
      if (item.status === 403) throw new ApplicationError("forbidden", item.message, 403, details);
      if (item.status === 404) throw new ApplicationError("not_found", item.message, 404, details);
      if (item.status === 409) throw conflict(item.message, details);
      if (item.status === 400 || item.status === 422) throw invalidInput(item.message, details);
    }
  }
  throw error;
}

export function readTool<T extends ZodTypeAny>(args: {
  name: string;
  title: string;
  description: string;
  permission: string;
  featureKey: string;
  openWorld?: boolean;
  inputSchema: T;
  execute: (context: ApplicationContext, input: z.infer<T>) => Promise<Record<string, unknown>>;
}): ApplicationToolDefinition {
  return definition({
    name: args.name,
    title: args.title,
    description: args.description,
    inputSchema: args.inputSchema,
    readOnly: true,
    destructive: false,
    openWorld: args.openWorld ?? false,
    assistantConfirmation: "never",
    featureKey: args.featureKey,
    visibleTo: (authz) => can(authz, args.permission),
    execute: async (context, input) => {
      assertApplicationPermission(context, args.permission);
      if (!(await isFeatureEnabled(context.authz.user.orgId, args.featureKey)))
        throw notFound("route");
      try {
        return await args.execute(context, input);
      } catch (error) {
        settleDomainRefusal(error);
      }
    },
  });
}

export function mutationTool<T extends ZodTypeAny>(args: {
  name: string;
  title: string;
  description: string;
  permission: string;
  featureKey: string;
  inputSchema: T;
  destructive?: boolean;
  openWorld?: boolean;
  execute: (context: ApplicationContext, input: z.infer<T>) => Promise<Record<string, unknown>>;
}): ApplicationToolDefinition {
  return definition({
    name: args.name,
    title: args.title,
    description: args.description,
    inputSchema: args.inputSchema,
    readOnly: false,
    destructive: args.destructive ?? false,
    openWorld: args.openWorld ?? false,
    assistantConfirmation: "always",
    featureKey: args.featureKey,
    visibleTo: (authz) => can(authz, args.permission),
    execute: async (context, input) => {
      assertApplicationPermission(context, args.permission);
      if (!(await isFeatureEnabled(context.authz.user.orgId, args.featureKey)))
        throw notFound("route");
      try {
        return await args.execute(context, input);
      } catch (error) {
        settleDomainRefusal(error);
      }
    },
  });
}

export function assertScopedTarget(
  context: ApplicationContext,
  subsidiaryId: string | null | undefined,
): void {
  assertSubsidiaryAccess(context, subsidiaryId);
}
