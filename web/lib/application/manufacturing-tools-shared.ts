import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import { withOrgTransaction } from "@openbooks/engine/platform/db";
import { ManufacturingError } from "@openbooks/engine/manufacturing/errors";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { ApplicationError, conflict, forbidden, invalidInput, notFound } from "./errors";

export const UUID = (label = "UUID copied from a manufacturing read result") =>
  z.string().regex(UUID_RE).describe(`${label}; never invent an identifier.`);

export const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("Calendar date in YYYY-MM-DD format.");
export const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,120}$/)
  .describe("Unique retry key for this exact mutation.");
export const DECIMAL = z
  .string()
  .max(128)
  .regex(/^-?\d+(?:\.\d+)?$/)
  .describe("Exact decimal string; do not send a JSON number.");

/** Adapt a public retry key to UUID-backed manufacturing commands that use it as a row id. */
export function nativeIdempotencyKey(key: string): string {
  if (UUID_RE.test(key)) return key;
  const chars = createHash("sha256").update(key).digest("hex").slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x03) | 0x08).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function assertPermission(context: ApplicationContext, permission: string): void {
  assertApplicationPermission(context, permission);
}

export function assertUnrestricted(context: ApplicationContext): void {
  if (context.authz.allowedSubsidiaryIds !== null) throw forbidden("subsidiary.unrestricted");
}

/** Direct manufacturing records outside an allowed entity are hidden as missing. */
export function assertVisibleSubsidiary(
  context: ApplicationContext,
  subsidiaryId: string | null | undefined,
): void {
  const allowed = context.authz.allowedSubsidiaryIds;
  if (allowed !== null && (!subsidiaryId || !allowed.has(subsidiaryId))) throw notFound("record");
}

export async function inOrg<T>(context: ApplicationContext, work: () => Promise<T>): Promise<T> {
  return withOrgTransaction(context.authz.user.orgId, work);
}

export async function runManufacturing<T>(
  context: ApplicationContext,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await inOrg(context, work);
  } catch (error) {
    settleManufacturingRefusal(error);
  }
}

/** Keep manufacturing refusal status, message and actionable remedy intact for adapters. */
export function settleManufacturingRefusal(error: unknown): never {
  if (error instanceof ManufacturingError) {
    const details: Record<string, unknown> = { code: error.code };
    if (error.field) details.field = error.field;
    if (error.remedy) details.remedy = error.remedy;
    if (error.status === 403) throw new ApplicationError("forbidden", error.message, 403, details);
    if (error.status === 404) throw new ApplicationError("not_found", error.message, 404, details);
    if (error.status === 409) throw conflict(error.message, details);
    throw invalidInput(error.message, details);
  }
  throw error;
}

export function recordHref(view: "work-orders" | "work-centers" | "routings" | "mrp", id: string) {
  const path = view === "mrp" ? "/manufacturing/mrp" : `/manufacturing/${view}`;
  return `${path}?record=${encodeURIComponent(id)}`;
}

export function qualityHref(id: string) {
  return `/manufacturing/quality?inspection=${encodeURIComponent(id)}`;
}
