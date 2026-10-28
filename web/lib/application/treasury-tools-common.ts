import "server-only";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { orgContext } from "@openbooks/engine/platform/db";
import { isFeatureEnabled } from "../features";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput, notFound } from "./errors";

export const UUID = z
  .string()
  .regex(UUID_RE)
  .describe("UUID copied from a native read result; never invent one.");
export const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
export const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
export const MONEY = z
  .string()
  .regex(/^-?\d+(?:\.\d{1,4})?$/)
  .describe("Exact decimal amount as a string; do not use a JSON number.");

/** Apply the same permission and optional-feature fences as the session route. */
export async function assertTreasuryGate(
  context: ApplicationContext,
  permission: string,
  feature?: string,
): Promise<void> {
  assertApplicationPermission(context, permission);
  if (feature && !(await isFeatureEnabled(context.authz.user.orgId, feature))) {
    throw notFound(feature);
  }
}

/** Preserve typed domain refusals, including their actionable remedy. */
export function settleDomainRefusal(error: unknown, fallbackStatus?: 409 | 422): never {
  if (error instanceof ApplicationError) throw error;
  if (fallbackStatus && error instanceof Error) {
    if (fallbackStatus === 409) throw conflict(error.message);
    throw invalidInput(error.message);
  }
  if (!error || typeof error !== "object") throw error;
  const value = error as {
    message?: unknown;
    status?: unknown;
    remedy?: unknown;
    code?: unknown;
    field?: unknown;
    details?: unknown;
  };
  if (
    typeof value.message !== "string" ||
    typeof value.status !== "number" ||
    value.status < 400 ||
    value.status >= 500
  ) {
    throw error;
  }
  const details: Record<string, unknown> = {};
  if (typeof value.code === "string") details.domainCode = value.code;
  if (typeof value.field === "string") details.field = value.field;
  if (typeof value.remedy === "string") details.remedy = value.remedy;
  if (value.details && typeof value.details === "object") Object.assign(details, value.details);
  switch (value.status) {
    case 403:
      throw new ApplicationError("forbidden", value.message, 403, details);
    case 404:
      throw new ApplicationError("not_found", value.message, 404, details);
    case 409:
      throw conflict(value.message, details);
    case 422:
      throw invalidInput(value.message, details);
    default:
      throw new ApplicationError("invalid_input", value.message, value.status, details);
  }
}

export function assertUnrestricted(context: ApplicationContext): void {
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

/** Run a deliberately multi-transaction provider operation outside the command claim transaction. */
export function runOutsideTenantTransaction<T>(
  context: ApplicationContext,
  action: () => Promise<T>,
): Promise<T> {
  return orgContext.run({ orgId: context.authz.user.orgId, bypass: false } as never, action);
}
