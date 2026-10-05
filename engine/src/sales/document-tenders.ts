import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import type { Money } from "../money/brands.ts";
import type { CashPostingTender } from "../journal/posting-contracts.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import {
  loadStoredValueProgram,
  programLiabilityAccount,
  redeemStoredValue,
  storedValueAccountOwnedByCustomer,
} from "../stored-value/accounts.ts";
import { attachDocumentLoad } from "../stored-value/document-loads.ts";
import { StoredValueError } from "../stored-value/errors.ts";

/**
 * Typed paid-at-sale tenders (`document_tenders`, migration 0494). A tender
 * is one way a cash sale's total was settled or a cash refund's total is
 * paid out: clearing/bank money, or stored value redeemed (sale) or
 * credited (refund).
 *
 * Two execution contexts, split deliberately. `read`/`replace` take the
 * caller's runner and join its unit (the document write transaction): they
 * validate and persist rows, and check stored-value balances advisorially.
 * The settle functions run on the ambient transaction like every other
 * stored-value mutation: the sale redeem runs inside the posting commit so
 * an overdrawn card rolls the journal back with it, and the refund load
 * runs as a post-commit effect beside the other document effects.
 */

export const DOCUMENT_TENDER_KINDS = [
  "cash",
  "card",
  "bank_transfer",
  "wallet",
  "gateway",
  "stored_value",
  "other",
] as const;

export type DocumentTenderKind = (typeof DOCUMENT_TENDER_KINDS)[number];

/** Tender settlement accounts: bank plus asset clearing, the picker's set. */
const TENDER_ACCOUNT_TYPES = ["asset_bank", "asset_current_other"] as const;

export type TenderRefusalCode =
  | "not_found"
  | "wrong_status"
  | "wrong_kind"
  | "feature_disabled"
  | "invalid_input"
  | "account_missing"
  | "account_invalid"
  | "stored_value_unknown"
  | "stored_value_unusable"
  | "stored_value_cross_entity"
  | "stored_value_currency_mismatch"
  | "stored_value_insufficient_balance"
  | "stored_value_wrong_customer"
  | "program_missing"
  | "conflicting_settlement"
  | "changed_concurrently";

/** A tender write refusal with the stable detail API routes return. */
export class TenderRefusal extends Error {
  readonly name = "TenderRefusal";

  constructor(
    message: string,
    readonly code: TenderRefusalCode,
    readonly status: 404 | 409 | 422,
    readonly remedy?: string,
  ) {
    super(message);
  }
}

function refusal(
  message: string,
  code: TenderRefusalCode,
  status: 404 | 409 | 422,
  remedy?: string,
): TenderRefusal {
  return new TenderRefusal(message, code, status, remedy);
}

export interface TenderInput {
  kind: string;
  methodLabel?: string | null;
  accountId?: string | null;
  storedValueAccountId?: string | null;
  /** Decimal amount string in document currency; converted to minor units. */
  amount: string;
  reference?: string | null;
  externalRef?: string | null;
}

export interface DocumentTenderRow {
  id: string;
  position: number;
  kind: string;
  methodLabel: string;
  accountId: string | null;
  storedValueAccountId: string | null;
  amountMinor: bigint;
  currency: string;
  reference: string | null;
  externalRef: string | null;
}

type TenderParent = {
  id: string;
  kind: string;
  status: string;
  currency: string;
  subsidiaryId: string | null;
  partyId: string | null;
  custom: unknown;
};

