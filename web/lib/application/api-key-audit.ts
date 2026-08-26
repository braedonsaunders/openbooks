import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";

/**
 * Durable execution evidence for API-key-authenticated requests.
 *
 * Every authenticated v1/MCP action writes one `api_key_events` row carrying
 * canonical key/request correlation (credential, method, path, status, IP,
 * user agent). The write is REQUIRED, never best-effort:
 *
 *   * Material commands pair the event with their effect: `executeIdempotent`
 *     inserts it inside the command's own claim transaction, so a storage
 *     failure rolls the mutation back instead of committing without evidence
 *     (the same fail-closed contract the file cabinet's recordFileEvent keeps).
 *   * Transport wrappers (`v1` route handlers, MCP boundaries) await one row
 *     per request attempt; a failing write fails the response closed rather
 *     than silently dropping the trail.
 *
 * Single INSERT statement lives here so both paths share exactly one event
 * shape and one source of truth.
 */

/** One durable api_key_events execution event. */
export interface ApiKeyEventInput {
  orgId: string;
  /** The credential that executed the request; null for events without one. */
  keyId: string | null;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ipAddress: string | null;
  userAgent: string | null;
  error?: string | null;
}

/**
 * Persist one execution event. Throws on storage failure so callers can fail
 * closed — never swallow here: swallowing is precisely the defect this module
 * exists to close.
 */
export async function insertApiKeyEvent(event: ApiKeyEventInput): Promise<void> {
  await db.execute(sql`
    insert into api_key_events
      (org_id, key_id, method, path, status_code, duration_ms, ip_address, user_agent, error)
    values (${event.orgId}, ${event.keyId}, ${event.method}, ${event.path},
            ${event.statusCode}, ${Math.min(Math.max(Math.trunc(event.durationMs), 0), 2_147_483_647)},
            ${event.ipAddress}, ${event.userAgent}, ${event.error ?? null})`);
}

/**
 * Transport-scoped audit metadata captured once at request entry and threaded
 * through the application layer, so a claim transaction can write the exact
 * event its command needs without touching transport types.
 */
export interface ApiRequestAudit {
  readonly method: string;
  readonly path: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  /** Request-entry epoch milliseconds; commands report their duration from it. */
  readonly startedAt: number;
}

const CLAIMED_COMMAND_EVIDENCE = Symbol("openbooks.claimedCommandEvidence");
type MutableApiRequestAudit = ApiRequestAudit & { [CLAIMED_COMMAND_EVIDENCE]?: boolean };

function asMutable(trail: ApiRequestAudit): MutableApiRequestAudit {
  return trail as MutableApiRequestAudit;
}

/**
 * Build the transport-level execution event for one finished request attempt
 * from its captured audit metadata. Status and error are supplied by the
 * caller (they are only known once the outcome exists); correlation comes
 * straight from the trail so every wrapper records identical fields. A
 * boundary whose events decompose one request (MCP tools) may refine the
 * method/path to the sub-operation without losing key/IP/user-agent capture.
 */
export function transportEvent(
  trail: ApiRequestAudit,
  identity: { orgId: string; keyId: string | null },
  status: { statusCode: number; error?: string | null },
  refinement?: { method?: string; path?: string },
): ApiKeyEventInput {
  return {
    orgId: identity.orgId,
    keyId: identity.keyId,
    method: refinement?.method ?? trail.method,
    path: refinement?.path ?? trail.path,
    statusCode: status.statusCode,
    durationMs: Date.now() - trail.startedAt,
    ipAddress: trail.ipAddress,
    userAgent: trail.userAgent,
    ...(status.error ? { error: status.error } : {}),
  };
}

/**
 * Mark the current transport's most recent material command as evidenced by an
 * event committed inside its claim transaction. Called immediately before the
 * transaction commits; the transport consumes the marker afterwards and skips
 * its duplicate event.
 */
export function markClaimedCommandEvidence(trail: ApiRequestAudit): void {
  asMutable(trail)[CLAIMED_COMMAND_EVIDENCE] = true;
}

/**
 * Consume the claimed-evidence marker. True means the just-finished command
 * already committed its own atomic event and the transport must not write a
 * second row for it.
 */
export function takeClaimedCommandEvidence(trail: ApiRequestAudit): boolean {
  const mutable = asMutable(trail);
  const claimed = mutable[CLAIMED_COMMAND_EVIDENCE] === true;
  mutable[CLAIMED_COMMAND_EVIDENCE] = false;
  return claimed;
}
