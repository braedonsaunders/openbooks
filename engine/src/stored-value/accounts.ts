import { sql, type SQL } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { addMonthsClamped, isIsoCalendarDate } from "../platform/civil-date.ts";
import { cmp, fromUnits, neg, toUnits } from "../money/money.ts";
import { postEntry } from "../journal/post-entry.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { nextFreeEntryNumber } from "../records/entry-number.ts";
import { loadControlAccounts } from "../records/control-accounts.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { featureEnabled } from "../organization/feature-registry.ts";
import {
  accountFunctionalTotal,
  carryingShare,
  ensureMonetaryLiability,
  functionalMinor,
  loadDocumentFxContext,
  resolveEventRate,
  subsidiaryBaseCurrency,
} from "./fx-amounts.ts";
import {
  codeLast4,
  digestsEqual,
  generateStoredValueCode,
  hashStoredValueCode,
  normalizeStoredValueCode,
} from "./codes.ts";
import { storedValueFeatureOff, storedValueRefusal } from "./errors.ts";

export type StoredValueKind = "gift_card" | "store_credit";
export type StoredValueStatus = "active" | "frozen" | "closed" | "expired";
export type StoredValueEntryKind =
  | "issue"
  | "redeem"
  | "adjust"
  | "expire"
  | "breakage"
  | "reversal";
export type StoredValueBreakagePolicy = "none" | "proportional" | "remote";

export type StoredValueProgramRow = {
  id: string;
  orgId: string;
  name: string;
  kind: StoredValueKind;
  liabilityAccountId: string | null;
  breakageIncomeAccountId: string | null;
  breakagePolicy: StoredValueBreakagePolicy;
  breakageRate: string;
  expiryMonths: number | null;
  inactivityMonths: number;
  currency: string | null;
  isActive: boolean;
};

export type StoredValueAccountRow = {
  id: string;
  orgId: string;
  programId: string;
  kind: StoredValueKind;
  codeHash: string;
  codeLast4: string;
  customerPartyId: string | null;
  currency: string;
  subsidiaryId: string;
  issuedMinor: bigint;
  balanceMinor: bigint;
  breakageRecognizedMinor: bigint;
  status: StoredValueStatus;
  expiresOn: string | null;
  lastActivityOn: string;
  sourceDocumentId: string | null;
  liabilityAccountId: string | null;
};

/**
 * Whether a document of one customer may move value on an account. Store
 * credit is never bearer and a named gift card is bound to its customer, so
 * only the account's own customer qualifies; a bearer gift card moves for
 * any document. Documents with no customer qualify only for bearer cards.
 */
export function storedValueAccountOwnedByCustomer(
  account: { kind: string; customerPartyId: string | null },
  customerPartyId: string | null,
): boolean {
  if (account.kind !== "store_credit" && !account.customerPartyId) return true;
  return !!customerPartyId && account.customerPartyId === customerPartyId;
}

/** Every public function below runs on the ambient tenant transaction (`db`). */

export async function requireStoredValueFeature(runner: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(runner, orgId, "storedValue"))) {
    throw storedValueFeatureOff();
  }
}

/**
 * The balance-sheet home of unredeemed stored value. Refuses by name when the
 * org has not configured it: without this account a gift card sale would
 * have nowhere to post but revenue, which is exactly the misstatement this
 * module exists to prevent.
 */
export async function storedValueLiabilityControlAccount(orgId: string): Promise<string> {
  const controls = await loadControlAccounts(orgId);
  if (!controls.storedValueLiability) {
    throw storedValueRefusal({
      message:
        "No stored-value liability account is configured for this organization.",
      code: "stored_value_liability_unset",
      remedy:
        "Select a stored-value liability account in Admin → Setup → Company (control accounts), then retry.",
    });
  }
  await ensureMonetaryLiability(db, orgId, controls.storedValueLiability);
  return controls.storedValueLiability;
}

async function assertPostingAccount(
  runner: SqlExecutor,
  orgId: string,
  accountId: string,
  label: string,
  types: readonly string[],
): Promise<void> {
  const rows = (await runner.execute<{ id: string; type: string }>(sql`
    select id, type from accounts
     where org_id = ${orgId} and id = ${accountId} and is_active and not is_summary
     for key share
  `)).rows;
  if (rows.length !== 1 || !types.includes(rows[0]!.type)) {
    throw storedValueRefusal({
      message: `${label} must be an active posting account of type ${types.join(" or ")} in this organization.`,
      code: "stored_value_account_invalid",
      remedy: `Choose an active ${label.toLowerCase()} from this organization's chart of accounts.`,
      field: label,
    });
  }
}

export async function postingContext(
  runner: SqlExecutor,
  orgId: string,
  postingDate: string,
  subsidiaryId: string | null = null,
): Promise<{ bookId: string; subsidiaryId: string; currency: string; periodId: string }> {
  const book = (await runner.execute<{ id: string }>(sql`
    select id from accounting_books
     where org_id = ${orgId} and is_primary and is_active and posts_gl
     limit 1 for share
  `)).rows[0];
  // A movement posts on its own legal entity; only a caller naming none
  // falls back to the hierarchy root, the same default the document kernel
  // applies. The row-count check turns an entity outside this org into a
  // refusal instead of a posting to nowhere.
  const subsidiary = subsidiaryId
    ? (await runner.execute<{ id: string; currency: string | null }>(sql`
      select id, nullif(trim(base_currency), '') as currency from subsidiaries
       where org_id = ${orgId} and id = ${subsidiaryId}
       limit 1 for share
    `)).rows[0]
    : (await runner.execute<{ id: string; currency: string | null }>(sql`
      select id, nullif(trim(base_currency), '') as currency from subsidiaries
       where org_id = ${orgId} and is_active and not is_elimination and parent_id is null
       limit 1 for share
    `)).rows[0];
  const period = await resolveCoveringPeriod(runner, orgId, postingDate);
  if (!book || !subsidiary?.id || !subsidiary?.currency || !period) {
    throw storedValueRefusal({
      message: "Stored-value posting needs an active primary book, a legal entity with a currency, and a covering accounting period.",
      code: "stored_value_posting_context_missing",
      remedy: "Configure the primary book and subsidiary currency, then choose a date in an open accounting period.",
    });
  }
  return { bookId: book.id, subsidiaryId: subsidiary.id, currency: subsidiary.currency, periodId: period.id };
}

function requireDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !isIsoCalendarDate(value)) {
    throw storedValueRefusal({
      message: `${field} must be a valid calendar date in YYYY-MM-DD format.`,
      code: "stored_value_date_invalid",
      remedy: `Enter a real calendar date for ${field}.`,
      field,
    });
  }
  return value;
}

function toMinor(amount: string, field: string): bigint {
  let units: bigint;
  try {
    units = toUnits(amount);
  } catch {
    throw storedValueRefusal({
      message: `${field} must be a decimal amount with at most 4 decimal places.`,
      code: "stored_value_amount_invalid",
      remedy: `Enter ${field} as a plain decimal amount (for example 25.00).`,
      field,
    });
  }
  return units;
}

