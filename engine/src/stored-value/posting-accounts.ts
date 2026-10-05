import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { loadStoredValueProgram, programLiabilityAccount } from "./accounts.ts";

/**
 * Per-line liability accounts for gift card sale lines, resolved lazily by
 * postDocument like the revenue-recognition deferral map. A gift card sale
 * credits the liability, never revenue — and never the line's income
 * account, which for a gift card item is only a fallback.
 */
export async function resolveStoredValueLiabilityByLine(
  runner: SqlExecutor,
  documentId: string,
  orgId: string,
): Promise<Map<string, string>> {
  const rows = (await runner.execute<{ line_id: string; program_id: string | null }>(sql`
    select dl.id as line_id, dl.custom->>'storedValueProgramId' as program_id
      from document_lines dl
      join items it on it.id = dl.item_id and it.org_id = dl.org_id
     where dl.document_id = ${documentId} and dl.org_id = ${orgId}
       and it.kind = 'gift_card'
  `)).rows;
  const map = new Map<string, string>();
  for (const row of rows) {
    if (!row.program_id) {
      throw new PostingError(
        "a gift card sale line names no issuing program; set the gift card program on the sale line before posting",
      );
    }
    const program = await loadStoredValueProgram(orgId, row.program_id, runner);
    if (program.kind !== "gift_card" || !program.isActive) {
      throw new PostingError(
        `program ${program.name} cannot issue gift cards; set an active gift card program on the sale line before posting`,
      );
    }
    map.set(row.line_id, await programLiabilityAccount(orgId, program, runner));
  }
  return map;
}

/**
 * Liability account for a "refund to store credit" credit memo, which posts
 * CR store-credit liability instead of AR. Refuses by name when the program
 * is missing, inactive, or the wrong kind.
 */
export async function resolveStoreCreditLiability(
  runner: SqlExecutor,
  orgId: string,
  programId: string,
): Promise<string> {
  const program = await loadStoredValueProgram(orgId, programId, runner);
  if (program.kind !== "store_credit" || !program.isActive) {
    throw new PostingError(
      `program ${program.name} cannot issue store credit; choose an active store credit program on the credit memo before posting`,
    );
  }
  return programLiabilityAccount(orgId, program, runner);
}
