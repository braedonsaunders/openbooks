import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { isUuid } from "../platform/uuid.ts";
import { PspSettlementError } from "./psp-settlement-core.ts";

/**
 * Every account a settlement batch can post to must resolve as a postable
 * account of the caller's org (active, non-summary). Tenant-coherent FKs
 * would kill a foreign account at the journal insert as a raw 500, and a
 * deactivated account only slightly later at the line guard — both long
 * after import/config accepted the reference. Fail closed here instead with
 * a domain error; a uniform refusal reveals nothing about other tenants.
 */
export async function validateSettlementPostingAccounts(
  orgId: string,
  accounts: { label: string; id: string | null | undefined }[],
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
  batchSubsidiaryId: string | null = null,
): Promise<void> {
  const ids = [
    ...new Set(
      accounts
        .map((a) => a.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  if (ids.length === 0) return;
  const malformed = ids.find((id) => !isUuid(id));
  if (malformed) {
    throw new PspSettlementError(
      `settlement account ${malformed} is not a valid account reference`,
    );
  }
  const rows = await db.execute<{ id: string; subsidiary_id: string | null }>(
    sql`
    select id, subsidiary_id from accounts
     where org_id = ${orgId} and is_active and not is_summary
       and id = any(${`{${ids.join(",")}}`}::uuid[])
  `,
    "objects",
  );
  const found = new Map(rows.map((r) => [r.id.toLowerCase(), r.subsidiary_id]));
  const missing = ids.find((id) => !found.has(id.toLowerCase()));
  if (missing) {
    const label = accounts.find((a) => a.id === missing)?.label ?? "settlement";
    throw new PspSettlementError(
      `settlement ${label} account is not a postable account in this organization`,
    );
  }
  for (const id of ids) {
    const subsidiaryId = found.get(id.toLowerCase()) ?? null;
    if (
      !subsidiaryScopeAllows(allowedSubsidiaryIds, subsidiaryId, { orgWideNull: true }) ||
      (batchSubsidiaryId !== null && subsidiaryId !== null && subsidiaryId !== batchSubsidiaryId)
    ) {
      const label = accounts.find((a) => a.id === id)?.label ?? "settlement";
      throw new PspSettlementError(
        `settlement ${label} account is outside the authorized subsidiary scope`,
      );
    }
  }
}

export async function primaryBookId(orgId: string): Promise<string> {
  const r = await db.execute<{ id: string }>(
    sql`
    select id from accounting_books where org_id = ${orgId} and is_primary and is_active and posts_gl
     limit 1 for share
  `,
    "objects",
  );
  const id = r[0]?.id;
  if (!id) throw new PspSettlementError("no active primary posting book");
  return id;
}

export async function periodForDate(
  orgId: string,
  date: string,
  subsidiaryId?: string | null,
  runner: SqlExecutor = db,
): Promise<string | null> {
  return (await resolveCoveringPeriod(runner, orgId, date, subsidiaryId))?.id ?? null;
}

export interface ImportAccounts {
  bankAccountId: string;
  feeAccountId: string;
  disputeAccountId: string;
  fxAccountId: string;
  clearingAccountId: string;
  subsidiaryId: string;
}
