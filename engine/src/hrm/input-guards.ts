import { isUuid } from "../platform/uuid.ts";

/**
 * The one definition of the HRM service-boundary input guards. Each HRM
 * service binds them once to its own error class, so a refusal keeps the
 * service's error type and code while every service refuses with the same
 * wording.
 *
 * `kind` says which guard refused: "scope" for the tenant and actor that
 * frame the call, "input" for an id the caller supplied. Services that
 * answer the two with different codes branch on it.
 */
export type InputGuardKind = "scope" | "input";
export type InputGuardRefusal = (message: string, kind: InputGuardKind) => Error;

export interface InputGuards {
  /** The tenant scope: any non-empty string. */
  requireOrgId(orgId: unknown): string;
  /** The acting user: any non-empty string. */
  requireActorId(actorId: unknown): string;
  /** A caller-supplied id checked only for presence (non-empty string). */
  requireId(value: unknown, field: string): string;
  /** A caller-supplied id that must have the house UUID shape. */
  requireUuid(value: unknown, field: string): string;
}

export function inputGuards(refuse: InputGuardRefusal): InputGuards {
  const nonEmpty = (value: unknown, field: string, kind: InputGuardKind): string => {
    if (typeof value !== "string" || value.length === 0) {
      throw refuse(`${field} must be a non-empty string`, kind);
    }
    return value;
  };
  return {
    requireOrgId: (orgId) => nonEmpty(orgId, "orgId", "scope"),
    requireActorId: (actorId) => nonEmpty(actorId, "actorId", "scope"),
    requireId: (value, field) => nonEmpty(value, field, "input"),
    requireUuid: (value, field) => {
      if (!isUuid(value)) throw refuse(`${field} must be a uuid`, "input");
      return value;
    },
  };
}
