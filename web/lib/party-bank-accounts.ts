import "server-only";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { documentRevisionSql } from "@openbooks/engine/records/revision";
import { subsidiaryVisibleFilter } from "./subsidiaries";

/** Directory read shared by the party drawer and operator command catalog. */
export function loadPartyBankAccountsInCurrentTransaction(id: string, orgId: string) {
  return db.execute<Record<string, unknown>>(sql`
    select id, bank_name, country, currency, routing, account_last_four,
           approval_status, approved_at, approved_by, submitted_by,
           submitted_at, retired_at, retired_by, retirement_reason,
           is_active, ${documentRevisionSql(sql`updated_at`)} as updated_at
      from party_bank_accounts where party_id = ${id} and org_id = ${orgId} order by created_at
  `);
}

/** Read bank details only after locking the party in the caller's subsidiary scope. */
export function loadPartyBankAccounts(
  id: string,
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
) {
  return withOrgTransaction(orgId, async () => {
    const party = await db.execute(
      sql`select id from parties where id = ${id} and org_id = ${orgId}
        ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
        for share`,
      "objects",
    );
    if (!party[0]) return null;
    return loadPartyBankAccountsInCurrentTransaction(id, orgId);
  });
}
