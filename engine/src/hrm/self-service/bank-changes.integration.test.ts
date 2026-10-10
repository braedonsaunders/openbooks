import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  DB,
  gateOf,
  refusalOf,
  setupHarness,
  withHarness,
  seedEmployment,
  seedFlow,
} from "../testing/hrm-harness.ts";
import { SelfServiceError } from "./self-service/actor.ts";
import {
  fileBankDetailsChange,
  listOwnBankAccounts,
  validateBankChange,
  type BankChangeNotifier,
} from "./self-service/bank-changes.ts";
import { decideGate } from "../flows/gates.ts";
import { installEngineSeams } from "../composition/install.ts";

// Gate releases run through the installed engine seams; without this the
// approval gates strand on a not-registered refusal instead of releasing.
installEngineSeams();

/**
 * Self-service direct-deposit (bank_change) DB coverage (integration
 * partition): filing seals the number in memory and stores only the
 * sealed text plus the last four; approval (or the no-flow direct path)
 * writes an approved row, retires the prior one, audits masked evidence,
 * and notifies the worker's existing email with masked details only.
 *
 * Plaintext discipline is proven from storage, never from return values:
 * no persisted row, payload, audit entry, or notification may contain the
 * full number.
 */

const BANK_SPEC = {
  features: ["hrm"],
  users: [
    { key: "workerId", name: "Bank Worker", handle: "bank_worker", permissions: ["hrm.self.read", "hrm.self.request"], link: "Bank Worker", partyKey: "workerPartyId" },
    { key: "approverId", name: "Bank Approver", handle: "bank_approver", permissions: ["hrm.employment.read", "hrm.employment.approve"], link: "Bank Approver" },
  ],
} as const;

const ACCOUNT = "98765432109876543210";

async function seedWorkerEmployment(orgId: string, subsidiaryId: string, workerPartyId: string): Promise<string> {
  const { employmentId } = await seedEmployment(orgId, subsidiaryId, { workerPartyId, displayName: "Bank Worker" });
  await db.execute(sql`
    update parties set email = 'worker@example.test' where org_id = ${orgId} and id = ${workerPartyId}
  `);
  return employmentId;
}

function fakeNotifier(seen: Array<{ data: Parameters<BankChangeNotifier>[0]; jobId: string }>): BankChangeNotifier {
  return async (data, options) => {
    seen.push({ data, jobId: options.jobId });
    return { queued: true };
  };
}

async function bankRows(orgId: string, partyId: string): Promise<Array<Record<string, unknown>>> {
  return (await db.execute<Record<string, unknown>>(sql`
    select id::text as id, bank_name as "bankName", account_number_encrypted as sealed,
           account_last_four as "lastFour", approval_status as status, is_active as "isActive",
           retired_at as "retiredAt", to_jsonb(party_bank_accounts) as row
      from party_bank_accounts
     where org_id = ${orgId} and party_id = ${partyId}
     order by created_at, id
  `)).rows;
}

