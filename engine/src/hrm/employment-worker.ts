import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isNaturalPersonPartyKind } from "../organization/party-kinds.ts";
import { HrmChangeRequestError } from "./change-requests-payload.ts";

/** Recheck personhood and the active employee role under locks held through the hire. */
export async function assertEmploymentWorker(
  exec: SqlExecutor,
  orgId: string,
  partyId: string,
): Promise<void> {
  const party = (
    await exec.execute<{ kind: string; isActive: boolean }>(
      sql`
    select kind, is_active as "isActive" from parties
     where org_id = ${orgId} and id = ${partyId} for share
  `,
      "objects",
    )
  )[0];
  if (!party || !party.isActive) {
    throw new HrmChangeRequestError(
      "NOT_FOUND",
      "the person was not found in this organization — open the active employee record and hire from there",
    );
  }
  if (!isNaturalPersonPartyKind(party.kind)) {
    throw new HrmChangeRequestError(
      "INVALID_PAYLOAD",
      "a hire records a natural person — select a party with kind person or employee; company, customer, and vendor identities cannot hold employments",
    );
  }
  const role = (
    await exec.execute(
      sql`
    select id from employee_roles
     where org_id = ${orgId} and party_id = ${partyId} and is_active for share
  `,
      "objects",
    )
  )[0];
  if (!role) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "this person holds no active employee role — give the party the employee role, then hire",
    );
  }
}

export async function assertEmploymentHireWorker(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
): Promise<void> {
  const employment = (
    await exec.execute<{ workerPartyId: string }>(
      sql`
    select worker_party_id as "workerPartyId" from worker_employments
     where org_id = ${orgId} and id = ${employmentId}
  `,
      "objects",
    )
  )[0];
  if (!employment)
    throw new HrmChangeRequestError(
      "NOT_FOUND",
      "the employment was not found in this organization — reopen the employee record",
    );
  await assertEmploymentWorker(exec, orgId, employment.workerPartyId);
}
