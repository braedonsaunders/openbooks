import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgTransaction } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { fromUnits, neg, roundDiv } from "../money/money.ts";
import {
  expireStoredValueAccount,
  insertStoredValueEntry,
  loadStoredValueProgram,
  lockStoredValueAccount,
  postStoredValueJournal,
  priorStoredValueEntry,
  requireStoredValueFeature,
  storedValueEnabledFor,
  storedValueExpiredSql,
  storedValueLiabilityControlAccount,
  type StoredValueAccountRow,
} from "./accounts.ts";
import { accountFunctionalTotal, carryingShare } from "./fx-amounts.ts";
import { storedValueRefusal } from "./errors.ts";

export interface BreakageOrgError {
  orgId: string;
  error: string;
}

export interface BreakageScanResult {
  orgErrors: BreakageOrgError[];
  recognizedAccounts: number;
}

/** Parse a decimal rate string into an exact numerator/denominator pair. */
function parseRate(rate: string): { num: bigint; den: bigint } {
  const [intPart = "0", fracPart = ""] = rate.trim().split(".");
  const den = 10n ** BigInt(fracPart.length);
  const num = BigInt(`${intPart}${fracPart}` || "0");
  return { num, den };
}

/**
 * Proportional breakage (ASC 606-10-55-48): with an expected breakage rate r,
 * every redeemed unit implies r/(1−r) units of breakage earned alongside it,
 * capped so lifetime recognition never exceeds issued × r. All bigint, all
 * exact, rounded once at ledger precision.
 */
function proportionalDue(redeemedMinor: bigint, issuedMinor: bigint, recognizedMinor: bigint, rate: string): bigint {
  const { num, den } = parseRate(rate);
  if (num <= 0n || num >= den) return 0n;
  const expected = roundDiv(issuedMinor * num, den);
  const cumulative = roundDiv(redeemedMinor * num, den - num);
  const due = cumulative < expected ? cumulative : expected;
  return due > recognizedMinor ? due - recognizedMinor : 0n;
}

/** The balance already moved, so the entry must be this scan's own: a
 * conflict here is a concurrent scan, and throwing rolls the org's scan back
 * rather than keeping a balance move no entry records. */
function requireRecorded(replayed: boolean, codeLast4: string): void {
  if (!replayed) return;
  throw storedValueRefusal({
    message: `Stored-value …${codeLast4} had its breakage recorded by another scan while this one applied it.`,
    code: "stored_value_balance_changed",
    remedy: "Let the next scan retry it.",
    status: 409,
  });
}

