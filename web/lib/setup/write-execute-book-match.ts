import { coerceBoolean } from "./coerce";
import type { SetupEntity } from "./types";

/**
 * Request-controlled match image for the book entities: submitted values
 * only. The selected/active flags derive from concurrent table state
 * (first-book auto-promotion), so comparing them would turn a genuine
 * retry into a conflict; the claim compares this image against the stored
 * one, never against the derived row.
 */
export function setupBookMatch(args: {
  body: Record<string, unknown>;
  entity: SetupEntity;
  orgId: string;
  actorId: string;
}): Record<string, unknown> {
  const { body, entity, orgId, actorId } = args;
  return {
    code: String(body.code),
    name: String(body.name),
    ...(entity.key === "accounting-books"
      ? { is_primary: body.isPrimary === undefined ? null : coerceBoolean(body.isPrimary) }
      : { is_default: body.isDefault === undefined ? null : coerceBoolean(body.isDefault) }),
    is_active: body.isActive === undefined ? null : coerceBoolean(body.isActive),
    ...(entity.key === "accounting-books" || body.currency === undefined
      ? {}
      : { currency: String(body.currency) }),
    org_id: orgId,
    created_by: actorId,
    updated_by: actorId,
  };
}
