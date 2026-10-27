import "server-only";
import { z, type ZodTypeAny } from "zod";
import { can, type Authz } from "../authz";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { postingRefusal } from "../api/responses";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput } from "./errors";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

export const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a list or get tool result; never invent one.");
export const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
export const MONEY = z
  .string()
  .regex(/^-?\d+(?:\.\d{1,8})?$/)
  .describe("Exact decimal amount as text; JSON numbers are not accepted.");
export const INTEGER_TEXT = z
  .string()
  .regex(/^\d{1,19}$/)
  .describe("Whole quantity represented as text.");
export const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

export function field<T extends ZodTypeAny>(schema: T, description: string): T {
  return schema.describe(description) as T;
}

export function describeObjectFields<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  descriptions: Partial<Record<keyof T["shape"] & string, string>>,
): T {
  const shape = Object.fromEntries(
    Object.entries(schema.shape).map(([key, value]) => [
      key,
      value.describe(descriptions[key as keyof T["shape"] & string] ?? `Value for ${key}.`),
    ]),
  ) as z.ZodRawShape;
  return schema.extend(shape) as T;
}

export const visible = (permission: string) => (authz: Authz) => can(authz, permission);

export function requirePermission(context: ApplicationContext, permission: string): void {
  assertApplicationPermission(context, permission);
}

export function subsidiaryScope(context: ApplicationContext): string[] | null {
  return context.authz.allowedSubsidiaryIds === null
    ? null
    : [...context.authz.allowedSubsidiaryIds];
}

export function requireUnrestricted(context: ApplicationContext): void {
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

export function resultWithHref(value: unknown, href: string): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return { ok: true, ...(value as Record<string, unknown>), href };
  }
  return { ok: true, result: value, href };
}

/** Preserve the domain refusal's public message, status, remedy, and evidence. */
export async function settleCapitalRefusal(error: unknown): Promise<never> {
  if (error instanceof Error && error.constructor !== Error) {
    const record = error as Error & {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
      remedy?: unknown;
      field?: unknown;
      details?: unknown;
    };
    const status =
      typeof record.status === "number"
        ? record.status
        : typeof record.statusCode === "number"
          ? record.statusCode
          : undefined;
    if (status !== undefined && Number.isInteger(status) && status >= 400 && status < 500) {
      const details: Record<string, unknown> = {};
      if (typeof record.code === "string") details.code = record.code;
      if (typeof record.remedy === "string") details.remedy = record.remedy;
      if (typeof record.field === "string") details.field = record.field;
      if (
        record.details !== null &&
        typeof record.details === "object" &&
        !Array.isArray(record.details)
      ) {
        details.details = record.details;
      }
      if (status === 403) throw new ApplicationError("forbidden", error.message, status, details);
      if (status === 404) throw new ApplicationError("not_found", error.message, status, details);
      if (status === 409) throw conflict(error.message, details);
      throw invalidInput(error.message, details);
    }
  }

  const response = postingRefusal(error);
  if (response) {
    const body = (await response.json()) as Record<string, unknown>;
    const message = typeof body.error === "string" ? body.error : "request refused";
    const status = response.status;
    if (status === 403) throw new ApplicationError("forbidden", message, status, body);
    if (status === 404) throw new ApplicationError("not_found", message, status, body);
    if (status === 409) throw conflict(message, body);
    throw invalidInput(message, body);
  }
  throw error;
}

function permissionsFor(permission: string | readonly string[]): readonly string[] {
  return typeof permission === "string" ? [permission] : permission;
}

export function capitalMutation<T extends ZodTypeAny>(args: {
  name: string;
  title: string;
  description: string;
  inputSchema: T;
  permission: string | readonly string[];
  featureKey: string;
  destructive?: boolean;
  execute: (context: ApplicationContext, input: z.infer<T>) => Promise<Record<string, unknown>>;
}): ApplicationToolDefinition {
  return definition({
    name: args.name,
    title: args.title,
    description: args.description,
    inputSchema: args.inputSchema,
    readOnly: false,
    destructive: args.destructive ?? false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) =>
      permissionsFor(args.permission).every((permission) => can(authz, permission)),
    featureKey: args.featureKey,
    execute: async (context, input) => {
      for (const permission of permissionsFor(args.permission)) {
        requirePermission(context, permission);
      }
      try {
        return await args.execute(context, input);
      } catch (error) {
        return await settleCapitalRefusal(error);
      }
    },
  });
}

export function capitalRead<T extends ZodTypeAny>(args: {
  name: string;
  title: string;
  description: string;
  inputSchema: T;
  permission: string | readonly string[];
  featureKey: string;
  execute: (context: ApplicationContext, input: z.infer<T>) => Promise<Record<string, unknown>>;
}): ApplicationToolDefinition {
  return definition({
    name: args.name,
    title: args.title,
    description: args.description,
    inputSchema: args.inputSchema,
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) =>
      permissionsFor(args.permission).every((permission) => can(authz, permission)),
    featureKey: args.featureKey,
    execute: async (context, input) => {
      for (const permission of permissionsFor(args.permission)) {
        requirePermission(context, permission);
      }
      try {
        return await args.execute(context, input);
      } catch (error) {
        return await settleCapitalRefusal(error);
      }
    },
  });
}