export async function loadStoredValueProgram(
  orgId: string,
  programId: string,
  runner: SqlExecutor = db,
): Promise<StoredValueProgramRow> {
  const rows = (await runner.execute<StoredValueProgramRow>(sql`
    select id, org_id as "orgId", name, kind, liability_account_id as "liabilityAccountId",
           breakage_income_account_id as "breakageIncomeAccountId", breakage_policy as "breakagePolicy",
           breakage_rate::text as "breakageRate", expiry_months as "expiryMonths",
           inactivity_months as "inactivityMonths", currency, is_active as "isActive"
      from stored_value_programs
     where org_id = ${orgId} and id = ${programId}
  `)).rows;
  const program = rows[0];
  if (!program) {
    const count = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from stored_value_programs where org_id = ${orgId} and id = ${programId}`);
    if (count.rows[0]?.n === 0) {
      throw storedValueRefusal({
        message: "The stored-value program does not exist in this organization.",
        code: "stored_value_program_missing",
        remedy: "Create the program in Setup → Sales → Stored value programs, then retry.",
      });
    }
    throw storedValueRefusal({
      message: "The stored-value program cannot be read in this organization.",
      code: "stored_value_program_unreadable",
      remedy: "Check the program exists in Setup → Sales → Stored value programs, then retry.",
    });
  }
  return program;
}

/** Liability home for one program: its own override, else the org control. */
export async function programLiabilityAccount(
  orgId: string,
  program: StoredValueProgramRow,
  runner: SqlExecutor = db,
): Promise<string> {
  if (program.liabilityAccountId) {
    await assertPostingAccount(runner, orgId, program.liabilityAccountId, "Program liability account", [
      "liability_payable",
      "liability_current_other",
    ]);
    await ensureMonetaryLiability(runner, orgId, program.liabilityAccountId);
    return program.liabilityAccountId;
  }
  return storedValueLiabilityControlAccount(orgId);
}

export interface ProgramCandidate {
  name: string;
  kind: string;
  liabilityAccountId?: string | null;
  breakageIncomeAccountId?: string | null;
  breakagePolicy?: string;
  breakageRate?: string;
  expiryMonths?: number | null;
}

/**
 * Program validation shared by the engine create path and the Setup
 * boundary: one source of truth, so a program saved in Setup carries the
 * same guarantees as one created through the API. Returns the normalized
 * name, policy and rate the insert reuses.
 */
export async function validateProgramCandidate(
  runner: SqlExecutor,
  orgId: string,
  candidate: ProgramCandidate,
  excludeId: string | null = null,
): Promise<{ name: string; policy: StoredValueBreakagePolicy; rate: string }> {
  const name = candidate.name.trim();
  if (!name) {
    throw storedValueRefusal({
      message: "A stored-value program needs a name.",
      code: "stored_value_program_name_missing",
      remedy: "Name the program (for example Holiday gift cards).",
      field: "name",
    });
  }
  if (candidate.kind !== "gift_card" && candidate.kind !== "store_credit") {
    throw storedValueRefusal({
      message: "A stored-value program is either a gift card or store credit program.",
      code: "stored_value_program_kind_invalid",
      remedy: "Choose gift card or store credit for the program kind.",
      field: "kind",
    });
  }
  const policy = (candidate.breakagePolicy ?? "none") as StoredValueBreakagePolicy;
  const rate = candidate.breakageRate ?? "0";
  const rateUnits = toMinor(rate, "breakage rate");
  if (rateUnits < 0n || cmp(rate, "1") >= 0) {
    throw storedValueRefusal({
      message: "The expected breakage rate must be between 0 and 1 (for example 0.10 for ten percent).",
      code: "stored_value_breakage_rate_invalid",
      remedy: "Enter the expected breakage rate as a decimal between 0 and 1.",
      field: "breakageRate",
    });
  }
  if (policy === "proportional" && rateUnits <= 0n) {
    throw storedValueRefusal({
      message: "Proportional breakage needs a positive expected breakage rate.",
      code: "stored_value_breakage_rate_missing",
      remedy: "Enter the expected share of issued value that will never be redeemed (for example 0.10).",
      field: "breakageRate",
    });
  }
  if (candidate.liabilityAccountId) {
    await assertPostingAccount(runner, orgId, candidate.liabilityAccountId, "Program liability account", [
      "liability_payable",
      "liability_current_other",
    ]);
  }
  if (policy !== "none") {
    if (!candidate.breakageIncomeAccountId) {
      throw storedValueRefusal({
        message: "A breakage policy needs the income account that recognized breakage credits.",
        code: "stored_value_breakage_income_missing",
        remedy: "Choose the breakage income account on the program, or set its breakage policy to none.",
        field: "breakageIncomeAccountId",
      });
    }
    await assertPostingAccount(runner, orgId, candidate.breakageIncomeAccountId, "Breakage income account", [
      "income",
      "income_other",
    ]);
  }
  // Expiry posts like breakage (DR liability, CR breakage income), so a
  // program that expires cards needs the income account even when it never
  // recognizes proportional or remote breakage.
  if ((candidate.expiryMonths ?? null) && !candidate.breakageIncomeAccountId) {
    throw storedValueRefusal({
      message: "An expiring program needs the income account that expired balances credit.",
      code: "stored_value_expiry_income_missing",
      remedy: "Choose the breakage income account on the program, or remove its expiry.",
      field: "breakageIncomeAccountId",
    });
  }
  if (candidate.expiryMonths !== undefined && candidate.expiryMonths !== null && candidate.expiryMonths <= 0) {
    throw storedValueRefusal({
      message: "Gift card expiry must be a positive number of months.",
      code: "stored_value_expiry_invalid",
      remedy: "Enter expiry in whole months, or leave it empty where gift cards do not expire.",
      field: "expiryMonths",
    });
  }
  const idempotencyGuard = (await runner.execute<{ id: string }>(sql`
    select id from stored_value_programs
     where org_id = ${orgId} and kind = ${candidate.kind} and name = ${name}
       and (${excludeId}::uuid is null or id <> ${excludeId}::uuid)
  `)).rows[0];
  if (idempotencyGuard) {
    throw storedValueRefusal({
      message: `A ${candidate.kind === "gift_card" ? "gift card" : "store credit"} program named "${name}" already exists.`,
      code: "stored_value_program_duplicate",
      remedy: "Reuse the existing program or choose a different name.",
      field: "name",
      status: 409,
    });
  }
  return { name, policy, rate };
}

export async function createProgram(input: {
  orgId: string;
  name: string;
  kind: StoredValueKind;
  liabilityAccountId?: string | null;
  breakageIncomeAccountId?: string | null;
  breakagePolicy?: StoredValueBreakagePolicy;
  breakageRate?: string;
  expiryMonths?: number | null;
  inactivityMonths?: number;
  currency?: string | null;
  actorId?: string | null;
}): Promise<StoredValueProgramRow> {
  await requireStoredValueFeature(db, input.orgId);
  const { name, policy, rate } = await validateProgramCandidate(db, input.orgId, input);
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into stored_value_programs
      (org_id, name, kind, liability_account_id, breakage_income_account_id,
       breakage_policy, breakage_rate, expiry_months, inactivity_months,
       currency, created_by, updated_by)
    values (${input.orgId}, ${name}, ${input.kind}, ${input.liabilityAccountId ?? null},
      ${input.breakageIncomeAccountId ?? null}, ${policy}, ${rate},
      ${input.expiryMonths ?? null}, ${input.inactivityMonths ?? 24},
      ${input.currency ?? null}, ${input.actorId ?? null}, ${input.actorId ?? null})
    returning id
  `)).rows;
  if (inserted.length !== 1 || !inserted[0]) {
    throw storedValueRefusal({
      message: "The stored-value program could not be saved.",
      code: "stored_value_program_unsaved",
      remedy: "Retry; if it persists, check the program list before creating a duplicate.",
    });
  }
  return loadStoredValueProgram(input.orgId, inserted[0].id);
}

interface EntryInsert {
  accountId: string;
  kind: StoredValueEntryKind;
  amountMinor: bigint;
  balanceAfter: bigint;
  currency: string;
  /** The same movement in the account entity's functional currency. */
  functionalAmountMinor: bigint;
  /** The card→functional rate the functional amount was priced at. */
  fxRate: string;
  documentId?: string | null;
  documentLineId?: string | null;
  journalEntryId?: string | null;
  idempotencyKey: string;
  reason?: string | null;
  actorId?: string | null;
}

/**
 * Append one ledger entry. The (org, idempotency_key) unique key makes every
 * mutation replay-safe: a retried effect finds the first write and reports
 * it instead of moving money twice. A conflict is expected on replay — the
 * row count below distinguishes replay from loss — but it is only benign
 * when nothing else moved: callers that also update a balance check
 * priorStoredValueEntry before the update and refuse a replayed insert after.
 */
export async function insertStoredValueEntry(orgId: string, entry: EntryInsert): Promise<{ entryId: string; replayed: boolean }> {
  const inserted = (await db.execute<{ id: string }>(sql`
    insert into stored_value_entries
      (org_id, account_id, kind, amount_minor, balance_after, currency,
       functional_amount_minor, fx_rate,
       document_id, document_line_id, journal_entry_id, idempotency_key, reason, created_by, updated_by)
    values (${orgId}, ${entry.accountId}, ${entry.kind}, ${entry.amountMinor.toString()},
      ${entry.balanceAfter.toString()}, ${entry.currency},
      ${entry.functionalAmountMinor.toString()}, ${entry.fxRate},
      ${entry.documentId ?? null}, ${entry.documentLineId ?? null}, ${entry.journalEntryId ?? null},
      ${entry.idempotencyKey}, ${entry.reason ?? null}, ${entry.actorId ?? null}, ${entry.actorId ?? null})
    on conflict (org_id, idempotency_key) do nothing
    returning id
  `)).rows;
  if (inserted.length === 1 && inserted[0]) return { entryId: inserted[0].id, replayed: false };
  const existing = (await db.execute<{ id: string }>(sql`
    select id from stored_value_entries where org_id = ${orgId} and idempotency_key = ${entry.idempotencyKey}
  `)).rows[0];
  if (!existing) {
    throw storedValueRefusal({
      message: "The stored-value entry could not be recorded.",
      code: "stored_value_entry_unrecorded",
      remedy: "Retry the operation; the idempotency key prevents a duplicate.",
    });
  }
  return { entryId: existing.id, replayed: true };
}

