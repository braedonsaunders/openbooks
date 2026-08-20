import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/db.ts";
import type { ParsedSessionToken } from "./auth-token-format";

/**
 * Lightweight revocation lookup for the request proxy. The table is global
 * pre-tenant state, so no tenant bypass context is required.
 */
export async function isSessionRecordActive(token: string, parsed: ParsedSessionToken): Promise<boolean> {
  const hash = createHash("sha256").update(token).digest("hex");
  return withBypassContext(async () => {
    const result = (await db.execute<{ active: boolean }>(sql`
      select exists(
        select 1
          from auth_sessions session
          join users identity on identity.id = session.user_id and identity.is_active
         where session.id = ${parsed.sessionId}
           and session.user_id = ${parsed.userId}
           and session.token_hash = ${hash}
           and session.revoked_at is null
           and session.expires_at > now()
      ) as active
    `));
    return result.rows[0]?.active === true;
  });
}