async function loadParent(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<TenderParent> {
  const rows = (await runner.execute<TenderParent>(sql`
    select id, kind, status, currency, subsidiary_id as "subsidiaryId",
           party_id as "partyId", custom
      from documents
     where org_id = ${orgId} and id = ${documentId}
     for update
  `)).rows;
  const parent = rows[0];
  if (!parent) {
    throw refusal(
      "The tendered document does not exist in this organization.",
      "not_found",
      404,
      "Reload the document list and retry.",
    );
  }
  return parent;
}

function checkParentForTenders(parent: TenderParent): void {
  if (parent.kind !== "cash_sale" && parent.kind !== "cash_refund") {
    throw refusal(
      `Tenders only settle cash sales and cash refunds; ${parent.kind} settles another way.`,
      "wrong_kind",
      422,
      "Remove the tenders from this document.",
    );
  }
  if (parent.status !== "draft") {
    throw refusal(
      `Tenders on a ${parent.status} document cannot be changed — return it to draft or correct it through a controlled document.`,
      "wrong_status",
      422,
      "Edit tenders while the document is still a draft.",
    );
  }
}

/** Read a document's tenders in position order. Empty is valid: posting refuses it. */
export async function readDocumentTenders(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<DocumentTenderRow[]> {
  const rows = (await runner.execute<{
    id: string;
    position: number;
    kind: string;
    methodLabel: string;
    accountId: string | null;
    storedValueAccountId: string | null;
    amountMinorRaw: string;
    currency: string;
    reference: string | null;
    externalRef: string | null;
  }>(sql`
    select id, position, kind, method_label as "methodLabel", account_id as "accountId",
           stored_value_account_id as "storedValueAccountId",
           amount_minor::text as "amountMinorRaw", currency, reference,
           external_ref as "externalRef"
      from document_tenders
     where org_id = ${orgId} and document_id = ${documentId}
     order by position
  `)).rows;
  return rows.map((row) => ({
    id: row.id,
    position: row.position,
    kind: row.kind,
    methodLabel: row.methodLabel,
    accountId: row.accountId,
    storedValueAccountId: row.storedValueAccountId,
    amountMinor: BigInt(row.amountMinorRaw),
    currency: row.currency,
    reference: row.reference,
    externalRef: row.externalRef,
  }));
}

type StoredValueAccountView = {
  id: string;
  programId: string;
  kind: string;
  customerPartyId: string | null;
  currency: string;
  subsidiaryId: string;
  status: string;
  codeLast4: string;
  balanceMinor: bigint;
};

/**
 * Lock every tendered stored-value account under the caller's scope. A
 * hidden account refuses exactly like a missing one — the lock, not a later
 * lifecycle check, is the visibility boundary, so no status, currency, or
 * balance of an invisible card can reach a refusal.
 */
async function lockTenderStoredValueAccounts(
  runner: SqlExecutor,
  orgId: string,
  accountIds: string[],
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<Map<string, StoredValueAccountView>> {
  const byId = new Map<string, StoredValueAccountView>();
  // Lock in id order so concurrent tender writes cannot deadlock.
  for (const accountId of [...new Set(accountIds)].sort()) {
    const rows = (await runner.execute<{
      id: string;
      programId: string;
      kind: string;
      customerPartyId: string | null;
      currency: string;
      subsidiaryId: string;
      status: string;
      codeLast4: string;
      balanceMinorRaw: string;
    }>(sql`
      select id, program_id as "programId", kind, customer_party_id as "customerPartyId",
             currency, subsidiary_id as "subsidiaryId", status,
             code_last4 as "codeLast4", balance_minor::text as "balanceMinorRaw"
        from stored_value_accounts
       where org_id = ${orgId} and id = ${accountId}
       for update
    `)).rows;
    const row = rows[0];
    if (!row || !subsidiaryScopeAllows(allowedSubsidiaryIds, row.subsidiaryId)) {
      throw refusal(
        "A tender names a stored-value account that does not exist in this organization.",
        "stored_value_unknown",
        404,
        "Look the gift card or store credit up by code, then re-enter the tender.",
      );
    }
    byId.set(row.id, {
      id: row.id,
      programId: row.programId,
      kind: row.kind,
      customerPartyId: row.customerPartyId,
      currency: row.currency,
      subsidiaryId: row.subsidiaryId,
      status: row.status,
      codeLast4: row.codeLast4,
      balanceMinor: BigInt(row.balanceMinorRaw),
    });
  }
  return byId;
}

function cleanText(value: unknown, field: string, label: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw refusal(`${label} must be text.`, "invalid_input", 422, `Enter ${field} as text, or leave it blank.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    throw refusal(
      `${label} is ${trimmed.length} characters; at most ${maxLength} fit.`,
      "invalid_input",
      422,
      `Shorten ${field} to ${maxLength} characters.`,
    );
  }
  return trimmed;
}

async function assertTenderAccount(
  runner: SqlExecutor,
  orgId: string,
  accountId: string,
  label: string,
): Promise<void> {
  const rows = (await runner.execute<{ id: string; type: string }>(sql`
    select id, type from accounts
     where org_id = ${orgId} and id = ${accountId} and is_active and not is_summary
     for key share
  `)).rows;
  const account = rows[0];
  if (!account) {
    throw refusal(
      `${label} names an account that is not an active posting account in this organization.`,
      "account_missing",
      404,
      "Pick the clearing or bank account the money moved through.",
    );
  }
  if (!(TENDER_ACCOUNT_TYPES as readonly string[]).includes(account.type)) {
    throw refusal(
      `${label} settles into a ${account.type} account; tenders settle into a bank or asset clearing account.`,
      "account_invalid",
      422,
      "Pick the bank or clearing account the money moved through — never a receivable, payable, or income account.",
    );
  }
}

/**
 * Replace a draft document's tenders. Validates every tender against the
 * parent (currency, draft status), the chart of accounts, and — for
 * stored-value tenders — the account's live balance, then swaps the rows in
 * one delete plus insert. The posting kernel cross-foots the total, and the
 * settle step re-locks every stored-value account authoritatively.
 */
export async function replaceDocumentTenders(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
  inputs: TenderInput[],
  options: { actorId?: string | null; allowedSubsidiaryIds?: ReadonlySet<string> | null },
): Promise<DocumentTenderRow[]> {
  // Authority resolves once, before any tender lock: an explicit scope wins,
  // otherwise the actor's live grants through the canonical machinery. A
  // scope-less call without an actor reads nothing — explicit null stays the
  // only unrestricted grant, named outright by documented system paths.
  let tenderScope = options.allowedSubsidiaryIds;
  if (tenderScope === undefined) {
    tenderScope = options.actorId
      ? await actorAllowedSubsidiaryIds(runner, orgId, options.actorId)
      : new Set<string>();
  }
  const parent = await loadParent(runner, orgId, documentId);
  if (!subsidiaryScopeAllows(tenderScope, parent.subsidiaryId)) {
    throw refusal(
      "The tendered document does not exist in this organization.",
      "not_found",
      404,
      "Reload the document list and retry.",
    );
  }
  checkParentForTenders(parent);
  const isSale = parent.kind === "cash_sale";
  if (inputs.length === 0) {
    throw refusal(
      `A ${parent.kind === "cash_sale" ? "cash sale" : "cash refund"} needs at least one tender — name the clearing or bank account and the amount.`,
      "invalid_input",
      422,
      "Add one tender for each way the total settled.",
    );
  }
  if (inputs.some((input) => input.kind === "stored_value")) {
    if (!(await lockAndCheckOrgFeature(runner, orgId, "storedValue"))) {
      throw refusal(
        "Stored value is turned off for this organization.",
        "feature_disabled",
        409,
        "Turn on Stored value on Company Settings → Features.",
      );
    }
  }
  const storedValueIds = inputs
    .filter((input) => input.kind === "stored_value" && typeof input.storedValueAccountId === "string")
    .map((input) => input.storedValueAccountId as string);
  const storedValueById = await lockTenderStoredValueAccounts(runner, orgId, storedValueIds, tenderScope);
  type PreparedTender = {
    kind: string;
    methodLabel: string;
    accountId: string | null;
    storedValueAccountId: string | null;
    amountMinor: bigint;
    reference: string | null;
    externalRef: string | null;
  };
  const prepared: PreparedTender[] = [];
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index]!;
    const label = `Tender ${index + 1}`;
    if (!(DOCUMENT_TENDER_KINDS as readonly string[]).includes(input.kind)) {
      throw refusal(
        `${label} kind must be one of ${DOCUMENT_TENDER_KINDS.join(", ")}.`,
        "invalid_input",
        422,
        "Pick how this part of the total settled.",
      );
    }
    const isStoredValue = input.kind === "stored_value";
    if (!isStoredValue && typeof input.accountId !== "string") {
      throw refusal(
        `${label} must name a valid clearing or bank account.`,
        "account_missing",
        422,
        "Pick the clearing or bank account the money moved through.",
      );
    }
    if (!isStoredValue) {
      await assertTenderAccount(runner, orgId, input.accountId as string, label);
    }
    if (isStoredValue && input.accountId != null) {
      throw refusal(
        `${label} names both a settlement account and stored value — a stored-value tender settles against the liability, never a bank account.`,
        "invalid_input",
        422,
        "Clear the account on a stored-value tender.",
      );
    }
    if (!isStoredValue && input.storedValueAccountId != null) {
      throw refusal(
        `${label} names stored value on a ${input.kind} tender.`,
        "invalid_input",
        422,
        "Use the stored value method for gift card and store credit tenders.",
      );
    }
    let storedValueAccount: StoredValueAccountView | null = null;
    if (isStoredValue) {
      // A sale redeems an existing balance, so the account resolves at
      // draft time. A refund may mint the credit at settle instead, leaving
      // the account for the post-commit effect to fill in.
      if (typeof input.storedValueAccountId !== "string" && isSale) {
        throw refusal(
          `${label} names no stored-value account — a sale redeems an existing balance, so resolve the gift card or store credit first.`,
          "stored_value_unknown",
          422,
          "Look the gift card or store credit up by code, then re-enter the tender.",
        );
      }
      if (typeof input.storedValueAccountId === "string") {
        storedValueAccount = storedValueById.get(input.storedValueAccountId) ?? null;
      }
    }
    let amountMinor: bigint;
    try {
      amountMinor = toUnits(input.amount);
    } catch {
      throw refusal(
        `${label} amount ${JSON.stringify(input.amount)} is not a valid amount.`,
        "invalid_input",
        422,
        `Enter ${label.toLowerCase()} as a decimal amount with at most four places.`,
      );
    }
    if (amountMinor <= 0n) {
      throw refusal(
        `${label} amount must be positive — payouts ride a cash refund, not a negative tender.`,
        "invalid_input",
        422,
        `Enter ${label.toLowerCase()} as a positive amount.`,
      );
    }
    if (storedValueAccount) {
      if (storedValueAccount.currency !== parent.currency) {
        throw refusal(
          `${label} holds ${storedValueAccount.currency}, but the document is in ${parent.currency}.`,
          "stored_value_currency_mismatch",
          422,
          `Tender in ${storedValueAccount.currency}, or choose stored value in ${parent.currency}.`,
        );
      }
      // One entity cannot relieve another's debt: the tendered account must
      // sit in the document's own entity at save time, not only at posting.
      // Both records are already proven visible above, so naming them leaks
      // nothing hidden.
      if (storedValueAccount.subsidiaryId !== parent.subsidiaryId) {
        const ids = [storedValueAccount.subsidiaryId, parent.subsidiaryId]
          .filter((id): id is string => id !== null);
        const names = await runner.execute<{ id: string; name: string }>(sql`
          select id, name from subsidiaries
           where org_id = ${orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])`);
        const byId = new Map(names.rows.map((row) => [row.id, row.name]));
        const accountSub = byId.get(storedValueAccount.subsidiaryId) ?? storedValueAccount.subsidiaryId;
        const docSub = (parent.subsidiaryId && byId.get(parent.subsidiaryId)) ?? parent.subsidiaryId ?? "no legal entity";
        throw refusal(
          `${label} stored value …${storedValueAccount.codeLast4} belongs to ${accountSub}, but the document posts to ${docSub}: one entity cannot relieve another's debt.`,
          "stored_value_cross_entity",
          409,
          `Tender …${storedValueAccount.codeLast4} on a ${accountSub} document.`,
        );
      }
      if (storedValueAccount.status !== "active") {
        throw refusal(
          `${label} stored value …${storedValueAccount.codeLast4} is ${storedValueAccount.status} and cannot be tendered.`,
          "stored_value_unusable",
          409,
          storedValueAccount.status === "frozen"
            ? "Unfreeze the account from the Stored value list before tendering it."
            : "Issue a new code instead.",
        );
      }
      if (isSale && amountMinor > storedValueAccount.balanceMinor) {
        throw refusal(
          `${label} stored value …${storedValueAccount.codeLast4} holds ${fromUnits(storedValueAccount.balanceMinor)}, which is less than the tendered ${fromUnits(amountMinor)}.`,
          "stored_value_insufficient_balance",
          409,
          `Tender at most ${fromUnits(storedValueAccount.balanceMinor)}, or split the total across another payment method.`,
        );
      }
      if (!storedValueAccountOwnedByCustomer(storedValueAccount, parent.partyId)) {
        throw refusal(
          `${label} stored value …${storedValueAccount.codeLast4} belongs to another customer — tender the same customer's account or a bearer gift card.`,
          "stored_value_wrong_customer",
          409,
          "Tender a gift card or store credit issued to this document's customer instead.",
        );
      }
    }
    const methodLabel =
      cleanText(input.methodLabel, "method label", `${label} method label`, 120) ?? input.kind;
    prepared.push({
      kind: input.kind,
      methodLabel,
      accountId: isStoredValue ? null : (input.accountId as string),
      storedValueAccountId: storedValueAccount ? storedValueAccount.id : null,
      amountMinor,
      reference: cleanText(input.reference, "reference", `${label} reference`, 120),
      externalRef: cleanText(input.externalRef, "external reference", `${label} external reference`, 120),
    });
  }
  await runner.execute(sql`
    delete from document_tenders where org_id = ${orgId} and document_id = ${documentId}
  `);
  for (let index = 0; index < prepared.length; index++) {
    const tender = prepared[index]!;
    const inserted = (await runner.execute<{ id: string }>(sql`
      insert into document_tenders
        (org_id, document_id, position, kind, method_label, account_id,
         stored_value_account_id, amount_minor, currency, reference, external_ref,
         created_by, updated_by)
      values (${orgId}, ${documentId}, ${index + 1}, ${tender.kind}, ${tender.methodLabel},
        ${tender.accountId}, ${tender.storedValueAccountId}, ${tender.amountMinor.toString()},
        ${parent.currency}, ${tender.reference}, ${tender.externalRef},
        ${options.actorId ?? null}, ${options.actorId ?? null})
      returning id
    `)).rows;
    if (inserted.length !== 1 || !inserted[0]) {
      throw refusal(
        `${parent.kind === "cash_sale" ? "Cash sale" : "Cash refund"} tenders could not be saved.`,
        "changed_concurrently",
        409,
        "Reload the document and re-enter the tenders.",
      );
    }
  }
  return readDocumentTenders(runner, orgId, documentId);
}