export interface PriorStoredValueEntry {
  entryId: string;
  accountId: string;
  amountMinor: bigint;
  balanceAfter: bigint;
  journalEntryId: string | null;
}

/**
 * The entry already written under an idempotency key, read BEFORE a mutation
 * moves any balance. Every mutation checks this first: the entry insert
 * absorbs a replay, but the balance update beside it does not, so a retry
 * that reached the update would move the balance a second time with no
 * entry and no journal behind it. A prior entry that is not this same effect
 * (another account, kind or amount) is a reused key, refused by name rather
 * than answered with the first effect's result.
 */
export async function priorStoredValueEntry(
  orgId: string,
  idempotencyKey: string,
  expected: { accountId?: string; kind: StoredValueEntryKind; amountMinor?: bigint },
): Promise<PriorStoredValueEntry | null> {
  const row = (await db.execute<{
    id: string; accountId: string; kind: StoredValueEntryKind; amountMinor: string; balanceAfter: string; journalEntryId: string | null;
  }>(sql`
    select id, account_id as "accountId", kind, amount_minor::text as "amountMinor",
           balance_after::text as "balanceAfter", journal_entry_id as "journalEntryId"
      from stored_value_entries
     where org_id = ${orgId} and idempotency_key = ${idempotencyKey}
  `)).rows[0];
  if (!row) return null;
  const amountMinor = BigInt(row.amountMinor);
  const mismatches = [
    expected.accountId !== undefined && row.accountId !== expected.accountId ? "account" : null,
    row.kind !== expected.kind ? `kind (${row.kind}, not ${expected.kind})` : null,
    expected.amountMinor !== undefined && amountMinor !== expected.amountMinor
      ? `amount (${fromUnits(amountMinor)}, not ${fromUnits(expected.amountMinor)})`
      : null,
  ].filter((value): value is string => value !== null);
  if (mismatches.length > 0) {
    throw storedValueRefusal({
      message: `Idempotency key ${idempotencyKey} already recorded a different stored-value effect: ${mismatches.join(", ")} differ.`,
      code: "stored_value_idempotency_conflict",
      remedy: "Retry with the original request unchanged, or send a new idempotency key for a different operation.",
      status: 409,
    });
  }
  return {
    entryId: row.id,
    accountId: row.accountId,
    amountMinor,
    balanceAfter: BigInt(row.balanceAfter),
    journalEntryId: row.journalEntryId,
  };
}

/** A mutation that already moved the balance must land its own entry: a
 * conflict at this point is a concurrent writer under the same key, so the
 * caller's transaction rolls back instead of keeping a balance move that no
 * entry records. A retry then finds the winner's entry first. */
function requireFreshEntry(entry: { replayed: boolean }, idempotencyKey: string): void {
  if (!entry.replayed) return;
  throw storedValueRefusal({
    message: `Another request recorded idempotency key ${idempotencyKey} while this one was applying it.`,
    code: "stored_value_idempotency_conflict",
    remedy: "Retry the request unchanged; it returns the effect that was recorded.",
    status: 409,
  });
}

/**
 * Lock one account row for a mutation. The FOR UPDATE lock serializes
 * concurrent redemptions of the same balance; the row-count check turns an
 * RLS-unscoped or raced write into a refusal instead of silent success. When
 * several accounts lock in one unit of work, callers sort by id first.
 */
type StoredValueAccountRaw = {
  id: string; orgId: string; programId: string; kind: StoredValueKind;
  codeHash: string; codeLast4: string; customerPartyId: string | null;
  currency: string; subsidiaryId: string; status: StoredValueStatus; expiresOn: string | null;
  lastActivityOn: string; sourceDocumentId: string | null; liabilityAccountId: string | null;
  issuedMinorRaw: string; balanceMinorRaw: string; breakageRecognizedMinorRaw: string;
};

