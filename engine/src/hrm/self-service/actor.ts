import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../../platform/db.ts";

/**
 * Self-service actor resolution (HR-9).
 *
 * Every self-service read starts here: the person link between a login and
 * an employee party is users.party_id (the Admin → Users person linkage
 * from HR-2), read on the trusted runner — never email matching, which a
 * renamed mailbox would silently break. No link means no self-service: a
 * named refusal carrying the remedy, never an empty page pretending the
 * person has no employment.
 */

export type SelfServiceCode = "NO_LINK" | "NO_TEAM" | "NOT_FOUND" | "FORBIDDEN" | "REFUSED";

export class SelfServiceError extends Error {
  readonly code: SelfServiceCode;
  constructor(code: SelfServiceCode, message: string) {
    super(message);
    this.name = "SelfServiceError";
    this.code = code;
  }
}

function requireId(field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SelfServiceError("REFUSED", `${field} must be a non-empty string`);
  }
  return value;
}

/**
 * The person behind a login. Throws NO_LINK naming the remedy when the
 * login carries no linked person (or names no user of this org at all —
 * the caller must not learn which of the two it was).
 */
export async function actorPartyOf(
  exec: SqlExecutor,
  orgId: string,
  userId: string,
): Promise<string> {
  const org = requireId("orgId", orgId);
  const user = requireId("userId", userId);
  const row = (await exec.execute<{ partyId: string | null }>(sql`
    select party_id as "partyId" from users where org_id = ${org} and id = ${user}
  `)).rows[0];
  if (!row?.partyId) {
    throw new SelfServiceError(
      "NO_LINK",
      "no person is linked to this login — ask an administrator to link your person in Admin → Users → Link person before using self-service",
    );
  }
  return row.partyId;
}
