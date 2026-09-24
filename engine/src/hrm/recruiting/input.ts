import { isCivilDate } from "../temporal.ts";
import { RecruitingError } from "./errors.ts";

/** UUID-shaped input validation shared by every recruiting service. */
export function requireOrgId(orgId: unknown): string {
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new RecruitingError("INVALID_INPUT", "orgId must be a non-empty string");
  }
  return orgId;
}

export function requireActorId(actorId: unknown): string {
  if (typeof actorId !== "string" || actorId.length === 0) {
    throw new RecruitingError("INVALID_INPUT", "actorId must be a non-empty string");
  }
  return actorId;
}

export function requireId(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RecruitingError("INVALID_INPUT", `${name} must be a non-empty string`);
  }
  return value;
}

/** ISO 8601 instant with an explicit UTC designator or numeric offset. */
export function isIsoInstantWithOffset(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  const offsetHours = match[9] ? Number(match[9]) : 0;
  const offsetMinutes = match[10] ? Number(match[10]) : 0;
  if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) return false;
  const direction = match[8] === "+" ? 1 : match[8] === "-" ? -1 : 0;
  const local = new Date(timestamp + direction * (offsetHours * 60 + offsetMinutes) * 60_000);
  return [
    local.getUTCFullYear(),
    local.getUTCMonth() + 1,
    local.getUTCDate(),
    local.getUTCHours(),
    local.getUTCMinutes(),
    local.getUTCSeconds(),
  ].every((part, index) => part === Number(match[index + 1]));
}

export function requireReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "a non-blank reason is required — record why this change is made");
  }
  return reason.trim();
}

export function requireCivilDate(value: unknown, name: string): string {
  if (typeof value !== "string" || !isCivilDate(value)) {
    throw new RecruitingError("INVALID_INPUT", `${name} must be YYYY-MM-DD`);
  }
  return value;
}

export function optionalCivilDate(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  return requireCivilDate(value, name);
}

/** Postgres unique violation through Drizzle's wrapper (code rides cause). */
export function isUniqueViolation(error: unknown): boolean {
  const code =
    (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
  return code === "23505";
}