export async function lockStoredValueAccount(orgId: string, accountId: string): Promise<StoredValueAccountRow> {
  const rows = (await db.execute<StoredValueAccountRaw>(sql`
    select id, org_id as "orgId", program_id as "programId", kind, code_hash as "codeHash",
           code_last4 as "codeLast4", customer_party_id as "customerPartyId", currency,
           subsidiary_id as "subsidiaryId",
           issued_minor::text as "issuedMinorRaw", balance_minor::text as "balanceMinorRaw",
           breakage_recognized_minor::text as "breakageRecognizedMinorRaw",
           status, expires_on::text as "expiresOn", last_activity_on::text as "lastActivityOn",
           source_document_id as "sourceDocumentId", liability_account_id as "liabilityAccountId"
      from stored_value_accounts
     where org_id = ${orgId} and id = ${accountId}
     for update
  `)).rows;
  const row = rows[0];
  if (!row) {
    const count = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from stored_value_accounts where org_id = ${orgId} and id = ${accountId}`)).rows[0];
    if (count?.n === 0) {
      throw storedValueRefusal({
        message: "The stored-value account does not exist in this organization.",
        code: "stored_value_account_missing",
        remedy: "Look the account up by code or from the Stored value list, then retry.",
        status: 409,
      });
    }
    throw storedValueRefusal({
      message: "The stored-value account cannot be locked in this organization.",
      code: "stored_value_account_unreadable",
      remedy: "Retry the operation.",
    });
  }
  return {
    ...row,
    issuedMinor: BigInt(row.issuedMinorRaw),
    balanceMinor: BigInt(row.balanceMinorRaw),
    breakageRecognizedMinor: BigInt(row.breakageRecognizedMinorRaw),
  };
}

/**
 * A card is valid THROUGH its expiry date: it redeems on expires_on itself
 * and is expired from the next business day. Redemption and the expiry scan
 * decide from this one rule; the SQL form is the same comparison for the
 * scan's candidate query, so a card is never swept on a day it still redeems.
 */
export function storedValueExpired(expiresOn: string | null, today: string): boolean {
  return expiresOn !== null && expiresOn < today;
}

export function storedValueExpiredSql(expiresOn: SQL, today: string): SQL {
  return sql`(${expiresOn} is not null and ${expiresOn} < ${today}::date)`;
}

function assertRedeemable(
  account: StoredValueAccountRow,
  amountMinor: bigint,
  codeLabel: string,
): void {
  if (account.status !== "active") {
    throw storedValueRefusal({
      message: `Stored-value ${codeLabel} is ${account.status} and cannot be redeemed.`,
      code: "stored_value_account_not_redeemable",
      remedy:
        account.status === "frozen"
          ? "Unfreeze the account from the Stored value list before redeeming."
          : "Issue a new code or adjust through a correcting document instead.",
      status: 409,
    });
  }
  if (amountMinor <= 0n) {
    throw storedValueRefusal({
      message: "A redemption must be a positive amount.",
      code: "stored_value_redeem_nonpositive",
      remedy: "Enter the redemption amount as a positive value.",
    });
  }
  if (amountMinor > account.balanceMinor) {
    throw storedValueRefusal({
      message: `Stored-value ${codeLabel} holds ${fromUnits(account.balanceMinor)}, which is less than the requested ${fromUnits(amountMinor)}.`,
      code: "stored_value_insufficient_balance",
      remedy: `Redeem at most ${fromUnits(account.balanceMinor)}, or split the tender across another payment method.`,
      status: 409,
    });
  }
}

export async function postStoredValueJournal(input: {
  orgId: string;
  postingDate: string;
  subsidiaryId?: string | null;
  memo: string;
  origin: string;
  idempotencyKey: string;
  accountId: string;
  /** Signed functional-currency decimal: positive = debit, negative = credit. */
  amount: string;
  /** Signed card-currency decimal for the same leg. */
  txnAmount: string;
  counterAccountId: string;
  counterAmount: string;
  counterTxnAmount: string;
  /** Card→functional rate pricing both legs. */
  fxRate: string;
  /** Card currency for both legs. */
  currency: string;
  partyId?: string | null;
  actorId?: string | null;
  auditChanges: Record<string, unknown>;
}): Promise<string> {
  const context = await postingContext(db, input.orgId, input.postingDate, input.subsidiaryId ?? null);
  const entryNumber = await db.transaction((tx) =>
    nextFreeEntryNumber(tx, input.orgId, `SV-${input.origin.toUpperCase()}`),
  );
  // Both legs carry the card currency and the functional equivalent, exactly
  // like any other multi-currency posting: the ledger balances in functional
  // terms while the foreign exposure stays visible per line.
  const posted = await postEntry(db, {
    orgId: input.orgId,
    bookId: context.bookId,
    subsidiaryId: context.subsidiaryId,
    entryNumber,
    postingDate: input.postingDate,
    periodId: context.periodId,
    memo: input.memo,
    origin: "stored_value",
    actorId: input.actorId ?? null,
    currency: input.currency,
    idempotencyKey: input.idempotencyKey,
    auditAction: "create",
    auditChanges: input.auditChanges,
    lines: [
      {
        accountId: input.accountId, amount: input.amount,
        currency: input.currency, txnAmount: input.txnAmount, fxRate: input.fxRate,
        partyId: input.partyId ?? null,
      },
      {
        accountId: input.counterAccountId, amount: input.counterAmount,
        currency: input.currency, txnAmount: input.counterTxnAmount, fxRate: input.fxRate,
        partyId: input.partyId ?? null,
      },
    ],
  });
  return posted.entryId;
}

/**
 * Realized FX on a redemption: the redeemed slice was carried at its
 * historical rate but relieved at the redemption rate. The restatement pair
 * reprices that slice from the redemption rate back to its carrying rate in
 * the card currency, and the difference posts to the realized FX gain/loss
 * account — so the liability keeps its historical carrying value (which is
 * what the period-end revaluation restates) while the repricing lands in P&L
 * once and never reverses. Skipped when the rates agree: a zero P&L leg
 * would be rejected by the kernel.
 */
export async function postRealizedFxJournal(input: {
  orgId: string;
  postingDate: string;
  subsidiaryId: string;
  functionalCurrency: string;
  cardCurrency: string;
  liabilityAccountId: string;
  gainLossAccountId: string;
  redeemedMinor: bigint;
  carryingFunctionalMinor: bigint;
  carryingRate: string;
  currentFunctionalMinor: bigint;
  currentRate: string;
  documentId: string;
  accountId: string;
  codeLast4: string;
  idempotencyKey: string;
  partyId: string | null;
  actorId?: string | null;
}): Promise<string | null> {
  const delta = input.currentFunctionalMinor - input.carryingFunctionalMinor;
  if (delta === 0n) return null;
  const context = await postingContext(db, input.orgId, input.postingDate, input.subsidiaryId);
  const entryNumber = await db.transaction((tx) =>
    nextFreeEntryNumber(tx, input.orgId, "SV-REALIZED"),
  );
  const posted = await postEntry(db, {
    orgId: input.orgId,
    bookId: context.bookId,
    subsidiaryId: context.subsidiaryId,
    entryNumber,
    postingDate: input.postingDate,
    periodId: context.periodId,
    memo: `Realized FX on stored-value redemption — …${input.codeLast4}`,
    origin: "stored_value",
    sourceDocumentId: input.documentId,
    actorId: input.actorId ?? null,
    currency: input.functionalCurrency,
    idempotencyKey: `stored-value:realized:${input.idempotencyKey}`,
    auditAction: "create",
    auditChanges: {
      accountId: input.accountId,
      kind: "realized_fx",
      redeemedMinor: input.redeemedMinor.toString(),
      carryingRate: input.carryingRate,
      currentRate: input.currentRate,
    },
    lines: [
      {
        accountId: input.liabilityAccountId, amount: fromUnits(input.carryingFunctionalMinor),
        currency: input.cardCurrency, txnAmount: fromUnits(input.redeemedMinor), fxRate: input.carryingRate,
        partyId: input.partyId,
      },
      {
        accountId: input.liabilityAccountId, amount: fromUnits(-input.currentFunctionalMinor),
        currency: input.cardCurrency, txnAmount: fromUnits(-input.redeemedMinor), fxRate: input.currentRate,
        partyId: input.partyId,
      },
      {
        accountId: input.gainLossAccountId, amount: fromUnits(delta),
        currency: input.functionalCurrency, txnAmount: fromUnits(delta), fxRate: "1",
        partyId: input.partyId,
      },
    ],
  });
  return posted.entryId;
}

/**
 * The realized FX gain/loss home for redemption repricing. Refuses by name
 * when unset: without it a cross-rate redemption would have nowhere to book
 * the difference but the liability, which would misstate both.
 */
export async function realizedFxGainLossAccount(orgId: string): Promise<string> {
  const controls = await loadControlAccounts(orgId);
  if (!controls.fxRealizedGainLoss) {
    throw storedValueRefusal({
      message: "No realized FX gain/loss account is configured for this organization.",
      code: "stored_value_realized_fx_unset",
      remedy: "Select a realized FX gain/loss account in Admin → Setup → Company (control accounts), then retry.",
    });
  }
  return controls.fxRealizedGainLoss;
}

export interface IssueInput {
  orgId: string;
  programId: string;
  /** Minor units, must be positive. */
  amountMinor: bigint;
  currency: string;
  /** Issuing legal entity; the hierarchy root when omitted, like documents. */
  subsidiaryId?: string | null;
  customerPartyId?: string | null;
  expiresOn?: string | null;
  sourceDocumentId?: string | null;
  sourceLineId?: string | null;
  /** Caller-provided exactly-once key (document postings derive it per line). */
  idempotencyKey: string;
  /** Debit account for a direct issue (bank or clearing). Omitted when the
   * sale's own journal carries the debit — see attachSaleIssue. */
  debitAccountId?: string | null;
  postingDate?: string | null;
  memo?: string | null;
  actorId?: string | null;
}

export interface IssueResult {
  accountId: string;
  /** Plaintext code, shown once at issuance and never stored. */
  code: string | null;
  entryId: string;
  journalEntryId: string | null;
  replayed: boolean;
}

/**
 * Issue stored value: mint one account with its code, append the issue
 * entry, and post DR debit / CR liability in the same transaction. A direct
 * issue names its debit account; a sale-driven issue attaches to the sale's
 * journal instead (attachSaleIssue) so the sale still posts exactly once.
 */
export async function issueStoredValue(input: IssueInput): Promise<IssueResult> {
  await requireStoredValueFeature(db, input.orgId);
  const prior = await priorStoredValueEntry(input.orgId, `stored-value:issue-entry:${input.idempotencyKey}`, {
    kind: "issue",
    amountMinor: input.amountMinor,
  });
  if (prior) {
    return { accountId: prior.accountId, code: null, entryId: prior.entryId, journalEntryId: prior.journalEntryId, replayed: true };
  }
  const program = await loadStoredValueProgram(input.orgId, input.programId);
  if (!program.isActive) {
    throw storedValueRefusal({
      message: `The ${program.name} program is inactive and cannot issue.`,
      code: "stored_value_program_inactive",
      remedy: "Reactivate the program in Setup → Sales → Stored value programs, or choose an active one.",
      status: 409,
    });
  }
  if (program.currency && program.currency !== input.currency) {
    throw storedValueRefusal({
      message: `The ${program.name} program issues in ${program.currency}, not ${input.currency}.`,
      code: "stored_value_currency_mismatch",
      remedy: `Issue in ${program.currency}, or create a ${input.currency} program.`,
    });
  }
  if (input.amountMinor <= 0n) {
    throw storedValueRefusal({
      message: "Issued stored value must be a positive amount.",
      code: "stored_value_issue_nonpositive",
      remedy: "Enter the issued amount as a positive value.",
    });
  }
  if (program.kind === "store_credit" && !input.customerPartyId) {
    throw storedValueRefusal({
      message: "Store credit is issued to a customer, never to bearer.",
      code: "stored_value_store_credit_customer_missing",
      remedy: "Select the customer the store credit belongs to.",
    });
  }
  if (input.customerPartyId) {
    const party = (await db.execute<{ id: string }>(sql`
      select id from parties where org_id = ${input.orgId} and id = ${input.customerPartyId} and is_active
    `)).rows[0];
    if (!party) {
      throw storedValueRefusal({
        message: "The store-credit customer does not exist in this organization.",
        code: "stored_value_customer_missing",
        remedy: "Select an active customer, then retry.",
      });
    }
  }
  const liabilityAccountId = await programLiabilityAccount(input.orgId, program);
  // No expiry unless the program sets one: expiry is a policy per program,
  // and the lawful default is none.
  let expiresOn = input.expiresOn ?? null;
  if (expiresOn) requireDate(expiresOn, "expires on");
  else if (program.expiryMonths) {
    expiresOn = addMonthsClamped(await businessToday(input.orgId), program.expiryMonths);
  }
  if (!input.debitAccountId) {
    throw storedValueRefusal({
      message: "A direct issue needs the account receiving the consideration (bank or clearing).",
      code: "stored_value_issue_debit_missing",
      remedy: "Pass the debit account, or issue through a sale or credit memo so its journal carries the debit.",
    });
  }
  await assertPostingAccount(db, input.orgId, input.debitAccountId, "Issue debit account", [
    "asset_bank",
    "asset_current_other",
    "asset_receivable",
  ]);
  const postingDate = input.postingDate ?? (await businessToday(input.orgId));
  requireDate(postingDate, "posting date");
  // A direct issue is an off-document event: it prices at the business-date
  // spot on its own entity, and both journal legs convert alike.
  const context = await postingContext(db, input.orgId, postingDate, input.subsidiaryId ?? null);
  const eventRate = await resolveEventRate(db, input.orgId, input.currency, context.currency, postingDate, null);
  const functional = functionalMinor(input.amountMinor, eventRate.units);

  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateStoredValueCode();
    const codeHash = hashStoredValueCode(input.orgId, code);
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into stored_value_accounts
        (org_id, program_id, kind, code_hash, code_last4, customer_party_id, currency,
         subsidiary_id,
         issued_minor, balance_minor, expires_on, source_document_id, liability_account_id,
         created_by, updated_by)
      values (${input.orgId}, ${program.id}, ${program.kind}, ${codeHash}, ${codeLast4(code)},
        ${input.customerPartyId ?? null}, ${input.currency},
        ${context.subsidiaryId},
        ${input.amountMinor.toString()},
        ${input.amountMinor.toString()}, ${expiresOn}, ${input.sourceDocumentId ?? null},
        ${liabilityAccountId}, ${input.actorId ?? null}, ${input.actorId ?? null})
      on conflict (org_id, code_hash) do nothing
      returning id
    `)).rows;
    // A code collision is expected to be vanishingly rare but possible: the
    // conflict is benign, so mint a fresh code and retry rather than fail.
    if (inserted.length !== 1 || !inserted[0]) continue;
    const accountId = inserted[0].id;
    const journalEntryId = await postStoredValueJournal({
      orgId: input.orgId,
      postingDate,
      subsidiaryId: context.subsidiaryId,
      memo: input.memo ?? `Stored-value issue — ${program.name}`,
      origin: "issue",
      idempotencyKey: `stored-value:issue:${input.idempotencyKey}`,
      accountId: input.debitAccountId,
      amount: fromUnits(functional),
      txnAmount: fromUnits(input.amountMinor),
      counterAccountId: liabilityAccountId,
      counterAmount: neg(fromUnits(functional)),
      counterTxnAmount: neg(fromUnits(input.amountMinor)),
      fxRate: eventRate.rate,
      currency: input.currency,
      partyId: input.customerPartyId ?? null,
      actorId: input.actorId ?? null,
      auditChanges: { programId: program.id, accountId },
    });
    const entry = await insertStoredValueEntry(input.orgId, {
      accountId,
      kind: "issue",
      amountMinor: input.amountMinor,
      balanceAfter: input.amountMinor,
      currency: input.currency,
      functionalAmountMinor: functional,
      fxRate: eventRate.rate,
      documentId: input.sourceDocumentId ?? null,
      documentLineId: input.sourceLineId ?? null,
      journalEntryId,
      idempotencyKey: `stored-value:issue-entry:${input.idempotencyKey}`,
      actorId: input.actorId ?? null,
    });
    requireFreshEntry(entry, input.idempotencyKey);
    return { accountId, code, entryId: entry.entryId, journalEntryId, replayed: false };
  }
  throw storedValueRefusal({
    message: "The stored-value code could not be minted.",
    code: "stored_value_code_collision",
    remedy: "Retry the issuance.",
  });
}

