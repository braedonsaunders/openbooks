import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { routeSubjectSubmission } from "../flows/submission-policy.ts";
import { assertFixtureDatabase } from "./fixtures.ts";

/** Bank-file fixtures retain real zero-gate approval receipts for their exact bank details. */
export async function seedApprovedBankAccountFixture(input: {
  orgId: string; actorId: string; partyId: string; id?: string;
  bankName: string; country: string; currency: string; routing: Record<string, string>;
  lastFour: string; sealedAccount?: string | null;
}): Promise<string> {
  await assertFixtureDatabase();
  return withOrgTransaction(input.orgId, async () => {
    const party = (await db.execute<{ subsidiary_id: string | null }>(sql`
      select subsidiary_id from parties where org_id=${input.orgId} and id=${input.partyId} and is_active for share`)).rows[0];
    if (!party) throw new Error("The bank fixture requires its active native payee.");
    await lockActorCommandAuthority(db, input.orgId, input.actorId, party.subsidiary_id, "parties.manage");
    const id = input.id ?? randomUUID();
    const inserted = await db.execute(sql`insert into party_bank_accounts
      (id,org_id,party_id,bank_name,country,currency,routing,account_number_encrypted,account_last_four,
       approval_status,is_active,submitted_by,submitted_at,created_by,updated_by)
      values(${id},${input.orgId},${input.partyId},${input.bankName},${input.country},${input.currency},
       ${JSON.stringify(input.routing)}::jsonb,${input.sealedAccount ?? null},${input.lastFour},
       'pending',false,${input.actorId},now(),${input.actorId},${input.actorId})`);
    if (inserted.rowCount !== 1) throw new Error("The bank fixture was not created.");
    const receipt = await routeSubjectSubmission({ orgId:input.orgId,actorId:input.actorId,
      subjectKind:"party_bank_account",subjectId:id,event:{kind:"on_create",source:"api"} });
    if (receipt.policy.kind !== "ungated") throw new Error("This bank fixture requires an explicitly zero-gate tenant policy.");
    const released = await db.execute(sql`update party_bank_accounts set approval_status='approved',is_active=true,
      approved_at=${await businessToday(input.orgId)},approved_by=${input.actorId},updated_by=${input.actorId},updated_at=now()
      where org_id=${input.orgId} and id=${id} and approval_status='pending' returning id`);
    if (released.rowCount !== 1) throw new Error("The bank fixture was not released by its native Flow receipt.");
    return id;
  });
}