async function recognizeProportional(
  orgId: string,
  account: StoredValueAccountRow,
  redeemedMinor: bigint,
  postingDate: string,
  period: string,
): Promise<boolean> {
  const program = await loadStoredValueProgram(orgId, account.programId);
  if (!program.breakageIncomeAccountId) {
    throw storedValueRefusal({
      message: `The ${program.name} program recognizes proportional breakage but names no breakage income account.`,
      code: "stored_value_breakage_income_missing",
      remedy: "Choose the breakage income account on the program in Setup → Sales → Stored value programs.",
    });
  }
  const due = proportionalDue(redeemedMinor, account.issuedMinor, account.breakageRecognizedMinor, program.breakageRate);
  const amount = due < account.balanceMinor ? due : account.balanceMinor;
  if (amount <= 0n) return false;
  // One recognition per account per period. A later scan in the same period
  // finds that entry and moves nothing: the journal and the entry are keyed
  // by period and would replay, so a balance update here would lower the
  // card with no ledger behind it. Its amount may legitimately differ from
  // what this scan computes (redemptions since the first scan); recognition
  // is cumulative, so that difference is recognized next period.
  const entryKey = `stored-value:breakage-entry:${account.id}:${period}`;
  if (await priorStoredValueEntry(orgId, entryKey, { accountId: account.id, kind: "breakage" })) return false;
  // Breakage extinguishes the debt without converting it: the recognized
  // slice carries its historical value, exactly like an expiry.
  const functionalPrior = await accountFunctionalTotal(db, orgId, account.id);
  const share = carryingShare(functionalPrior, account.balanceMinor, amount);
  const liabilityAccountId = account.liabilityAccountId ?? (await storedValueLiabilityControlAccount(orgId));
  const journalEntryId = await postStoredValueJournal({
    orgId,
    postingDate,
    subsidiaryId: account.subsidiaryId,
    memo: `Stored-value breakage — …${account.codeLast4}`,
    origin: "breakage",
    idempotencyKey: `stored-value:breakage:${account.id}:${period}`,
    accountId: liabilityAccountId,
    amount: fromUnits(share.functional),
    txnAmount: fromUnits(amount),
    counterAccountId: program.breakageIncomeAccountId,
    counterAmount: neg(fromUnits(share.functional)),
    counterTxnAmount: neg(fromUnits(amount)),
    fxRate: share.rate,
    currency: account.currency,
    partyId: account.customerPartyId,
    auditChanges: { accountId: account.id, policy: "proportional" },
  });
  const updated = (await db.execute<{ id: string }>(sql`
    update stored_value_accounts
       set balance_minor = (balance_minor - ${amount.toString()})::bigint,
           breakage_recognized_minor = (breakage_recognized_minor + ${amount.toString()})::bigint,
           last_activity_on = CURRENT_DATE,
           updated_at = now()
     where org_id = ${orgId} and id = ${account.id} and status = 'active'
       and balance_minor = ${account.balanceMinor.toString()}
    returning id
  `)).rows;
  if (updated.length !== 1) {
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} changed while recognizing breakage.`,
      code: "stored_value_balance_changed",
      remedy: "Let the next scan retry it.",
      status: 409,
    });
  }
  const entry = await insertStoredValueEntry(orgId, {
    accountId: account.id,
    kind: "breakage",
    amountMinor: -amount,
    balanceAfter: account.balanceMinor - amount,
    currency: account.currency,
    functionalAmountMinor: -share.functional,
    fxRate: share.rate,
    journalEntryId,
    idempotencyKey: entryKey,
  });
  requireRecorded(entry.replayed, account.codeLast4);
  return true;
}

/**
 * Remote breakage: the balance has sat untouched past the program's
 * inactivity window, so redemption is remote and the whole remainder is
 * recognized at once. The zeroed account closes with it.
 */
async function recognizeRemote(
  orgId: string,
  account: StoredValueAccountRow,
  postingDate: string,
): Promise<boolean> {
  const program = await loadStoredValueProgram(orgId, account.programId);
  if (!program.breakageIncomeAccountId) {
    throw storedValueRefusal({
      message: `The ${program.name} program recognizes remote breakage but names no breakage income account.`,
      code: "stored_value_breakage_income_missing",
      remedy: "Choose the breakage income account on the program in Setup → Sales → Stored value programs.",
    });
  }
  if (account.balanceMinor <= 0n) return false;
  // Remote breakage happens once per account and closes it, so a prior entry
  // on an account that is still active with a balance is damaged history,
  // never a retry: refuse rather than release the balance a second time.
  const prior = await priorStoredValueEntry(orgId, `stored-value:remote-entry:${account.id}`, {
    accountId: account.id,
    kind: "breakage",
  });
  if (prior) {
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} already recognized remote breakage yet is still active with a balance.`,
      code: "stored_value_breakage_replay_conflict",
      remedy: "Have the stored-value entry history for this account reviewed before the scan releases its balance.",
      status: 409,
    });
  }
  const functionalPrior = await accountFunctionalTotal(db, orgId, account.id);
  const share = carryingShare(functionalPrior, account.balanceMinor, account.balanceMinor);
  const liabilityAccountId = account.liabilityAccountId ?? (await storedValueLiabilityControlAccount(orgId));
  const journalEntryId = await postStoredValueJournal({
    orgId,
    postingDate,
    subsidiaryId: account.subsidiaryId,
    memo: `Stored-value remote breakage — …${account.codeLast4}`,
    origin: "breakage",
    idempotencyKey: `stored-value:remote:${account.id}`,
    accountId: liabilityAccountId,
    amount: fromUnits(share.functional),
    txnAmount: fromUnits(account.balanceMinor),
    counterAccountId: program.breakageIncomeAccountId,
    counterAmount: neg(fromUnits(share.functional)),
    counterTxnAmount: neg(fromUnits(account.balanceMinor)),
    fxRate: share.rate,
    currency: account.currency,
    partyId: account.customerPartyId,
    auditChanges: { accountId: account.id, policy: "remote" },
  });
  const updated = (await db.execute<{ id: string }>(sql`
    update stored_value_accounts
       set balance_minor = '0',
           breakage_recognized_minor = (breakage_recognized_minor + ${account.balanceMinor.toString()})::bigint,
           status = 'closed',
           last_activity_on = CURRENT_DATE,
           updated_at = now()
     where org_id = ${orgId} and id = ${account.id} and status = 'active'
       and balance_minor = ${account.balanceMinor.toString()}
    returning id
  `)).rows;
  if (updated.length !== 1) {
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} changed while recognizing breakage.`,
      code: "stored_value_balance_changed",
      remedy: "Let the next scan retry it.",
      status: 409,
    });
  }
  const entry = await insertStoredValueEntry(orgId, {
    accountId: account.id,
    kind: "breakage",
    amountMinor: -account.balanceMinor,
    balanceAfter: 0n,
    currency: account.currency,
    functionalAmountMinor: -share.functional,
    fxRate: share.rate,
    journalEntryId,
    idempotencyKey: `stored-value:remote-entry:${account.id}`,
  });
  requireRecorded(entry.replayed, account.codeLast4);
  return true;
}

type ScanCandidate = {
  id: string;
};

/** Orgs with the gate on, resolved through the same machinery the Features
 * page uses. */
export async function storedValueBreakageTargets(): Promise<string[]> {
  // bypass: scheduler-tick — the breakage scan finds due stored-value work across every organization.
  const rows = (await withBypassContext(() => db.execute<{ id: string; settings: unknown }>(sql`
    select id, settings from orgs
  `))).rows;
  return rows.filter((row) => storedValueEnabledFor((row.settings as Record<string, unknown> | null)?.["features"])).map((row) => row.id);
}

async function processOrgBreakage(orgId: string): Promise<number> {
  await requireStoredValueFeature(db, orgId);
  const today = await businessToday(orgId);
  const period = today.slice(0, 7);
  let recognized = 0;

  const expired = (await db.execute<ScanCandidate>(sql`
    select a.id
      from stored_value_accounts a
      join stored_value_programs p on p.org_id = a.org_id and p.id = a.program_id
     where a.org_id = ${orgId} and a.status = 'active'
       and ${storedValueExpiredSql(sql`a.expires_on`, today)}
     order by a.id
  `)).rows;
  for (const row of expired) {
    // The scheduled scan acts on every entity: explicit null is the
    // intentional system sentinel.
    await expireStoredValueAccount({ orgId, accountId: row.id, allowedSubsidiaryIds: null, postingDate: today, idempotencyKey: row.id });
    recognized++;
  }

  const remote = (await db.execute<ScanCandidate>(sql`
    select a.id
      from stored_value_accounts a
      join stored_value_programs p on p.org_id = a.org_id and p.id = a.program_id
     where a.org_id = ${orgId} and a.status = 'active'
       and p.breakage_policy = 'remote' and a.balance_minor > 0
       and a.last_activity_on < CURRENT_DATE - make_interval(months => p.inactivity_months)
     order by a.id
  `)).rows;
  for (const row of remote) {
    // The row lock serializes a concurrent redemption: the winner moves the
    // balance first and the loser re-reads it.
    const account = await lockStoredValueAccount(orgId, row.id, null);
    if (account.status !== "active" || account.balanceMinor <= 0n) continue;
    const program = await loadStoredValueProgram(orgId, account.programId);
    if (program.breakagePolicy !== "remote") continue;
    if (await recognizeRemote(orgId, account, today)) recognized++;
  }

  const proportional = (await db.execute<ScanCandidate & { redeemed: string }>(sql`
    select a.id, coalesce(-sum(e.amount_minor) filter (where e.kind = 'redeem'), 0)::text as redeemed
      from stored_value_accounts a
      join stored_value_programs p on p.org_id = a.org_id and p.id = a.program_id
      left join stored_value_entries e
        on e.org_id = a.org_id and e.account_id = a.id and e.kind = 'redeem'
     where a.org_id = ${orgId} and a.status = 'active'
       and p.breakage_policy = 'proportional' and a.balance_minor > 0
     group by a.id
     order by a.id
  `)).rows;
  for (const row of proportional) {
    const account = await lockStoredValueAccount(orgId, row.id, null);
    if (account.status !== "active" || account.balanceMinor <= 0n) continue;
    const program = await loadStoredValueProgram(orgId, account.programId);
    if (program.breakagePolicy !== "proportional") continue;
    if (await recognizeProportional(orgId, account, BigInt(row.redeemed), today, period)) recognized++;
  }
  return recognized;
}

/**
 * Periodic stored-value scan (scheduler kind `stored_value_breakage`):
 * expiry, remote breakage, then proportional breakage. Per-org isolation —
 * one org's misconfiguration surfaces by name without stopping the rest.
 */
export async function runStoredValueBreakage(): Promise<BreakageScanResult> {
  const errors: BreakageOrgError[] = [];
  let recognizedAccounts = 0;
  for (const orgId of await storedValueBreakageTargets()) {
    try {
      recognizedAccounts += await withOrgTransaction(orgId, () => processOrgBreakage(orgId));
    } catch (error) {
      errors.push({ orgId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { orgErrors: errors, recognizedAccounts };
}