export interface RedeemInput {
  orgId: string;
  accountId: string;
  /** Minor units, must be positive and within the available balance. */
  amountMinor: bigint;
  documentId?: string | null;
  documentLineId?: string | null;
  /** The caller's posted journal (a payment's entry); redemption attaches to
   * it instead of posting its own, so one tender never posts twice. */
  journalEntryId?: string | null;
  idempotencyKey: string;
  actorId?: string | null;
}

/**
 * Redeem stored value against a payment: lock the account, refuse on
 * insufficient balance (naming what is available), decrement, and append the
 * redeem entry in the caller's transaction. The relief journal leg comes
 * from the caller's document — this function moves the subledger, and posts
 * only the realized FX repricing when the redemption rate differs from the
 * redeemed slice's carrying rate.
 */
export async function redeemStoredValue(input: RedeemInput): Promise<{ entryId: string; balanceMinor: bigint }> {
  await requireStoredValueFeature(db, input.orgId);
  if (input.amountMinor <= 0n) {
    throw storedValueRefusal({
      message: "A redemption must be a positive amount.",
      code: "stored_value_redeem_nonpositive",
      remedy: "Enter the redemption amount as a positive value.",
    });
  }
  const account = await lockStoredValueAccount(input.orgId, input.accountId);
  // Checked under the row lock, so a concurrent retry waits for the first
  // write and then finds its entry instead of redeeming a second time.
  const prior = await priorStoredValueEntry(input.orgId, `stored-value:redeem-entry:${input.idempotencyKey}`, {
    accountId: account.id,
    kind: "redeem",
    amountMinor: -input.amountMinor,
  });
  if (prior) return { entryId: prior.entryId, balanceMinor: prior.balanceAfter };
  if (input.documentId) {
    const owner = (
      await db.execute<{ partyId: string | null }>(sql`
        select party_id as "partyId" from documents
         where org_id = ${input.orgId} and id = ${input.documentId}`)
    ).rows[0];
    if (owner && !storedValueAccountOwnedByCustomer(account, owner.partyId)) {
      throw storedValueRefusal({
        message: `Stored-value …${account.codeLast4} belongs to another customer and cannot move on this document.`,
        code: "stored_value_customer_mismatch",
        status: 409,
        remedy: "Tender a gift card or store credit issued to this document's customer instead.",
      });
    }
  }
  assertRedeemable(account, input.amountMinor, `…${account.codeLast4}`);
  if (account.expiresOn) {
    const today = await businessToday(input.orgId);
    if (storedValueExpired(account.expiresOn, today)) {
      throw storedValueRefusal({
        message: `Stored-value …${account.codeLast4} expired on ${account.expiresOn}.`,
        code: "stored_value_account_expired",
        remedy: "The scheduled stored-value scan recognizes the expired balance; issue the customer a replacement if it should still be honoured.",
        status: 409,
      });
    }
  }
  const pricing = await priceRedemption(input, account);
  const balanceMinor = account.balanceMinor - input.amountMinor;
  const updated = (await db.execute<{ id: string }>(sql`
    update stored_value_accounts
       set balance_minor = ${balanceMinor.toString()},
           last_activity_on = CURRENT_DATE,
           updated_at = now(), updated_by = ${input.actorId ?? null}
     where org_id = ${input.orgId} and id = ${account.id} and balance_minor = ${account.balanceMinor.toString()}
    returning id
  `)).rows;
  if (updated.length !== 1) {
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} changed while redeeming; the balance no longer covers this redemption.`,
      code: "stored_value_balance_changed",
      remedy: "Re-read the available balance and retry.",
      status: 409,
    });
  }
  const entry = await insertStoredValueEntry(input.orgId, {
    accountId: account.id,
    kind: "redeem",
    amountMinor: -input.amountMinor,
    balanceAfter: balanceMinor,
    currency: account.currency,
    functionalAmountMinor: -pricing.entryFunctional,
    fxRate: pricing.entryRate,
    documentId: input.documentId ?? null,
    documentLineId: input.documentLineId ?? null,
    journalEntryId: input.journalEntryId ?? null,
    idempotencyKey: `stored-value:redeem-entry:${input.idempotencyKey}`,
    actorId: input.actorId ?? null,
  });
  requireFreshEntry(entry, input.idempotencyKey);
  if (pricing.realized) {
    await postRealizedFxJournal({
      orgId: input.orgId,
      postingDate: pricing.realized.postingDate,
      subsidiaryId: account.subsidiaryId,
      functionalCurrency: pricing.realized.functionalCurrency,
      cardCurrency: account.currency,
      liabilityAccountId: pricing.realized.liabilityAccountId,
      gainLossAccountId: pricing.realized.gainLossAccountId,
      redeemedMinor: input.amountMinor,
      carryingFunctionalMinor: pricing.entryFunctional,
      carryingRate: pricing.entryRate,
      currentFunctionalMinor: pricing.realized.currentFunctional,
      currentRate: pricing.realized.currentRate,
      documentId: pricing.realized.documentId,
      accountId: account.id,
      codeLast4: account.codeLast4,
      idempotencyKey: input.idempotencyKey,
      partyId: account.customerPartyId,
      actorId: input.actorId ?? null,
    });
  }
  return { entryId: entry.entryId, balanceMinor };
}

type RedemptionPricing = {
  /** Functional minor units the redeem entry relieves (positive). */
  entryFunctional: bigint;
  entryRate: string;
  realized: {
    postingDate: string;
    documentId: string;
    functionalCurrency: string;
    liabilityAccountId: string;
    gainLossAccountId: string;
    currentFunctional: bigint;
    currentRate: string;
  } | null;
};

/**
 * Price one redemption. The subledger always relieves the redeemed slice at
 * its carrying rate, so the functional remainder keeps tying to the ledger
 * liability. A document redemption additionally reprices that slice at the
 * document's rate: when the two disagree the difference is realized FX, and
 * the caller needs the gain/loss home and the liability account up front.
 * An off-document redemption prices at the business-date spot with no
 * ledger counterparty to correct.
 */
async function priceRedemption(
  input: RedeemInput,
  account: StoredValueAccountRow,
): Promise<RedemptionPricing> {
  const baseCurrency = await subsidiaryBaseCurrency(db, input.orgId, account.subsidiaryId);
  const functionalPrior = await accountFunctionalTotal(db, input.orgId, account.id);
  if (!input.documentId) {
    const today = await businessToday(input.orgId);
    const eventRate = await resolveEventRate(db, input.orgId, account.currency, baseCurrency, today, null);
    return {
      entryFunctional: functionalMinor(input.amountMinor, eventRate.units),
      entryRate: eventRate.rate,
      realized: null,
    };
  }
  const doc = await loadDocumentFxContext(db, input.orgId, input.documentId);
  if (doc.currency !== account.currency) {
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} holds ${account.currency}, but the document is in ${doc.currency}.`,
      code: "stored_value_redeem_currency_mismatch",
      remedy: `Redeem …${account.codeLast4} on a ${account.currency} document.`,
      status: 409,
    });
  }
  if (doc.subsidiaryId !== account.subsidiaryId) {
    const accountSub = (await db.execute<{ name: string }>(sql`
      select name from subsidiaries where org_id = ${input.orgId} and id = ${account.subsidiaryId}
    `)).rows[0]?.name ?? account.subsidiaryId;
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} belongs to ${accountSub}, but the document posts to ${doc.subsidiaryName}: one entity cannot relieve another's debt.`,
      code: "stored_value_cross_entity",
      remedy: `Redeem …${account.codeLast4} on a ${accountSub} document.`,
      status: 409,
    });
  }
  const eventRate = await resolveEventRate(db, input.orgId, account.currency, baseCurrency, doc.postingDate, doc);
  const current = functionalMinor(input.amountMinor, eventRate.units);
  const share = carryingShare(functionalPrior, account.balanceMinor, input.amountMinor);
  const needsRealized = current !== share.functional && account.currency !== baseCurrency;
  if (!needsRealized) {
    return { entryFunctional: share.functional, entryRate: share.rate, realized: null };
  }
  const liabilityAccountId =
    account.liabilityAccountId ??
    (await programLiabilityAccount(input.orgId, await loadStoredValueProgram(input.orgId, account.programId)));
  return {
    entryFunctional: share.functional,
    entryRate: share.rate,
    realized: {
      postingDate: doc.postingDate,
      documentId: doc.id,
      functionalCurrency: baseCurrency,
      liabilityAccountId,
      gainLossAccountId: await realizedFxGainLossAccount(input.orgId),
      currentFunctional: current,
      currentRate: eventRate.rate,
    },
  };
}

