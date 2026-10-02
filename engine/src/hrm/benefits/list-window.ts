import { BenefitsError } from "./errors.ts";

/** Omitted limits request the complete scoped list; supplied windows are exact. */
export function benefitListWindow(limit?: number, offset?: number): { limit: number | null; offset: number } {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000)) {
    throw new BenefitsError("INVALID_INPUT", "limit must be a whole number from 1 to 2000 — request a valid page size");
  }
  if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
    throw new BenefitsError("INVALID_INPUT", "offset must be a non-negative whole number — request a valid page position");
  }
  return { limit: limit ?? null, offset: offset ?? 0 };
}

/** Program workspaces use bounded pages through the same native list-window validation. */
export function benefitsProgramPage(query: { limit?: number; offset?: number }): { limit: number; offset: number } {
  const page = benefitListWindow(query.limit ?? 100,query.offset);
  return { limit: page.limit!,offset: page.offset };
}
