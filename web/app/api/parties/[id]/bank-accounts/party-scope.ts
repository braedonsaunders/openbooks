import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "@openbooks/engine/platform/db";
import { lockScopeRow, ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { can, getAuthz, guardSubsidiaryScope, type Authz } from "../../../../../lib/authz";
import { isUuid } from "../../../../../lib/list-params";

/**
 * Bank details stay under parties.manage — except an EMPLOYEE's own
 * direct-deposit record, which the hiring and payroll operators must capture
 * at hire without holding the master-data grant: hrm.employment.manage or
 * payroll.manage suffices when the party carries an active employee role.
 * This widens WHO may start the flow, never what it enforces — approval,
 * revision tokens, audit and the subsidiary-scope checks in each handler
 * still govern every write.
 */
export const authorizePartyBankWrite = async ({
  params,
}: {
  request: Request;
  params: unknown;
}) => {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const partyId = (params as { id?: string } | undefined)?.id ?? "";
  const denied = await authorizePartyBankWriteWithAuthz(authz, partyId);
  return denied ?? authz;
};

/** Resolve the route's party-bank authority for session and API-key callers. */
export async function authorizePartyBankWriteWithAuthz(
  authz: Authz,
  partyId: string,
): Promise<NextResponse | null> {
  if (can(authz, "parties.manage")) return null;
  if (
    isUuid(partyId) &&
    (can(authz, "hrm.employment.manage") || can(authz, "payroll.manage")) &&
    (
      await db.execute(
        sql`select 1 from employee_roles where org_id = ${authz.user.orgId} and party_id = ${partyId} and is_active`,
        "objects",
      )
    ).length > 0
  ) {
    return null;
  }
  return NextResponse.json({ error: "missing permission: parties.manage" }, { status: 403 });
}

/** Party record boundary shared by every bank-account verb here (null-subsidiary parties are org-wide). */
export async function denyOutsidePartyScope(
  gate: Authz,
  partyId: string,
): Promise<NextResponse | null> {
  const row = await db.execute<{ subsidiaryId: string | null }>(
    sql`select subsidiary_id as "subsidiaryId" from parties where id = ${partyId} and org_id = ${gate.user.orgId}`,
    "objects",
  );
  if (!row[0]) return NextResponse.json({ error: "party not found" }, { status: 404 });
  return guardSubsidiaryScope(gate, row[0].subsidiaryId, { orgWideNull: true });
}

/**
 * Locked recheck for the bank-account write transactions. The unlocked
 * precheck above can authorize party A while a concurrent A→B rehome lands
 * before the write commits; this runs under the party row lock inside the
 * write transaction, so the scope verdict sees the latest committed
 * subsidiary and the rehome blocks until the write commits. Answers exactly
 * like a missing party, matching the precheck.
 */
export async function denyLockedOutsidePartyScope(
  tx: SqlExecutor,
  gate: Authz,
  partyId: string,
): Promise<NextResponse | null> {
  try {
    await lockScopeRow(tx, gate.user.orgId, "party", partyId, gate.allowedSubsidiaryIds, "update", {
      orgWideNull: true,
    });
    return null;
  } catch (error) {
    if (!(error instanceof ScopeNotFoundError)) throw error;
    return NextResponse.json({ error: "party not found" }, { status: 404 });
  }
}
