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

export function requireReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "a non-blank reason is required — record why this change is made");
  }
  return reason.trim();
}

export function requireCivilDate(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
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