type PostingTenderParent = {
  documentNumber: string;
  kindLabel: string;
  partyId: string | null;
  custom: unknown;
};

/**
 * Resolve tenders for the posting kernel: rows plus the current liability
 * account behind every stored-value tender. Reads only — safe for replay
 * and regeneration, which re-project history without moving money or
 * refusing on balances the settle step already spent.
 */
export async function resolveCashPostingTenders(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
  parent: PostingTenderParent,
): Promise<CashPostingTender[]> {
  const rows = await readDocumentTenders(runner, orgId, documentId);
  const resolved: CashPostingTender[] = [];
  for (const row of rows) {
    if (row.kind !== "stored_value") {
      resolved.push({
        kind: row.kind,
        methodLabel: row.methodLabel,
        accountId: row.accountId as string,
        amount: fromUnits(row.amountMinor) as Money,
        reference: row.reference,
        storedValueAccountId: null,
      });
      continue;
    }
    if (!row.storedValueAccountId) {
      // A refund tender without an account mints from the memo's program at
      // settle; its journal leg credits that program's liability now. A sale
      // tender without an account should never reach posting — the writer
      // resolves every redemption at draft — so refuse it by name.
      const custom = (parent.custom ?? {}) as { storeCreditProgramId?: unknown };
      const programId =
        typeof custom.storeCreditProgramId === "string" && custom.storeCreditProgramId
          ? custom.storeCreditProgramId
          : null;
      if (!programId) {
        throw new TenderRefusal(
          `${parent.kindLabel} ${parent.documentNumber} tender ${row.position} is a stored-value tender with no resolved account.`,
          "stored_value_unknown",
          422,
          "Resolve the gift card or store credit on the tender before posting.",
        );
      }
      const program = await loadStoredValueProgram(orgId, programId, runner);
      if (program.kind !== "store_credit" || !program.isActive) {
        throw new TenderRefusal(
          `${parent.kindLabel} ${parent.documentNumber} names the ${program.name} program, which cannot issue store credit.`,
          "program_missing",
          422,
          "Choose an active store credit program on the refund, then repost it.",
        );
      }
      const liabilityAccountId = await programLiabilityAccount(orgId, program, runner);
      resolved.push({
        kind: row.kind,
        methodLabel: row.methodLabel,
        accountId: liabilityAccountId,
        amount: fromUnits(row.amountMinor) as Money,
        reference: row.reference,
        storedValueAccountId: null,
      });
      continue;
    }
    const accounts = (await runner.execute<{ program_id: string; kind: string; customerPartyId: string | null }>(sql`
      select program_id as program_id, kind, customer_party_id as "customerPartyId" from stored_value_accounts
       where org_id = ${orgId} and id = ${row.storedValueAccountId}
    `)).rows;
    const programId = accounts[0]?.program_id;
    if (!programId || !accounts[0]) {
      throw new TenderRefusal(
        `${parent.kindLabel} ${parent.documentNumber} tender ${row.position} names a stored-value account that no longer exists.`,
        "stored_value_unknown",
        409,
        "Replace the tender with a live gift card or store credit, then repost.",
      );
    }
    if (!storedValueAccountOwnedByCustomer(accounts[0], parent.partyId)) {
      throw new TenderRefusal(
        `${parent.kindLabel} ${parent.documentNumber} tender ${row.position} names stored value of another customer — tender the same customer's account or a bearer gift card.`,
        "stored_value_wrong_customer",
        409,
        "Tender a gift card or store credit issued to this document's customer instead.",
      );
    }
    const program = await loadStoredValueProgram(orgId, programId, runner);
    const liabilityAccountId = await programLiabilityAccount(orgId, program, runner);
    resolved.push({
      kind: row.kind,
      methodLabel: row.methodLabel,
      accountId: liabilityAccountId,
      amount: fromUnits(row.amountMinor) as Money,
      reference: row.reference,
      storedValueAccountId: row.storedValueAccountId,
    });
  }
  return resolved;
}

