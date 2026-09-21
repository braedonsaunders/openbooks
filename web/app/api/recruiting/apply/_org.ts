import { sql } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/platform/db.ts";
import { RecruitingError } from "@openbooks/engine/src/hrm/recruiting/errors.ts";
import { applyViaPosting } from "@openbooks/engine/src/hrm/recruiting/postings.ts";

/**
 * Public-apply org resolution (HR-18). The posting id is public (it rides
 * the career page), so the org resolves through the posting row under
 * bypass (the email-action route precedent) — the token-free counterpart
 * to the signed book/offer/feed links. Everything else runs inside the
 * resolved org through applyViaPosting.
 */
export async function applyViaPostingForOrg(query: {
  postingId: string;
  displayName: unknown;
  email?: unknown;
  phone?: unknown;
  consentFutureRoles?: boolean;
}): Promise<{ applicationId: string; candidateId: string }> {
  const row = await withBypassContext(async () => {
    const found = (await db.execute<{ orgId: string }>(sql`
      select org_id as "orgId" from hrm_job_postings where id = ${query.postingId}
    `)).rows[0];
    return found ?? null;
  });
  if (!row) {
    throw new RecruitingError("NOT_FOUND", "this posting is not accepting applications");
  }
  return applyViaPosting({ orgId: row.orgId, ...query });
}