export interface AdjustInput {
  orgId: string;
  accountId: string;
  /** Signed minor units: positive raises the balance, negative lowers it. */
  deltaMinor: bigint;
  /** Mandatory: an out-of-document balance change is audit evidence. */
  reason: string;
  offsetAccountId: string;
  postingDate?: string | null;
  idempotencyKey: string;
  actorId?: string | null;
}

/**
 * Correct a balance outside any document (segregated `stored_value.adjust`
 * duty). The offset keeps the correction balanced: a raised balance credits
 * the liability against the offset debit, a lowered one reverses that.
 */
export async function adjustStoredValue(input: AdjustInput): Promise<{ entryId: string; journalEntryId: string; balanceMinor: bigint }> {
  await requireStoredValueFeature(db, input.orgId);
  const reason = input.reason.trim();
  if (!reason) {
    throw storedValueRefusal({
      message: "A balance adjustment needs a reason.",
      code: "stored_value_adjust_reason_missing",
      remedy: "Record why the balance changes (for example counting error on issue).",
      field: "reason",
    });
  }
  if (input.deltaMinor === 0n) {
    throw storedValueRefusal({
      message: "An adjustment must move the balance.",
      code: "stored_value_adjust_zero",
      remedy: "Enter a nonzero correction amount.",
    });
  }
  const account = await lockStoredValueAccount(input.orgId, input.accountId);
  const prior = await priorStoredValueEntry(input.orgId, `stored-value:adjust-entry:${input.idempotencyKey}`, {
    accountId: account.id,
    kind: "adjust",
    amountMinor: input.deltaMinor,
  });
  if (prior) {
    if (!prior.journalEntryId) {
      throw storedValueRefusal({
        message: `The adjustment recorded under idempotency key ${input.idempotencyKey} names no journal entry.`,
        code: "stored_value_entry_unrecorded",
        remedy: "Have the stored-value entry history for this account reviewed before adjusting it again.",
      });
    }
    return { entryId: prior.entryId, journalEntryId: prior.journalEntryId, balanceMinor: prior.balanceAfter };
  }
  if (account.status === "closed" || account.status === "expired") {
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} is ${account.status}; closed history is corrected by reversal, not adjustment.`,
      code: "stored_value_adjust_closed",
      remedy: "Issue a new code for the customer instead of editing closed history.",
      status: 409,
    });
  }
  const balanceMinor = account.balanceMinor + input.deltaMinor;
  if (balanceMinor < 0n) {
    throw storedValueRefusal({
      message: `The adjustment would drive stored-value …${account.codeLast4} to ${fromUnits(balanceMinor)}; balances can never go negative.`,
      code: "stored_value_insufficient_balance",
      remedy: `Lower the balance by at most ${fromUnits(account.balanceMinor)}.`,
      status: 409,
    });
  }
  await assertPostingAccount(db, input.orgId, input.offsetAccountId, "Adjustment offset account", [
    "expense",
    "expense_other",
    "cogs",
    "income",
    "income_other",
  ]);
  const postingDate = input.postingDate ?? (await businessToday(input.orgId));
  requireDate(postingDate, "posting date");
  // A correction is an off-document event: it prices at the posting-date
  // spot on the account's own entity, and both journal legs convert alike.
  const baseCurrency = await subsidiaryBaseCurrency(db, input.orgId, account.subsidiaryId);
  const eventRate = await resolveEventRate(db, input.orgId, account.currency, baseCurrency, postingDate, null);
  const functional = functionalMinor(input.deltaMinor, eventRate.units);
  const liabilityAccountId = account.liabilityAccountId ?? (await storedValueLiabilityControlAccount(input.orgId));
  const journalEntryId = await postStoredValueJournal({
    orgId: input.orgId,
    postingDate,
    subsidiaryId: account.subsidiaryId,
    memo: `Stored-value adjustment — …${account.codeLast4}: ${reason}`,
    origin: "adjust",
    idempotencyKey: `stored-value:adjust:${input.idempotencyKey}`,
    accountId: input.deltaMinor > 0n ? input.offsetAccountId : liabilityAccountId,
    amount: fromUnits(functional > 0n ? functional : -functional),
    txnAmount: fromUnits(input.deltaMinor > 0n ? input.deltaMinor : -input.deltaMinor),
    counterAccountId: input.deltaMinor > 0n ? liabilityAccountId : input.offsetAccountId,
    counterAmount: fromUnits(functional > 0n ? -functional : functional),
    counterTxnAmount: fromUnits(input.deltaMinor > 0n ? -input.deltaMinor : input.deltaMinor),
    fxRate: eventRate.rate,
    currency: account.currency,
    partyId: account.customerPartyId,
    actorId: input.actorId ?? null,
    auditChanges: { accountId: account.id, reason },
  });
  const updated = (await db.execute<{ id: string }>(sql`
    update stored_value_accounts
       set balance_minor = ${balanceMinor.toString()},
           last_activity_on = CURRENT_DATE,
           updated_at = now(), updated_by = ${input.actorId ?? null}
     where org_id = ${input.orgId} and id = ${account.id} and balance_minor = ${account.balanceMinor.toString()}
    returning id
  `)).rows;
  if (updated.length !== 1) {
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} changed while adjusting.`,
      code: "stored_value_balance_changed",
      remedy: "Re-read the balance and retry.",
      status: 409,
    });
  }
  const entry = await insertStoredValueEntry(input.orgId, {
    accountId: account.id,
    kind: "adjust",
    amountMinor: input.deltaMinor,
    balanceAfter: balanceMinor,
    currency: account.currency,
    functionalAmountMinor: functional,
    fxRate: eventRate.rate,
    journalEntryId,
    idempotencyKey: `stored-value:adjust-entry:${input.idempotencyKey}`,
    reason,
    actorId: input.actorId ?? null,
  });
  requireFreshEntry(entry, input.idempotencyKey);
  return { entryId: entry.entryId, journalEntryId, balanceMinor };
}