test("bank change with no flow applies sealed, masked, audited, and notified", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(BANK_SPEC), async (h) => {
    const employmentId = await seedWorkerEmployment(h.org.orgId, h.org.subsidiaryId, h.workerPartyId);
    const seen: Array<{ data: Parameters<BankChangeNotifier>[0]; jobId: string }> = [];
    const filed = await fileBankDetailsChange({
      orgId: h.org.orgId,
      actorId: h.workerId,
      employmentId,
      bank: { bankName: "First Bank", accountNumber: ACCOUNT, country: "US", currency: "USD" },
      reason: "switched to direct deposit",
      notifyBankChange: fakeNotifier(seen),
    });
    assert.equal(filed.request.status, "applied");
    assert.equal(filed.applied, true);

    // Exactly one live row, approved and active, sealed at rest.
    const rows = await bankRows(h.org.orgId, h.workerPartyId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "approved");
    assert.equal(rows[0]!.isActive, true);
    assert.equal(rows[0]!.lastFour, "3210");
    assert.ok(typeof rows[0]!.sealed === "string" && (rows[0]!.sealed as string).length > 0);
    assert.ok(!(rows[0]!.sealed as string).includes("98765432"), "the sealed text is not the number");

    // Plaintext discipline from storage: no persisted row, payload, or
    // audit entry may contain the full number.
    const leaks = await db.execute<{ n: number }>(sql`
      select (
        (select count(*) from party_bank_accounts where org_id = ${h.org.orgId} and (account_number_encrypted like ${`%${ACCOUNT}%`})) +
        (select count(*) from hrm_employment_change_requests where org_id = ${h.org.orgId} and payload::text like ${`%${ACCOUNT}%`}) +
        (select count(*) from audit_log where org_id = ${h.org.orgId} and changes::text like ${`%${ACCOUNT}%`})
      )::int as n
    `);
    assert.equal(leaks.rows[0]!.n, 0, "the full account number persists nowhere");
    const audits = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log
       where org_id = ${h.org.orgId} and table_name = 'party_bank_accounts' and action = 'insert'
    `)).rows[0]!.n;
    assert.equal(audits, 1, "the bank write carries its own audit entry");

    // The fraud notice names the bank and the last four only, to the
    // worker's existing email, under a deterministic job id.
    assert.equal(filed.notified, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.data.to, "worker@example.test");
    assert.match(seen[0]!.data.subject, /direct-deposit/i);
    assert.ok(!seen[0]!.data.text.includes(ACCOUNT) && !seen[0]!.data.html.includes(ACCOUNT));
    assert.ok(seen[0]!.data.text.includes("3210"));
    assert.match(seen[0]!.jobId, /^bank-details-changed\|/);

    // The masked read returns the row with no sealed material.
    const accounts = await listOwnBankAccounts({ orgId: h.org.orgId, actorId: h.workerId });
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]!.lastFour, "3210");
    assert.ok(!("sealedAccount" in accounts[0]!) && !("accountNumber" in accounts[0]!));
  });
});

test("gated bank change waits for approval, then applies and retires the prior row", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(BANK_SPEC), async (h) => {
    await seedFlow(h.org.orgId, h.approverId);
    const employmentId = await seedWorkerEmployment(h.org.orgId, h.org.subsidiaryId, h.workerPartyId);
    const seen: Array<{ data: Parameters<BankChangeNotifier>[0]; jobId: string }> = [];
    const first = await fileBankDetailsChange({
      orgId: h.org.orgId,
      actorId: h.workerId,
      employmentId,
      bank: { bankName: "First Bank", accountNumber: "1111222233334444" },
      reason: "first direct deposit account",
      notifyBankChange: fakeNotifier(seen),
    });
    assert.equal(first.request.status, "pending_approval");
    assert.equal(first.applied, false);
    assert.equal(first.notified, false, "a proposal is not a change — no notice yet");
    assert.equal((await bankRows(h.org.orgId, h.workerPartyId)).length, 0, "nothing lands before approval");

    const gate = await gateOf(first.request.id);
    const decided = await decideGate({ gateId: gate.id, decision: "approved", userId: h.approverId });
    assert.equal(decided.ok, true);
    const afterFirst = await bankRows(h.org.orgId, h.workerPartyId);
    assert.equal(afterFirst.length, 1);
    assert.equal(afterFirst[0]!.isActive, true);

    const second = await fileBankDetailsChange({
      orgId: h.org.orgId,
      actorId: h.workerId,
      employmentId,
      bank: { bankName: "Second Bank", accountNumber: "9999888877776666" },
      reason: "moved to a new bank entirely",
      notifyBankChange: fakeNotifier(seen),
    });
    assert.equal(second.request.status, "pending_approval");
    const gate2 = await gateOf(second.request.id);
    await decideGate({ gateId: gate2.id, decision: "approved", userId: h.approverId });
    const afterSecond = await bankRows(h.org.orgId, h.workerPartyId);
    assert.equal(afterSecond.length, 2);
    const live = afterSecond.filter((row) => row.isActive === true);
    assert.equal(live.length, 1, "exactly one active row survives a replacement");
    assert.equal(live[0]!.bankName, "Second Bank");
    assert.equal(live[0]!.lastFour, "6666");
    assert.ok(afterSecond.some((row) => row.isActive === false && row.retiredAt !== null));

    const masked = await listOwnBankAccounts({ orgId: h.org.orgId, actorId: h.workerId });
    assert.equal(masked.length, 1, "retired history stays out of the self-service read");
    assert.equal(masked[0]!.lastFour, "6666");
  });
});

test("bank filing refusals name the field and store nothing", { skip: !DB }, async () => {
  await withHarness(() => setupHarness(BANK_SPEC), async (h) => {
    const employmentId = await seedWorkerEmployment(h.org.orgId, h.org.subsidiaryId, h.workerPartyId);
    const file = (overrides: Record<string, unknown>) =>
      fileBankDetailsChange({
        orgId: h.org.orgId,
        actorId: h.workerId,
        employmentId: (overrides.employmentId ?? employmentId) as string,
        bank: (overrides.bank ?? { bankName: "First Bank", accountNumber: ACCOUNT }) as Record<string, unknown>,
        reason: (overrides.reason ?? "switched to direct deposit") as string,
        notifyBankChange: fakeNotifier([]),
      });

    // No employment of one's own: the hire remedy, never a generic failure.
    const noOwn = await refusalOf(
      file({ employmentId: "00000000-0000-4000-8000-000000000099" }),
      SelfServiceError,
    );
    assert.equal(noOwn.code, "FORBIDDEN");
    assert.match(noOwn.message, /no employment record/);

    // Field refusals name their fields.
    const shortAccount = await refusalOf(
      file({ bank: { bankName: "First Bank", accountNumber: "12" } }),
      SelfServiceError,
    );
    assert.equal(shortAccount.code, "REFUSED");
    assert.match(shortAccount.message, /accountNumber/);
    const blankBank = await refusalOf(
      file({ bank: { bankName: "  ", accountNumber: ACCOUNT } }),
      SelfServiceError,
    );
    assert.match(blankBank.message, /bankName/);
    const shortReason = await refusalOf(
      file({ reason: "move" }),
      SelfServiceError,
    );
    assert.match(shortReason.message, /5 and 500/);

    const requests = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from hrm_employment_change_requests where org_id = ${h.org.orgId}
    `)).rows[0]!.n;
    assert.equal(requests, 0, "refused filings store no request");
    assert.equal((await bankRows(h.org.orgId, h.workerPartyId)).length, 0, "refused filings store no bank row");
  });
});

test("bank proposals validate field by field without a database", () => {
  assert.equal(validateBankChange({ bankName: "First Bank", accountNumber: "12345678" }).bankName, "First Bank");
  assert.throws(() => validateBankChange({ bankName: "  ", accountNumber: "12345678" }), /bankName/);
  assert.throws(() => validateBankChange({ bankName: "First Bank", accountNumber: "12" }), /accountNumber/);
  assert.throws(() => validateBankChange(null), /bank change refused/);
});
