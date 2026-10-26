import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { exactMoney, isoDate, nullableExactMoney, uuidId } from "../../../lib/api/json";

/**
 * Shared body atoms for the compound-asset, proposal, construction-in-progress,
 * maintenance and insurance routes. Money is exact decimal text, dates are
 * calendar dates, references are uuids; domain refusals come from the engine.
 */
export const reasonText = z
  .string({ error: "state a reason" })
  .trim()
  .min(1, "state a reason")
  .max(2000, "reasons are limited to 2,000 characters");
export const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
export const money = (label: string) =>
  exactMoney(`${label} must be a decimal string; JSON numbers are refused`);
export const optionalMoney = (label: string) =>
  nullableExactMoney(`${label} must be a decimal string; JSON numbers are refused`).optional();
export const calendarDate = (label: string) => isoDate(`${label} must be a valid calendar date`);
export const id = uuidId;
export const idempotencyKey = uuidString("idempotencyKey must be a uuid");

/** The caller's legal-entity scope in the shape the engine services take. */
export function scopeOf(gate: { allowedSubsidiaryIds: Set<string> | null }): string[] | null {
  return gate.allowedSubsidiaryIds ? [...gate.allowedSubsidiaryIds] : null;
}
