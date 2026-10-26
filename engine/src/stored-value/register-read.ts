import { sql } from "drizzle-orm";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { hashStoredValueCode } from "./codes.ts";

export interface StoredValueTenderLookup {
  id: string;
  balanceMinor: string;
  currency: string;
  status: string;
  last4: string;
}

/** Resolve a stored-value code only within the caller's visible entities. */
export async function readStoredValueTenderLookup(
  db: SqlExecutor,
  input: {
    orgId: string;
    code: string;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
  },
): Promise<StoredValueTenderLookup | null> {
  const account = (
    await db.execute<StoredValueTenderLookup>(
      sql`
      select id, balance_minor::text as "balanceMinor", currency, status,
             code_last4 as "last4"
        from stored_value_accounts
       where org_id = ${input.orgId}
         and code_hash = ${hashStoredValueCode(input.orgId, input.code)}
         ${subsidiaryVisibleFilter(sql`subsidiary_id`, input.allowedSubsidiaryIds)}
    `,
      "objects",
    )
  )[0];
  return account ?? null;
}