/**
 * Redeem a posted cash sale's stored-value tenders inside the posting
 * commit: the journal already debited the liability, so this moves the
 * subledger against that entry. An overdrawn card throws here and the whole
 * unit — journal included — rolls back, so a sale never posts money the
 * till never received.
 */
export async function redeemCashSaleTenders(
  orgId: string,
  documentId: string,
  options: { journalEntryId: string; actorId?: string | null },
): Promise<{ redeemed: number }> {
  const rows = await readDocumentTenders(db, orgId, documentId);
  let redeemed = 0;
  for (const row of rows.filter((tender) => tender.kind === "stored_value")) {
    try {
      await redeemStoredValue({
        orgId,
        accountId: row.storedValueAccountId as string,
        // Posting-commit step on the already-gated sale: explicit null is
        // the unrestricted grant named outright; same-entity is refused by name.
        allowedSubsidiaryIds: null,
        amountMinor: row.amountMinor,
        documentId,
        journalEntryId: options.journalEntryId,
        idempotencyKey: `cash-tender:${documentId}:${row.id}`,
        actorId: options.actorId ?? null,
      });
    } catch (error) {
      if (error instanceof StoredValueError) {
        throw new TenderRefusal(
          error.message,
          error.code === "stored_value_insufficient_balance"
            ? "stored_value_insufficient_balance"
            : "stored_value_unusable",
          409,
          error.remedy,
        );
      }
      throw error;
    }
    redeemed += 1;
  }
  return { redeemed };
}

