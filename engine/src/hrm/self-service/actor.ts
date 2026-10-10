import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../../platform/db.ts";
import { inputGuards } from "../input-guards.ts";

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

const { requireId } = inputGuards((message) => new SelfServiceError("REFUSED", message));

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
  const org = requireId(orgId, "orgId");
  const user = requireId(userId, "userId");
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

/**
 * The actor's own employment binding for a filing call. Loads the
 * employments on the trusted runner and proves the named one is the
 * actor's own. An empty set means the person holds no employment at all:
 * the proposal cannot be filed, let alone approved, so the refusal names
 * the hire remedy for the person's administrator — self-service cannot
 * mint its own employment. A non-empty set that excludes the named id
 * means the proposal rides someone else's record, which HR files instead.
 */
export async function ownEmploymentOrHireRemedy(
  exec: SqlExecutor,
  args: { orgId: string; actorId: string; employmentId: string },
): Promise<readonly string[]> {
  const { loadOwnEmploymentIds } = await import("../authorization.ts");
  const own = await loadOwnEmploymentIds(exec, args.orgId, args.actorId);
  if (own.length === 0) {
    throw new SelfServiceError(
      "FORBIDDEN",
      "your person has no employment record yet, so this change has nothing to file against — ask your administrator to record your hire with the HRM Hire action, then file this change again",
    );
  }
  if (!own.includes(args.employmentId)) {
    throw new SelfServiceError(
      "FORBIDDEN",
      "self-service changes file only against your own employment — HR files anything else as an employment change",
    );
  }
  return own;
}
