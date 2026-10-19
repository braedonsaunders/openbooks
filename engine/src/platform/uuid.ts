/**
 * House UUID check shared by every engine module and web: the 8-4-4-4-12 hex
 * shape. A bare 36-character hex-and-dashes length check is NOT a UUID
 * check — 36 dashes pass it — and an RFC 9562 variant/version check is too
 * strict: sandbox and sample organizations carry deterministically derived
 * ids whose version and variant nibbles are arbitrary hex. Actor
 * attribution, idempotency keys, audit fallbacks and request schemas must go
 * through `isUuid` / `uuidString` instead of local patterns or zod's
 * `.uuid()`. A repo-wide check (scripts/check-uuid-shapes.mjs) refuses both.
 *
 * The definitions live in `@openbooks/forms-core/identifiers`, the lowest
 * layer shared by the engine, web and the shared form schemas; this module is
 * their public engine contract (`@openbooks/engine/platform/identifiers`).
 */
export { UUID_MESSAGE, UUID_RE, isUuid, uuidString } from "@openbooks/forms-core/identifiers";
export type { UuidStringParams } from "@openbooks/forms-core/identifiers";