const STATUS_TRANSITIONS: Record<StoredValueStatus, readonly StoredValueStatus[]> = {
  active: ["frozen", "closed"],
  frozen: ["active", "closed"],
  closed: [],
  expired: [],
};

/** Freeze, unfreeze or close an account. Closing needs a zero balance — a
 * remaining balance leaves through redemption, breakage or expiry, never by
 * closing over it. Every transition writes audit evidence. */
export async function setStoredValueStatus(input: {
  orgId: string;
  accountId: string;
  to: StoredValueStatus;
  reason?: string | null;
  actorId?: string | null;
}): Promise<void> {
  await requireStoredValueFeature(db, input.orgId);
  const account = await lockStoredValueAccount(input.orgId, input.accountId);
  if (!STATUS_TRANSITIONS[account.status].includes(input.to)) {
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} cannot move from ${account.status} to ${input.to}.`,
      code: "stored_value_status_conflict",
      remedy: "Move the account through its required lifecycle state first.",
      status: 409,
    });
  }
  if (input.to === "closed" && account.balanceMinor !== 0n) {
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} still holds ${fromUnits(account.balanceMinor)}; close only after the balance reaches zero.`,
      code: "stored_value_close_nonzero",
      remedy: "Redeem, expire, or recognize breakage on the remaining balance before closing.",
      status: 409,
    });
  }
  const updated = (await db.execute<{ id: string }>(sql`
    update stored_value_accounts
       set status = ${input.to}, updated_at = now(), updated_by = ${input.actorId ?? null}
     where org_id = ${input.orgId} and id = ${account.id} and status = ${account.status}
    returning id
  `)).rows;
  if (updated.length !== 1) {
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} changed while updating its status.`,
      code: "stored_value_status_changed",
      remedy: "Re-read the account and retry.",
      status: 409,
    });
  }
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${input.orgId}, 'stored_value_accounts', ${account.id}, 'update', ${JSON.stringify({
      event: "stored_value_status_changed",
      before: { status: account.status },
      after: { status: input.to },
      reason: input.reason ?? null,
    })}::jsonb, ${input.actorId ?? null})
  `);
}

export interface BalanceView {
  accountId: string;
  programId: string;
  kind: StoredValueKind;
  currency: string;
  balanceMinor: string;
  status: StoredValueStatus;
  expiresOn: string | null;
  customerPartyId: string | null;
}

/** Balance lookup by code for POS/storefront use. The code is normalized
 * and hashed, then compared in constant time — a wrong code reveals nothing
 * about any stored code. Unknown codes refuse identically to inactive ones
 * would to an unauthenticated caller; the route adds its own authz. */
export async function lookupStoredValueByCode(orgId: string, code: string): Promise<BalanceView | null> {
  const normalized = normalizeStoredValueCode(code);
  if (!normalized) return null;
  const digest = hashStoredValueCode(orgId, code);
  const rows = (await db.execute<{
    id: string; programId: string; kind: StoredValueKind; currency: string;
    balanceMinor: string; status: StoredValueStatus; expiresOn: string | null;
    customerPartyId: string | null; codeHash: string;
  }>(sql`
    select id, program_id as "programId", kind, currency,
           balance_minor::text as "balanceMinor", status,
           expires_on::text as "expiresOn", customer_party_id as "customerPartyId",
           code_hash as "codeHash"
      from stored_value_accounts
     where org_id = ${orgId} and code_hash = ${digest}
     limit 1
  `)).rows;
  const row = rows[0];
  if (!row || !digestsEqual(digest, row.codeHash)) return null;
  return {
    accountId: row.id,
    programId: row.programId,
    kind: row.kind,
    currency: row.currency,
    balanceMinor: row.balanceMinor,
    status: row.status,
    expiresOn: row.expiresOn,
    customerPartyId: row.customerPartyId,
  };
}

/** Feature registries enumerate orgs through the same resolver the Features
 * page uses, so the scan agrees with the switchboard. */
export function storedValueEnabledFor(settings: unknown): boolean {
  return featureEnabled((settings ?? {}) as Record<string, boolean>, "storedValue");
}

export interface TenderResolution {
  accountId: string;
  kind: StoredValueKind;
  currency: string;
  balanceMinor: bigint;
  status: StoredValueStatus;
  customerPartyId: string | null;
  codeLast4: string;
  liabilityAccountId: string | null;
}

/**
 * Resolve one tender code to its account for a payment draft. Best-effort by
 * design: posting re-locks the account and re-verifies everything, so this
 * read names unknown codes early without ever authorizing the spend.
 */
export async function resolveStoredValueTender(orgId: string, code: string): Promise<TenderResolution | null> {
  const normalized = normalizeStoredValueCode(code);
  if (!normalized) return null;
  const digest = hashStoredValueCode(orgId, code);
  const rows = (await db.execute<{
    id: string; kind: StoredValueKind; currency: string; balanceRaw: string;
    status: StoredValueStatus; customerPartyId: string | null; codeHash: string;
    codeLast4: string; accountLiability: string | null; programLiability: string | null;
  }>(sql`
    select a.id, a.kind, a.currency, a.balance_minor::text as "balanceRaw", a.status,
           a.customer_party_id as "customerPartyId", a.code_hash as "codeHash",
           a.code_last4 as "codeLast4", a.liability_account_id as "accountLiability",
           p.liability_account_id as "programLiability"
      from stored_value_accounts a
      join stored_value_programs p on p.org_id = a.org_id and p.id = a.program_id
     where a.org_id = ${orgId} and a.code_hash = ${digest}
     limit 1
  `)).rows;
  const row = rows[0];
  if (!row || !digestsEqual(digest, row.codeHash)) return null;
  return {
    accountId: row.id,
    kind: row.kind,
    currency: row.currency,
    balanceMinor: BigInt(row.balanceRaw),
    status: row.status,
    customerPartyId: row.customerPartyId,
    codeLast4: row.codeLast4,
    liabilityAccountId: row.accountLiability ?? row.programLiability,
  };
}

/**
 * Reload one tender account by id for a payment draft that echoes an
 * already-resolved tender. The plaintext code is shown once at issue and is
 * gone by design; the snapshot carries the account id instead. Posting
 * re-locks the account and re-verifies balance, currency and status, so
 * re-accepting the snapshot here cannot overspend.
 */
export async function loadStoredValueTenderAccount(
  orgId: string,
  accountId: string,
): Promise<TenderResolution | null> {
  const rows = (await db.execute<{
    id: string; kind: StoredValueKind; currency: string; balanceRaw: string;
    status: StoredValueStatus; customerPartyId: string | null;
    codeLast4: string; accountLiability: string | null; programLiability: string | null;
  }>(sql`
    select a.id, a.kind, a.currency, a.balance_minor::text as "balanceRaw", a.status,
           a.customer_party_id as "customerPartyId",
           a.code_last4 as "codeLast4", a.liability_account_id as "accountLiability",
           p.liability_account_id as "programLiability"
      from stored_value_accounts a
      join stored_value_programs p on p.org_id = a.org_id and p.id = a.program_id
     where a.org_id = ${orgId} and a.id = ${accountId}
     limit 1
  `)).rows;
  const row = rows[0];
  if (!row) return null;
  return {
    accountId: row.id,
    kind: row.kind,
    currency: row.currency,
    balanceMinor: BigInt(row.balanceRaw),
    status: row.status,
    customerPartyId: row.customerPartyId,
    codeLast4: row.codeLast4,
    liabilityAccountId: row.accountLiability ?? row.programLiability,
  };
}

export interface DocumentIssueInput {
  orgId: string;
  programId: string;
  amountMinor: bigint;
  currency: string;
  customerPartyId?: string | null;
  expiresOn?: string | null;
  sourceDocumentId: string;
  sourceLineId?: string | null;
  journalEntryId: string;
  idempotencyKey: string;
  actorId?: string | null;
}

/**
 * Attach a sale- or credit-driven issue to its document's journal. The
 * document's own posting already moved DR bank/AR against CR liability —
 * this mints the redeemable account and the issue entry pointing at that
 * journal, so the sale still posts exactly once. Replays find the first
 * entry and report it without minting a second code.
 */
