import { z } from "zod";

/**
 * The house record-identifier shape: 8-4-4-4-12 hex. Every id the database
 * stores in a uuid column has this shape, including ids that are not RFC 9562
 * variant/version UUIDs — sandbox and sample organizations derive their ids
 * deterministically from the source id and a seed, so their version and
 * variant nibbles are arbitrary hex. Validators must therefore accept the
 * shape, never only RFC-versioned UUIDs (zod's `.uuid()` / `z.uuid()`).
 *
 * Written with an explicit A-F class and NO case-insensitive flag: JSON
 * Schema patterns carry no flags, so tool and OpenAPI schemas emit this same
 * source and every consumer validates exactly the values zod does.
 *
 * Engine and web code import these through `@openbooks/engine/platform/identifiers`
 * (engine/src/platform/uuid.ts); this package owns them because it is the
 * lowest layer that both the engine and the shared form schemas depend on.
 */
export const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export const UUID_MESSAGE = "must be a valid id";

/** A refusal message, or zod's message/error parameter object. */
export type UuidStringParams = string | { error?: string; message?: string };

/**
 * The one zod schema for a record identifier. The optional message applies to
 * both a non-string value and a malformed string, so a field-specific remedy
 * reaches the operator either way.
 */
export function uuidString(params?: UuidStringParams) {
  return z.string(params).regex(UUID_RE, params ?? UUID_MESSAGE);
}