/** True when the document carries stored-value tenders for the settle step. */
export async function hasStoredValueTenders(
  runner: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<boolean> {
  const rows = (await runner.execute<{ n: number }>(sql`
    select count(*)::int as n from document_tenders
     where org_id = ${orgId} and document_id = ${documentId} and kind = 'stored_value'
  `)).rows;
  return (rows[0]?.n ?? 0) > 0;
}

/**
 * Settle a posted cash refund's stored-value tenders as a post-commit
 * effect: top up the named account, or mint one from the memo's
 * store-credit program when the customer has none yet, and record a minted
 * account back on its tender row. The memo-level credit effect stands down
 * while tenders exist (see the dispatch guard), so the credit issues once.
 */
export async function settleCashRefundTenders(
  orgId: string,
  documentId: string,
  options: { journalEntryId: string; actorId?: string | null },
): Promise<{ settled: number }> {
  const parent = (await db.execute<{
    kind: string;
    status: string;
    partyId: string | null;
    custom: unknown;
  }>(sql`
    select kind, status, party_id as "partyId", custom from documents
     where org_id = ${orgId} and id = ${documentId}
  `)).rows[0];
  if (!parent || parent.kind !== "cash_refund") {
    return { settled: 0 };
  }
  // The settle effect moves customer value, so it runs only for a posted
  // refund: minting or topping up from a draft (or a voided refund) would
  // create spendable value with no posted liability behind it.
  if (parent.status !== "posted") {
    throw new TenderRefusal(
      `Cash refund ${documentId} is ${parent.status} — store credit settles only once the refund is posted.`,
      "wrong_status",
      409,
      "Post the refund; the settle effect then records the store credit.",
    );
  }
  const rows = (await readDocumentTenders(db, orgId, documentId)).filter(
    (tender) => tender.kind === "stored_value",
  );
  if (rows.length === 0) return { settled: 0 };
  const custom = (parent.custom ?? {}) as { storeCreditProgramId?: unknown };
  const programId =
    typeof custom.storeCreditProgramId === "string" && custom.storeCreditProgramId
      ? custom.storeCreditProgramId
      : null;
  let settled = 0;
  for (const row of rows) {
    if (!row.storedValueAccountId && !programId) {
      throw new TenderRefusal(
        `Cash refund tender ${row.position} is stored value with no account and no program to mint from.`,
        "program_missing",
        422,
        "Name the customer's store credit account on the tender, or set the store credit program on the refund.",
      );
    }
    let loaded: Awaited<ReturnType<typeof attachDocumentLoad>>;
    try {
      loaded = await attachDocumentLoad({
        orgId,
        // Posting-commit step on the already-gated refund: explicit null is
        // the unrestricted grant named outright; the top-up asserts the entity.
        allowedSubsidiaryIds: null,
        accountId: row.storedValueAccountId,
        programId: row.storedValueAccountId ? null : programId,
        customerPartyId: parent.partyId,
        amountMinor: row.amountMinor,
        currency: row.currency,
        documentId,
        journalEntryId: options.journalEntryId,
        idempotencyKey: `cash-refund-tender:${documentId}:${row.id}`,
        actorId: options.actorId ?? null,
      });
    } catch (error) {
      if (error instanceof StoredValueError && error.code === "stored_value_customer_mismatch") {
        throw new TenderRefusal(
          `Cash refund tender ${row.position} names stored value …${row.storedValueAccountId} of another customer — tender the same customer's account or a bearer gift card.`,
          "stored_value_wrong_customer",
          409,
          error.remedy,
        );
      }
      throw error;
    }
    if (!row.storedValueAccountId) {
      // Mint-fill: the only post-commit tender write the lifecycle guard
      // permits. A replayed load still fills a tender the first run never
      // recorded (a crash between the entry and this write); the row count
      // turns a raced or reordered write into a refusal instead of silent
      // success.
      const filled = (await db.execute<{ id: string }>(sql`
        update document_tenders
           set stored_value_account_id = ${loaded.accountId}, updated_at = now(),
               updated_by = ${options.actorId ?? null}
         where org_id = ${orgId} and id = ${row.id} and stored_value_account_id is null
        returning id
      `)).rows;
      if (filled.length !== 1) {
        const reread = (await readDocumentTenders(db, orgId, documentId)).find(
          (tender) => tender.id === row.id,
        );
        if (!reread?.storedValueAccountId) {
          throw new TenderRefusal(
            "The refund's store-credit account could not be recorded on its tender.",
            "changed_concurrently",
            409,
            "Retry the posting effect from the posted document.",
          );
        }
      }
    }
    settled += 1;
  }
  return { settled };
}