export async function attachDocumentIssue(input: DocumentIssueInput): Promise<IssueResult> {
  await requireStoredValueFeature(db, input.orgId);
  const replayed = (await db.execute<{ account_id: string; id: string }>(sql`
    select account_id, id from stored_value_entries
     where org_id = ${input.orgId} and idempotency_key = ${`stored-value:issue-entry:${input.idempotencyKey}`}
  `)).rows[0];
  if (replayed) {
    return { accountId: replayed.account_id, code: null, entryId: replayed.id, journalEntryId: input.journalEntryId, replayed: true };
  }
  const program = await loadStoredValueProgram(input.orgId, input.programId);
  if (!program.isActive) {
    throw storedValueRefusal({
      message: `The ${program.name} program is inactive and cannot issue.`,
      code: "stored_value_program_inactive",
      remedy: "Reactivate the program in Setup → Sales → Stored value programs, or choose an active one.",
      status: 409,
    });
  }
  if (program.currency && program.currency !== input.currency) {
    throw storedValueRefusal({
      message: `The ${program.name} program issues in ${program.currency}, not ${input.currency}.`,
      code: "stored_value_currency_mismatch",
      remedy: `Issue in ${program.currency}, or create a ${input.currency} program.`,
    });
  }
  if (input.amountMinor <= 0n) {
    throw storedValueRefusal({
      message: "Issued stored value must be a positive amount.",
      code: "stored_value_issue_nonpositive",
      remedy: "Enter the issued amount as a positive value.",
    });
  }
  if (program.kind === "store_credit" && !input.customerPartyId) {
    throw storedValueRefusal({
      message: "Store credit is issued to a customer, never to bearer.",
      code: "stored_value_store_credit_customer_missing",
      remedy: "Select the customer the store credit belongs to.",
    });
  }
  const liabilityAccountId = await programLiabilityAccount(input.orgId, program);
  let expiresOn = input.expiresOn ?? null;
  if (expiresOn) requireDate(expiresOn, "expires on");
  else if (program.expiryMonths) {
    expiresOn = addMonthsClamped(await businessToday(input.orgId), program.expiryMonths);
  }
  // The document's own journal already moved the consideration at the
  // document's rate, so the account belongs to the document's entity and the
  // entry prices at that same rate — never at par.
  const doc = await loadDocumentFxContext(db, input.orgId, input.sourceDocumentId);
  if (doc.currency !== input.currency) {
    throw storedValueRefusal({
      message: `The document is in ${doc.currency}, not ${input.currency}: it cannot fund a ${input.currency} issue.`,
      code: "stored_value_document_currency_mismatch",
      remedy: `Issue in ${doc.currency}, matching the document.`,
    });
  }
  const baseCurrency = await subsidiaryBaseCurrency(db, input.orgId, doc.subsidiaryId);
  const eventRate = await resolveEventRate(db, input.orgId, input.currency, baseCurrency, doc.postingDate, doc);
  const functional = functionalMinor(input.amountMinor, eventRate.units);
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateStoredValueCode();
    const codeHash = hashStoredValueCode(input.orgId, code);
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into stored_value_accounts
        (org_id, program_id, kind, code_hash, code_last4, customer_party_id, currency,
         subsidiary_id,
         issued_minor, balance_minor, expires_on, source_document_id, liability_account_id,
         created_by, updated_by)
      values (${input.orgId}, ${program.id}, ${program.kind}, ${codeHash}, ${codeLast4(code)},
        ${input.customerPartyId ?? null}, ${input.currency},
        ${doc.subsidiaryId},
        ${input.amountMinor.toString()},
        ${input.amountMinor.toString()}, ${expiresOn}, ${input.sourceDocumentId},
        ${liabilityAccountId}, ${input.actorId ?? null}, ${input.actorId ?? null})
      on conflict (org_id, code_hash) do nothing
      returning id
    `)).rows;
    // A code collision is expected to be vanishingly rare but possible: the
    // conflict is benign, so mint a fresh code and retry rather than fail.
    if (inserted.length !== 1 || !inserted[0]) continue;
    const entry = await insertStoredValueEntry(input.orgId, {
      accountId: inserted[0].id,
      kind: "issue",
      amountMinor: input.amountMinor,
      balanceAfter: input.amountMinor,
      currency: input.currency,
      functionalAmountMinor: functional,
      fxRate: eventRate.rate,
      documentId: input.sourceDocumentId,
      documentLineId: input.sourceLineId ?? null,
      journalEntryId: input.journalEntryId,
      idempotencyKey: `stored-value:issue-entry:${input.idempotencyKey}`,
      actorId: input.actorId ?? null,
    });
    return { accountId: inserted[0].id, code, entryId: entry.entryId, journalEntryId: input.journalEntryId, replayed: entry.replayed };
  }
  throw storedValueRefusal({
    message: "The stored-value code could not be minted.",
    code: "stored_value_code_collision",
    remedy: "Retry the issuance.",
  });
}

/**
 * Expire one account: the remaining balance posts DR liability CR breakage
 * income (like breakage), the status flips to expired, and the entry records
 * the release. Only the scan calls this, after the program's expiry elapsed.
 */
export async function expireStoredValueAccount(input: {
  orgId: string;
  accountId: string;
  postingDate: string;
  idempotencyKey: string;
  actorId?: string | null;
}): Promise<{ entryId: string; journalEntryId: string | null }> {
  await requireStoredValueFeature(db, input.orgId);
  const account = await lockStoredValueAccount(input.orgId, input.accountId);
  if (account.status === "expired" || account.status === "closed") {
    const prior = (await db.execute<{ id: string }>(sql`
      select id from stored_value_entries
       where org_id = ${input.orgId} and idempotency_key = ${`stored-value:expire-entry:${input.idempotencyKey}`}
    `)).rows[0];
    if (prior) return { entryId: prior.id, journalEntryId: null };
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} is already ${account.status}.`,
      code: "stored_value_status_conflict",
      remedy: "No further action is needed.",
      status: 409,
    });
  }
  if (account.status !== "active") {
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} is ${account.status} and cannot expire.`,
      code: "stored_value_account_not_redeemable",
      remedy: "Unfreeze the account first, then let the scan expire it.",
      status: 409,
    });
  }
  const program = await loadStoredValueProgram(input.orgId, account.programId);
  if (!program.breakageIncomeAccountId) {
    throw storedValueRefusal({
      message: `The ${program.name} program expires cards but names no breakage income account.`,
      code: "stored_value_expiry_income_missing",
      remedy: "Choose the breakage income account on the program in Setup → Sales → Stored value programs.",
    });
  }
  await assertPostingAccount(db, input.orgId, program.breakageIncomeAccountId, "Breakage income account", [
    "income",
    "income_other",
  ]);
  const liabilityAccountId = account.liabilityAccountId ?? (await storedValueLiabilityControlAccount(input.orgId));
  // Expiry extinguishes the debt: there is no conversion, so the release
  // carries the balance's historical value, and no realized FX arises.
  const functionalPrior = await accountFunctionalTotal(db, input.orgId, account.id);
  const share = carryingShare(functionalPrior, account.balanceMinor, account.balanceMinor);
  let journalEntryId: string | null = null;
  if (account.balanceMinor > 0n) {
    journalEntryId = await postStoredValueJournal({
      orgId: input.orgId,
      postingDate: input.postingDate,
      subsidiaryId: account.subsidiaryId,
      memo: `Stored-value expiry — …${account.codeLast4}`,
      origin: "expire",
      idempotencyKey: `stored-value:expire:${input.idempotencyKey}`,
      accountId: liabilityAccountId,
      amount: fromUnits(share.functional),
      txnAmount: fromUnits(account.balanceMinor),
      counterAccountId: program.breakageIncomeAccountId,
      counterAmount: neg(fromUnits(share.functional)),
      counterTxnAmount: neg(fromUnits(account.balanceMinor)),
      fxRate: share.rate,
      currency: account.currency,
      partyId: account.customerPartyId,
      actorId: input.actorId ?? null,
      auditChanges: { accountId: account.id },
    });
  }
  const updated = (await db.execute<{ id: string }>(sql`
    update stored_value_accounts
       set balance_minor = '0', status = 'expired',
           last_activity_on = CURRENT_DATE,
           updated_at = now(), updated_by = ${input.actorId ?? null}
     where org_id = ${input.orgId} and id = ${account.id} and status = 'active'
       and balance_minor = ${account.balanceMinor.toString()}
    returning id
  `)).rows;
  if (updated.length !== 1) {
    throw storedValueRefusal({
      message: `Stored-value …${account.codeLast4} changed while expiring.`,
      code: "stored_value_balance_changed",
      remedy: "Let the next scan retry it.",
      status: 409,
    });
  }
  const entry = await insertStoredValueEntry(input.orgId, {
    accountId: account.id,
    kind: "expire",
    amountMinor: -account.balanceMinor,
    balanceAfter: 0n,
    currency: account.currency,
    functionalAmountMinor: -share.functional,
    fxRate: share.rate,
    journalEntryId,
    idempotencyKey: `stored-value:expire-entry:${input.idempotencyKey}`,
    actorId: input.actorId ?? null,
  });
  return { entryId: entry.entryId, journalEntryId };
}




