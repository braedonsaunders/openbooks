import { installEngineSeams } from "../composition/install.ts";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { routeSubjectSubmission } from "../flows/submission-policy.ts";
import { assertFixtureDatabase } from "./fixtures.ts";

/** Bank-file fixtures retain real zero-gate approval receipts for their exact bank details. */
export async function seedApprovedBankAccountFixture(input: {
  orgId: string;
  actorId: string;
  partyId: string;
  id?: string;
  bankName: string;
  country: string;
  currency: string;
  routing: Record<string, string>;
  lastFour: string | null;
  sealedAccount?: string | null;
}): Promise<string> {
  await assertFixtureDatabase();
  installEngineSeams();
  return withOrgTransaction(input.orgId, async () => {
    const party = (
      await db.execute<{ subsidiary_id: string | null }>(
        sql`
      select subsidiary_id from parties where org_id=${input.orgId} and id=${input.partyId} and is_active for share`,
        "objects",
      )
    )[0];
    if (!party) throw new Error("The bank fixture requires its active native payee.");
    await lockActorCommandAuthority(
      db,
      input.orgId,
      input.actorId,
      party.subsidiary_id,
      "parties.manage",
    );
    const id = input.id ?? randomUUID();
    const inserted = await db.execute<never>(sql`insert into party_bank_accounts
      (id,org_id,party_id,bank_name,country,currency,routing,account_number_encrypted,account_last_four,
       approval_status,is_active,submitted_by,submitted_at,created_by,updated_by)
      values(${id},${input.orgId},${input.partyId},${input.bankName},${input.country},${input.currency},
       ${JSON.stringify(input.routing)}::jsonb,${input.sealedAccount ?? null},${input.lastFour},
       'pending',false,${input.actorId},now(),${input.actorId},${input.actorId})`);
    if (inserted.rowCount !== 1) throw new Error("The bank fixture was not created.");
    await releaseBankAccountFixture(input.orgId, input.actorId, id, "on_create");
    return id;
  });
}

/** Resubmit the exact edited details under the fixture tenant's explicit zero-gate policy. */
export async function approvePendingBankAccountFixture(input: {
  orgId: string;
  actorId: string;
  id: string;
}): Promise<void> {
  await assertFixtureDatabase();
  installEngineSeams();
  await withOrgTransaction(input.orgId, async () => {
    const row = (
      await db.execute<{ subsidiary_id: string | null }>(
        sql`select p.subsidiary_id from party_bank_accounts b
      join parties p on p.org_id=b.org_id and p.id=b.party_id where b.org_id=${input.orgId} and b.id=${input.id}
      and b.approval_status='pending' and p.is_active for update of b for share of p`,
        "objects",
      )
    )[0];
    if (!row)
      throw new Error("The bank fixture requires pending details for its active native payee.");
    await lockActorCommandAuthority(
      db,
      input.orgId,
      input.actorId,
      row.subsidiary_id,
      "parties.manage",
    );
    const submitted = await db.execute(
      sql`update party_bank_accounts set submitted_by=${input.actorId},submitted_at=now(),
      updated_by=${input.actorId},updated_at=now() where org_id=${input.orgId} and id=${input.id} and approval_status='pending' returning id`,
      "objects",
    );
    if (submitted.length !== 1) throw new Error("The edited bank fixture was not resubmitted.");
    await releaseBankAccountFixture(input.orgId, input.actorId, input.id, "on_update");
  });
}

async function releaseBankAccountFixture(
  orgId: string,
  actorId: string,
  id: string,
  event: "on_create" | "on_update",
): Promise<void> {
  const receipt = await routeSubjectSubmission({
    orgId,
    actorId,
    subjectKind: "party_bank_account",
    subjectId: id,
    event: { kind: event, source: "api" },
  });
  if (receipt.policy.kind !== "ungated")
    throw new Error("This bank fixture requires an explicitly zero-gate tenant policy.");
  const released = await db.execute(
    sql`update party_bank_accounts set approval_status='approved',is_active=true,
    approved_at=${await businessToday(orgId)},approved_by=${actorId},updated_by=${actorId},updated_at=now()
    where org_id=${orgId} and id=${id} and approval_status='pending' returning id`,
    "objects",
  );
  if (released.length !== 1)
    throw new Error("The bank fixture was not released by its native Flow receipt.");
}
