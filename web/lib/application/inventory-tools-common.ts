import "server-only";
import { createHash } from "node:crypto";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { isFeatureEnabled } from "../features";
import {
  InventoryError,
  InventoryIdempotencyConflictError,
  InventoryNotFoundError,
  InventoryOwnershipError,
} from "@openbooks/engine/inventory/contracts/module";
import { z } from "zod";
import { definition, type ApplicationToolDefinition } from "./tool-definition";
import type { ApplicationContext } from "./context";
import { ApplicationError, conflict, invalidInput, notFound } from "./errors";

export const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a native list or detail result.");
export const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
export const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");

/** Adapt a catalog retry token for legacy native writers that require a UUID. */
export function nativeIdempotencyUuid(key: string): string {
  if (UUID_RE.test(key)) return key;
  const hex = createHash("sha256").update(key).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

type InventoryToolArgs<T extends z.ZodTypeAny> = Omit<
  ApplicationToolDefinition,
  "execute" | "inputSchema" | "mutationProtection"
> & {
  inputSchema: T;
  execute: (context: ApplicationContext, input: z.infer<T>) => Promise<Record<string, unknown>>;
  authorizeReplay?: (context: ApplicationContext, input: z.infer<T>) => Promise<void>;
};

/** Apply the same organization feature fence to discovery reads, writes, and idempotent replays. */
export function inventoryDefinition<T extends z.ZodTypeAny>(
  args: InventoryToolArgs<T>,
): ApplicationToolDefinition {
  const { execute, authorizeReplay, ...metadata } = args;
  const assertFeature = async (context: ApplicationContext) => {
    if (
      metadata.featureKey &&
      !(await isFeatureEnabled(context.authz.user.orgId, metadata.featureKey))
    ) {
      throw notFound("route");
    }
  };
  return definition({
    ...metadata,
    execute: async (context, input) => {
      await assertFeature(context);
      return execute(context, input);
    },
    authorizeReplay: async (context, input) => {
      await assertFeature(context);
      await authorizeReplay?.(context, input);
    },
  });
}

/** Preserve typed inventory refusals and their operator remedy across transports. */
export function settleInventoryRefusal(error: unknown): never {
  if (error instanceof InventoryNotFoundError) {
    throw new ApplicationError("not_found", error.message, 404);
  }
  if (error instanceof InventoryOwnershipError) {
    throw new ApplicationError("forbidden", error.message, 403);
  }
  if (error instanceof InventoryIdempotencyConflictError) {
    throw conflict(error.message || "This retry key was already used for a different request.");
  }
  if (error instanceof InventoryError) {
    const details: Record<string, unknown> = {};
    const value = error as InventoryError & {
      status?: number;
      code?: string;
      remedy?: string;
      details?: Record<string, unknown>;
    };
    if (value.code) details.code = value.code;
    if (value.remedy) details.remedy = value.remedy;
    if (value.details) Object.assign(details, value.details);
    if (value.status === 403) throw new ApplicationError("forbidden", error.message, 403, details);
    if (value.status === 404) throw new ApplicationError("not_found", error.message, 404, details);
    if (value.status === 409) throw conflict(error.message, details);
    throw invalidInput(error.message, details);
  }
  throw error;
}

export function itemHref(itemId: string): string {
  return `/items?item=${encodeURIComponent(itemId)}`;
}

export function inventoryHref(): string {
  return "/inventory";
}
