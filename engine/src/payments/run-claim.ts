import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PaymentRunPostingClaimFencedError } from "./payment-errors.ts";
export type PostingClaim = { token: string };

/**
 * Re-assert exclusive ownership of the posting lifecycle (fence + heartbeat).
 *
 * Zero rows means the claim was replaced or retired while we worked: fail
 * closed before touching any child row. When the claim holds, the token is
 * published to the storage layer for the remainder of this transaction — the
 * payment-instruction fence trigger (migration 0015) rejects any instruction
 * mutation on this run from a writer that presents none or a superseded token,
 * so downstream instruction writes cannot outrun the claim that authorizes
 * them even through a future call path that forgets to check.
 */
export async function assertPostingClaimLive(
  runId: string,
  orgId: string,
  claim: PostingClaim,
): Promise<void> {
  const fenced = await db.execute<{ id: string }>(sql`
    update payment_runs
       set posting_claimed_at = now()
     where id = ${runId} and org_id = ${orgId}
       and status = 'processing'
       and posting_claim_token = ${claim.token}
     returning id
  `);
  if (!fenced.rows[0]) throw new PaymentRunPostingClaimFencedError(runId);
  await db.execute(sql`
    select set_config('openbooks.payment_run_claim', ${`${runId}:${claim.token}`}, true)
  `);
}
