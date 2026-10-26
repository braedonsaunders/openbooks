import { sql } from "drizzle-orm";
import {
  subsidiaryScopeAllows,
  subsidiaryVisibleFilter,
} from "../organization/subsidiary-scope.ts";
import type { SqlExecutor } from "../platform/db.ts";

export interface StoredValueCustomerCredit {
  accountId: string;
  codeLast4: string;
  currency: string;
  balanceMinor: string;
}

/** List a customer's positive store credits within the caller's visible entities. */
export async function listStoredValueCustomerCredits(
  db: SqlExecutor,
  input: {
    orgId: string;
    partyId: string;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
  },
): Promise<StoredValueCustomerCredit[] | null> {
  const party = (
    await db.execute<{ subsidiaryId: string | null }>(
      sql`
      select subsidiary_id as "subsidiaryId" from parties
       where id = ${input.partyId} and org_id = ${input.orgId}
    `,
      "objects",
    )
  )[0];
  if (
    !party ||
    !subsidiaryScopeAllows(input.allowedSubsidiaryIds, party.subsidiaryId, {
      orgWideNull: true,
    })
  ) {
    return null;
  }

  // Credit accounts carry their own entity scope, independent of the customer party.
  return db.execute<StoredValueCustomerCredit>(
    sql`
      select id as "accountId", code_last4 as "codeLast4", currency,
             balance_minor::text as "balanceMinor"
        from stored_value_accounts
       where org_id = ${input.orgId} and customer_party_id = ${input.partyId}
         and status in ('active', 'frozen') and balance_minor > 0
         ${subsidiaryVisibleFilter(sql`subsidiary_id`, input.allowedSubsidiaryIds)}
       order by currency, code_last4
    `,
    "objects",
  );
}
