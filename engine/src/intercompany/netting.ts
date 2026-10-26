import { routeSubjectSubmission } from "../flows/submission-policy.ts";
import { excludePeriodEndJournals } from "../records/period-end-origins.ts";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { fromUnits, neg, normalizeDecimal, toUnits } from "../money/money.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import {
  loadSubsidiaryContext,
  SubsidiaryError,
  uuidArray,
  validateSubsidiaryRestrictions,
} from "../organization/subsidiaries.ts";
import {
  intercompanySideAccounts,
  loadActiveIntercompanyPairs,
  type IntercompanyPairRow,
} from "../organization/intercompany-accounts.ts";
import { postEntry, type PostEntryLineInput, type PostEntryResult } from "../journal/post-entry.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { loadControlAccountsForRoles } from "../records/control-accounts.ts";

import { cancelDispatchRuns, dispatchFailureReason } from "../flows/dispatch-result.ts";
import { completedGateAllowsSelfApproval } from "../flows/approval-decision-policy.ts";
import { INTERCOMPANY_NETTING_RUN_SUBJECT_KIND } from "../flows/intercompany-netting-runs-adapter.ts";
import {
  auditIntercompany,
  IntercompanyError,
  INTERCOMPANY_NETTING_DISABLED,
  requireOneRow,
  requireIntercompanyPermission,
} from "./errors.ts";
import {
  allocatePairNetting,
  carryingForSettlement,
  carryingRateLines,
  NettingMathError,
  spotTranslation,
  type NettingAllocation,
  type NettingComponent,
  type NettingPairResult,
} from "./netting-math.ts";
import {
  assertIntercompanyPeriodsOpen,
  intercompanyPostingBook,
  intercompanyPostingPeriod,
  intercompanyPostingRefusal,
  postMirrorReversal,
  resolveSpotRates,
} from "./ledger-support.ts";

/**
 * Intercompany netting and settlement runs.
 *
 * A run settles the open intercompany balances of a set of subsidiaries as
 * of a date. Proposing computes, for every active intercompany pair inside
 * the set and every currency, each entity's open intercompany receivables and
 * payables (open items in the pair's intercompany control accounts) and its
 * due-to/due-from position, then allocates netting inside each entity and,
 * when requested, a cash settlement between the entities' bank accounts. The
 * proposal is stored with a fingerprint and is what gets approved and posted:
 * posting re-reads every balance and refuses if any changed since the
 * proposal, so an approved run can never settle a different amount.
 *
 * Approval is a Flows gate: submitting fires `on_submit`, and with no gating
 * flow the run is approved at once. Posting writes one balanced entry per
 * pair and currency through the posting kernel (each entity balances on its
 * own), applies every cleared open item through application records so aging
 * and reconciliation show it settled, and books the realized exchange
 * difference in each entity's functional currency. Reversal posts governed
 * mirrors and reopens the items.
 */

export const NETTING_FEATURE = "intercompanyNetting";
const NUMBER_KIND = "intercompany_netting";
const NUMBER_PREFIX = "ICN-";

export type NettingRunStatus =
  "proposed" | "pending_approval" | "approved" | "rejected" | "posted" | "cancelled" | "reversed";

export interface ProposeNettingInput {
  asOfDate: string;
  subsidiaryIds: string[];
  settleCash: boolean;
  /** For cash settlement: the bank account per entity and currency. */
  bankAccounts?: Record<string, Record<string, string>>;
  reason: string;
  idempotencyKey?: string | null;
}

export interface NettingPairSummary {
  pairId: string;
  currency: string;
  fromSubsidiaryId: string;
  toSubsidiaryId: string;
  fromNet: string;
  toNet: string;
  unreconciled: string;
  fromNetted: string;
  toNetted: string;
  cashToFrom: string;
}

export interface NettingComputation {
  version: 1;
  asOfDate: string;
  bookId: string;
  periodId: string;
  settleCash: boolean;
  subsidiaryIds: string[];
  rates: Record<string, string>;
  pairs: NettingPairSummary[];
  warnings: string[];
}

export interface NettingRunLine {
  lineNumber: number;
  pairId: string;
  currency: string;
  subsidiaryId: string;
  counterpartySubsidiaryId: string;
  component: "open_item" | "due_position" | "cash";
  accountId: string;
  journalLineId: string | null;
  documentId: string | null;
  partyId: string | null;
  functionalCurrency: string;
  openTransaction: string;
  openCarrying: string;
  netted: string;
  cash: string;
  rate: string;
  realizedFx: string;
  carryingCleared: string;
  spotCleared: string;
}

export interface NettingRunDetail {
  id: string;
  runNumber: string;
  status: NettingRunStatus;
  asOfDate: string;
  subsidiaryIds: string[];
  settleCash: boolean;
  reason: string;
  fingerprint: string;
  computation: NettingComputation;
  lines: (NettingRunLine & {
    subsidiaryName: string;
    counterpartySubsidiaryName: string;
    accountLabel: string;
    documentNumber: string | null;
    documentKind: string | null;
    settlementEntryId: string | null;
  })[];
  flowRunId: string | null;
  proposedBy: string;
  proposedAt: string;
  submittedBy: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  postedBy: string | null;
  postedAt: string | null;
  cancelReason: string | null;
  reverseReason: string | null;
  reversalDate: string | null;
  entryIds: string[];
}

function refuse(
  message: string,
  status: 404 | 409 | 422 = 422,
  details?: Record<string, unknown>,
): never {
  throw new IntercompanyError(message, status, details);
}

function cleanReason(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) refuse(`${label} is required`);
  const trimmed = value.trim();
  if (trimmed.length > 2000) refuse(`${label} must be at most 2000 characters`);
  return trimmed;
}

function scopeCovers(allowed: ReadonlySet<string> | null, ids: readonly string[]): boolean {
  return allowed === null || ids.every((id) => allowed.has(id));
}

async function assertNettingEnabled(runner: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(runner, orgId, NETTING_FEATURE)))
    refuse(INTERCOMPANY_NETTING_DISABLED);
}

/** One netting proposal or posting at a time per organization. */
async function lockNetting(runner: SqlExecutor, orgId: string): Promise<void> {
  await runner.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`intercompany-netting:${orgId}`}, 0))`,
  );
}

interface LoadedScope {
  pairs: { pair: IntercompanyPairRow; from: string; to: string }[];
  functional: Map<string, string>;
  names: Map<string, string>;
}

async function loadScope(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryIds: string[],
): Promise<LoadedScope> {
  const subs = await runner.execute<{
    id: string;
    name: string;
    base_currency: string;
    is_active: boolean;
    is_elimination: boolean;
  }>(
    sql`
    select id, name, base_currency, is_active, is_elimination from subsidiaries
     where org_id = ${orgId} and id = any(${uuidArray(subsidiaryIds)}::uuid[])`,
    "objects",
  );
  if (subs.length !== subsidiaryIds.length)
    refuse("a chosen subsidiary does not exist in this organization", 404);
  const inactive = subs.filter((sub) => !sub.is_active || sub.is_elimination);
  if (inactive.length > 0) {
    refuse(
      `netting runs settle active operating subsidiaries; remove ${inactive.map((sub) => sub.name).join(", ")}`,
    );
  }
  const chosen = new Set(subsidiaryIds);
  const allPairs = await loadActiveIntercompanyPairs(runner, orgId);
  const pairs = allPairs
    .filter((pair) => chosen.has(pair.fromSubsidiaryId) && chosen.has(pair.toSubsidiaryId))
    .map((pair) => ({ pair, from: pair.fromSubsidiaryId, to: pair.toSubsidiaryId }));
  if (pairs.length === 0) {
    refuse(
      "no active intercompany pair joins the chosen subsidiaries; configure pairs under Setup → Accounting → Intercompany pairs",
    );
  }
  // Balances are attributed to a pair by account. An account that also
  // serves another active pair of the same entity cannot say which
  // counterparty a balance belongs to, so netting refuses it by name.
  const accountsBySide = new Map<string, Set<string>>();
  const conflicts: string[] = [];
  for (const pair of allPairs) {
    for (const subsidiaryId of [pair.fromSubsidiaryId, pair.toSubsidiaryId]) {
      const side = intercompanySideAccounts(pair, subsidiaryId)!;
      for (const accountId of [
        side.positionAccountId,
        side.receivableAccountId,
        side.payableAccountId,
      ]) {
        if (!accountId) continue;
        const key = `${subsidiaryId}:${accountId}`;
        const owners = accountsBySide.get(key) ?? new Set<string>();
        owners.add(pair.id);
        accountsBySide.set(key, owners);
      }
    }
  }
  const names = new Map(subs.map((sub) => [sub.id, sub.name]));
  for (const { pair } of pairs) {
    for (const subsidiaryId of [pair.fromSubsidiaryId, pair.toSubsidiaryId]) {
      const side = intercompanySideAccounts(pair, subsidiaryId)!;
      for (const accountId of [
        side.positionAccountId,
        side.receivableAccountId,
        side.payableAccountId,
      ]) {
        if (accountId && (accountsBySide.get(`${subsidiaryId}:${accountId}`)?.size ?? 0) > 1) {
          conflicts.push(
            `${names.get(subsidiaryId) ?? subsidiaryId} uses one intercompany account for several counterparties`,
          );
        }
      }
    }
  }
  if (conflicts.length > 0) {
    refuse(
      `${[...new Set(conflicts)].join("; ")} — give each intercompany pair its own accounts under Setup → Accounting → Intercompany pairs`,
    );
  }
  return {
    pairs,
    functional: new Map(subs.map((sub) => [sub.id, sub.base_currency])),
    names,
  };
}

type OpenItemRow = {
  id: string;
  subsidiary_id: string;
  account_id: string;
  party_id: string | null;
  currency: string;
  txn_amount: string;
  amount: string;
  posting_date: string;
  due_date: string;
  document_id: string | null;
  open_txn: string;
  open_base: string;
};

async function loadOpenItems(
  runner: SqlExecutor,
  input: {
    orgId: string;
    bookId: string;
    asOfDate: string;
    keys: { subsidiaryId: string; accountId: string }[];
    lineIds?: string[];
    lock?: boolean;
  },
): Promise<OpenItemRow[]> {
  if (input.keys.length === 0 && !input.lineIds?.length) return [];
  const subs = input.keys.map((key) => key.subsidiaryId);
  const accounts = input.keys.map((key) => key.accountId);
  return await runner.execute<OpenItemRow>(
    sql`
    select jl.id, jl.subsidiary_id, jl.account_id, jl.party_id, jl.currency,
           jl.txn_amount::text as txn_amount, jl.amount::text as amount,
           je.posting_date::text as posting_date,
           coalesce(jl.due_date, je.posting_date)::text as due_date,
           je.source_document_id as document_id,
           (abs(jl.txn_amount) - coalesce(applied.txn, 0))::text as open_txn,
           (abs(jl.amount) - coalesce(applied.base, 0))::text as open_base
      from journal_lines jl
      join journal_entries je
        on je.org_id = jl.org_id and je.id = jl.entry_id
       and je.status = 'posted' and je.book_id = ${input.bookId} -- Live entries only: only current open items authorize settlement; position totals retain reversal history.
      left join lateral (
        select sum(case when a.to_line_id = jl.id then a.target_transaction_amount else a.source_transaction_amount end) as txn,
               sum(case when a.to_line_id = jl.id then a.amount else a.source_amount end) as base
          from applications a
         where a.org_id = jl.org_id and a.unapplied_at is null
           and (a.to_line_id = jl.id or a.from_line_id = jl.id)
      ) applied on true
     where jl.org_id = ${input.orgId} and jl.is_open_item
       and je.posting_date <= ${input.asOfDate}
       and ${
         input.lineIds
           ? sql`jl.id = any(${uuidArray(input.lineIds)}::uuid[])`
           : sql`exists (
             select 1 from unnest(${uuidArray(subs)}::uuid[], ${uuidArray(accounts)}::uuid[]) as k(sub, acct)
              where k.sub = jl.subsidiary_id and k.acct = jl.account_id)
           and abs(jl.txn_amount) - coalesce(applied.txn, 0) > 0`
       }
     order by jl.id
     ${input.lock ? sql`for update of jl` : sql``}`,
    "objects",
  );
}

type PositionRow = {
  subsidiary_id: string;
  account_id: string;
  currency: string;
  txn: string;
  base: string;
};

async function loadPositions(
  runner: SqlExecutor,
  input: {
    orgId: string;
    bookId: string;
    asOfDate: string;
    keys: { subsidiaryId: string; accountId: string }[];
  },
): Promise<PositionRow[]> {
  if (input.keys.length === 0) return [];
  const subs = input.keys.map((key) => key.subsidiaryId);
  const accounts = input.keys.map((key) => key.accountId);
  // The same position definition FX revaluation measures: revaluation and
  // settlement exchange entries carry no transaction-currency exposure.
  return await runner.execute<PositionRow>(
    sql`
    select jl.subsidiary_id, jl.account_id, jl.currency,
           sum(jl.txn_amount)::text as txn, sum(jl.amount)::text as base
      from journal_lines jl
      join journal_entries je
        on je.org_id = jl.org_id and je.id = jl.entry_id
       and je.status in ('posted', 'reversed') and je.book_id = ${input.bookId}
     where jl.org_id = ${input.orgId}
       and je.posting_date <= ${input.asOfDate}
       and je.origin not in ('fx_revaluation', 'fx_settlement')
       and ${excludePeriodEndJournals(sql`je.origin`)}
       and exists (
         select 1 from unnest(${uuidArray(subs)}::uuid[], ${uuidArray(accounts)}::uuid[]) as k(sub, acct)
          where k.sub = jl.subsidiary_id and k.acct = jl.account_id)
     group by jl.subsidiary_id, jl.account_id, jl.currency
    having sum(jl.txn_amount) <> 0
     order by jl.subsidiary_id, jl.account_id, jl.currency`,
    "objects",
  );
}

function signedOpen(total: string, open: string): string {
  return toUnits(total) < 0n ? neg(open) : fromUnits(toUnits(open));
}

interface ComputedRun {
  computation: NettingComputation;
  lines: NettingRunLine[];
  results: NettingPairResult[];
}

/**
 * Compute a netting proposal without writing it. Shared by preview and
 * proposal so the operator approves exactly what was previewed.
 */
async function computeNetting(
  runner: SqlExecutor,
  orgId: string,
  input: ProposeNettingInput,
): Promise<ComputedRun> {
  const subsidiaryIds = [...new Set(input.subsidiaryIds)].sort();
  const scope = await loadScope(runner, orgId, subsidiaryIds);
  const bookId = await intercompanyPostingBook(runner, orgId);
  const periodId = await intercompanyPostingPeriod(
    runner,
    orgId,
    input.asOfDate,
    subsidiaryIds[0]!,
  );

  const openKeys: {
    subsidiaryId: string;
    accountId: string;
    pairId: string;
    counterparty: string;
  }[] = [];
  const positionKeys: {
    subsidiaryId: string;
    accountId: string;
    pairId: string;
    counterparty: string;
  }[] = [];
  const missingControls: string[] = [];
  for (const { pair } of scope.pairs) {
    for (const subsidiaryId of [pair.fromSubsidiaryId, pair.toSubsidiaryId]) {
      const side = intercompanySideAccounts(pair, subsidiaryId)!;
      positionKeys.push({
        subsidiaryId,
        accountId: side.positionAccountId,
        pairId: pair.id,
        counterparty: side.counterpartySubsidiaryId,
      });
      for (const accountId of [side.receivableAccountId, side.payableAccountId]) {
        if (accountId)
          openKeys.push({
            subsidiaryId,
            accountId,
            pairId: pair.id,
            counterparty: side.counterpartySubsidiaryId,
          });
      }
      if (!side.receivableAccountId || !side.payableAccountId)
        missingControls.push(scope.names.get(subsidiaryId) ?? subsidiaryId);
    }
  }
  const keyOf = (subsidiaryId: string, accountId: string) => `${subsidiaryId}:${accountId}`;
  const openPair = new Map(openKeys.map((key) => [keyOf(key.subsidiaryId, key.accountId), key]));
  const positionPair = new Map(
    positionKeys.map((key) => [keyOf(key.subsidiaryId, key.accountId), key]),
  );

  const components: NettingComponent[] = [];
  for (const row of await loadOpenItems(runner, {
    orgId,
    bookId,
    asOfDate: input.asOfDate,
    keys: openKeys,
  })) {
    const key = openPair.get(keyOf(row.subsidiary_id, row.account_id))!;
    components.push({
      key: row.id,
      pairId: key.pairId,
      subsidiaryId: row.subsidiary_id,
      counterpartySubsidiaryId: key.counterparty,
      currency: row.currency,
      functionalCurrency: scope.functional.get(row.subsidiary_id)!,
      component: "open_item",
      accountId: row.account_id,
      journalLineId: row.id,
      documentId: row.document_id,
      partyId: row.party_id,
      openTransaction: signedOpen(row.txn_amount, row.open_txn),
      openCarrying: signedOpen(row.amount, row.open_base),
      sortKey: `${row.due_date}|${row.posting_date}`,
    });
  }
  for (const row of await loadPositions(runner, {
    orgId,
    bookId,
    asOfDate: input.asOfDate,
    keys: positionKeys,
  })) {
    const key = positionPair.get(keyOf(row.subsidiary_id, row.account_id))!;
    components.push({
      key: `position:${row.subsidiary_id}:${row.account_id}:${row.currency}`,
      pairId: key.pairId,
      subsidiaryId: row.subsidiary_id,
      counterpartySubsidiaryId: key.counterparty,
      currency: row.currency,
      functionalCurrency: scope.functional.get(row.subsidiary_id)!,
      component: "due_position",
      accountId: row.account_id,
      journalLineId: null,
      documentId: null,
      partyId: null,
      openTransaction: fromUnits(toUnits(row.txn)),
      openCarrying: fromUnits(toUnits(row.base)),
      sortKey: "~",
    });
  }

  const rateNeeds = components.map((component) => ({
    from: component.currency,
    to: component.functionalCurrency,
  }));
  const rates = await resolveSpotRates(runner, orgId, input.asOfDate, rateNeeds);
  const rateFor = (currency: string, subsidiaryId: string) =>
    normalizeDecimal(rates.get(`${currency}>${scope.functional.get(subsidiaryId)}`)!, 10);

  const results: NettingPairResult[] = [];
  const warnings: string[] = [];
  if (missingControls.length > 0) {
    warnings.push(
      `intercompany receivable or payable accounts are not set for ${[...new Set(missingControls)].join(", ")}; their open invoices and bills are not included`,
    );
  }
  for (const { pair } of scope.pairs) {
    const currencies = [
      ...new Set(components.filter((c) => c.pairId === pair.id).map((c) => c.currency)),
    ].sort();
    for (const currency of currencies) {
      try {
        results.push(
          allocatePairNetting({
            pairId: pair.id,
            currency,
            fromSubsidiaryId: pair.fromSubsidiaryId,
            toSubsidiaryId: pair.toSubsidiaryId,
            components: components.filter((c) => c.pairId === pair.id && c.currency === currency),
            settleCash: input.settleCash,
            rateFor: (subsidiaryId) => rateFor(currency, subsidiaryId),
          }),
        );
      } catch (error) {
        if (error instanceof NettingMathError) refuse(error.message);
        throw error;
      }
    }
  }
  for (const result of results) {
    if (toUnits(result.unreconciled) !== 0n) {
      warnings.push(
        `${scope.names.get(result.fromSubsidiaryId)} and ${scope.names.get(result.toSubsidiaryId)} disagree by ${result.unreconciled} ${result.currency}; the difference stays open until both entities record it`,
      );
    }
  }

  const lines: NettingRunLine[] = [];
  let lineNumber = 0;
  const bankFor = (subsidiaryId: string, currency: string) =>
    input.bankAccounts?.[subsidiaryId]?.[currency] ?? null;
  const missingBanks: string[] = [];
  for (const result of results) {
    for (const allocation of result.allocations) {
      if (toUnits(allocation.netted) === 0n && toUnits(allocation.cash) === 0n) continue;
      lines.push(allocationLine(++lineNumber, allocation));
    }
    const cash = toUnits(result.cashToFrom);
    if (cash === 0n) continue;
    for (const [subsidiaryId, counterparty, signed] of [
      [result.fromSubsidiaryId, result.toSubsidiaryId, cash],
      [result.toSubsidiaryId, result.fromSubsidiaryId, -cash],
    ] as const) {
      const bank = bankFor(subsidiaryId, result.currency);
      if (!bank) {
        missingBanks.push(`${scope.names.get(subsidiaryId)} (${result.currency})`);
        continue;
      }
      const rate = rateFor(result.currency, subsidiaryId);
      const amount = fromUnits(signed);
      lines.push({
        lineNumber: ++lineNumber,
        pairId: result.pairId,
        currency: result.currency,
        subsidiaryId,
        counterpartySubsidiaryId: counterparty,
        component: "cash",
        accountId: bank,
        journalLineId: null,
        documentId: null,
        partyId: null,
        functionalCurrency: scope.functional.get(subsidiaryId)!,
        openTransaction: "0.0000",
        openCarrying: "0.0000",
        netted: "0.0000",
        cash: amount,
        rate,
        realizedFx: "0.0000",
        carryingCleared: "0.0000",
        spotCleared: spotTranslation(amount, rate),
      });
    }
  }
  if (missingBanks.length > 0) {
    refuse(
      `cash settlement needs a bank account for ${missingBanks.join(", ")}; choose one for each entity and currency`,
      422,
      {
        missingBankAccounts: missingBanks,
      },
    );
  }
  await assertBankAccounts(runner, orgId, lines);

  const usedRates: Record<string, string> = {};
  for (const line of lines) usedRates[`${line.subsidiaryId}:${line.currency}`] = line.rate;
  const computation: NettingComputation = {
    version: 1,
    asOfDate: input.asOfDate,
    bookId,
    periodId,
    settleCash: input.settleCash,
    subsidiaryIds,
    rates: usedRates,
    pairs: results.map((result) => ({
      pairId: result.pairId,
      currency: result.currency,
      fromSubsidiaryId: result.fromSubsidiaryId,
      toSubsidiaryId: result.toSubsidiaryId,
      fromNet: result.fromNet,
      toNet: result.toNet,
      unreconciled: result.unreconciled,
      fromNetted: result.fromNetted,
      toNetted: result.toNetted,
      cashToFrom: result.cashToFrom,
    })),
    warnings,
  };
  return { computation, lines, results };
}

function allocationLine(lineNumber: number, allocation: NettingAllocation): NettingRunLine {
  return {
    lineNumber,
    pairId: allocation.pairId,
    currency: allocation.currency,
    subsidiaryId: allocation.subsidiaryId,
    counterpartySubsidiaryId: allocation.counterpartySubsidiaryId,
    component: allocation.component,
    accountId: allocation.accountId,
    journalLineId: allocation.journalLineId,
    documentId: allocation.documentId,
    partyId: allocation.partyId,
    functionalCurrency: allocation.functionalCurrency,
    openTransaction: allocation.openTransaction,
    openCarrying: allocation.openCarrying,
    netted: allocation.netted,
    cash: allocation.cash,
    rate: allocation.rate,
    realizedFx: allocation.realizedFx,
    carryingCleared: allocation.carryingCleared,
    spotCleared: allocation.spotCleared,
  };
}

async function assertBankAccounts(
  runner: SqlExecutor,
  orgId: string,
  lines: NettingRunLine[],
): Promise<void> {
  const banks = lines.filter((line) => line.component === "cash");
  if (banks.length === 0) return;
  const ids = [...new Set(banks.map((line) => line.accountId))];
  for (const id of ids) if (!isUuid(id)) refuse("a chosen bank account is not a valid reference");
  const rows = await runner.execute<{
    id: string;
    name: string;
    type: string;
    is_active: boolean;
    is_summary: boolean;
    currency_restriction: string | null;
  }>(
    sql`
    select id, name, type, is_active, is_summary, currency_restriction from accounts
     where org_id = ${orgId} and id = any(${uuidArray(ids)}::uuid[])`,
    "objects",
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const line of banks) {
    const account = byId.get(line.accountId);
    if (!account) refuse("a chosen bank account does not exist in this organization", 404);
    if (account.type !== "asset_bank" || !account.is_active || account.is_summary) {
      refuse(
        `${account.name} is not an active bank account; choose an active bank account for cash settlement`,
      );
    }
    if (account.currency_restriction && account.currency_restriction !== line.currency) {
      refuse(
        `${account.name} holds ${account.currency_restriction}, not ${line.currency}; choose a ${line.currency} bank account`,
      );
    }
  }
}

function fingerprintOf(computation: NettingComputation, lines: NettingRunLine[]): string {
  return createHash("sha256").update(canonicalJson({ computation, lines })).digest("hex");
}

function validateProposal(input: ProposeNettingInput): ProposeNettingInput {
  if (!isIsoCalendarDate(input.asOfDate))
    refuse("the netting date must be a valid calendar date (YYYY-MM-DD)");
  const ids = [...new Set(input.subsidiaryIds ?? [])];
  if (ids.length < 2) refuse("choose at least two subsidiaries to net");
  for (const id of ids) if (!isUuid(id)) refuse("a chosen subsidiary is not a valid reference");
  if (
    input.bankAccounts !== undefined &&
    (typeof input.bankAccounts !== "object" || input.bankAccounts === null)
  ) {
    refuse("bank accounts must map each subsidiary and currency to an account");
  }
  return {
    asOfDate: input.asOfDate,
    subsidiaryIds: ids,
    settleCash: input.settleCash === true,
    bankAccounts: input.bankAccounts ?? {},
    reason: cleanReason(input.reason, "a reason"),
    idempotencyKey: input.idempotencyKey ?? null,
  };
}

/** Compute what a run would settle without writing anything. */
export async function previewNetting(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  raw: ProposeNettingInput,
): Promise<{ computation: NettingComputation; lines: NettingRunLine[] }> {
  const input = validateProposal({ ...raw, reason: raw.reason || "preview" });
  if (!scopeCovers(allowedSubsidiaryIds, input.subsidiaryIds))
    refuse("a chosen subsidiary is outside your visible subsidiaries", 404);
  return withOrgTransaction(orgId, async () => {
    if (!(await lockAndCheckOrgFeature(db, orgId, NETTING_FEATURE)))
      refuse(INTERCOMPANY_NETTING_DISABLED);
    const { computation, lines } = await computeNetting(db, orgId, input);
    return { computation, lines };
  });
}

/**
 * Propose a netting run: compute it, refuse a run that overlaps an open one,
 * and store the fingerprinted proposal. Idempotent per key.
 */
export async function proposeNettingRun(
  orgId: string,
  actorId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  raw: ProposeNettingInput,
): Promise<NettingRunDetail> {
  const input = validateProposal(raw);
  if (!scopeCovers(allowedSubsidiaryIds, input.subsidiaryIds))
    refuse("a chosen subsidiary is outside your visible subsidiaries", 404);
  const runId = await withOrgTransaction(orgId, async () => {
    await requireIntercompanyPermission(db, orgId, actorId, "intercompany.manage");
    await assertNettingEnabled(db, orgId);
    await lockNetting(db, orgId);
    const request = canonicalJson({
      asOfDate: input.asOfDate,
      subsidiaryIds: [...input.subsidiaryIds].sort(),
      settleCash: input.settleCash,
      bankAccounts: input.bankAccounts,
      reason: input.reason,
    });
    if (input.idempotencyKey) {
      const prior = (
        await db.execute<{ id: string; request: string | null }>(
          sql`
        select id, computation->>'request' as request from intercompany_netting_runs
         where org_id = ${orgId} and idempotency_key = ${input.idempotencyKey}`,
          "objects",
        )
      )[0];
      if (prior) {
        if (prior.request !== request)
          refuse(
            "this request key already proposed a different netting run; use a new key for a new run",
            409,
          );
        return prior.id;
      }
    }
    const overlapping = (
      await db.execute<{ run_number: string }>(
        sql`
      select run_number from intercompany_netting_runs
       where org_id = ${orgId} and status in ('proposed', 'pending_approval', 'approved')
         and cardinality(array(select unnest(subsidiary_ids) intersect select unnest(${uuidArray(input.subsidiaryIds)}::uuid[]))) >= 2
       order by run_number limit 1`,
        "objects",
      )
    )[0];
    if (overlapping) {
      refuse(
        `netting run ${overlapping.run_number} is open for these subsidiaries; post or cancel it before proposing another`,
        409,
      );
    }
    const { computation, lines } = await computeNetting(db, orgId, input);
    if (lines.length === 0) {
      refuse("there is nothing to net or settle between the chosen subsidiaries on this date");
    }
    const stored = { ...computation, request };
    const fingerprint = fingerprintOf(computation, lines);
    const runNumber = await allocateDocumentNumber(db, orgId, NUMBER_KIND, NUMBER_PREFIX);
    const inserted = await db.execute<{ id: string }>(
      sql`
      insert into intercompany_netting_runs
        (org_id, run_number, as_of_date, book_id, period_id, subsidiary_ids, settle_cash, bank_accounts,
         status, computation, fingerprint, reason, idempotency_key, proposed_by)
      values (${orgId}, ${runNumber}, ${input.asOfDate}, ${computation.bookId}, ${computation.periodId},
              ${uuidArray(computation.subsidiaryIds)}::uuid[], ${input.settleCash},
              ${JSON.stringify(input.bankAccounts ?? {})}::jsonb, 'proposed',
              ${JSON.stringify(stored)}::jsonb, ${fingerprint}, ${input.reason},
              ${input.idempotencyKey}, ${actorId})
      returning id`,
      "objects",
    );
    requireOneRow(inserted, "the netting run could not be stored");
    const id = inserted[0]!.id;
    for (const line of lines) {
      const written = await db.execute<{ id: string }>(
        sql`
        insert into intercompany_netting_lines
          (org_id, run_id, line_number, pair_id, currency, subsidiary_id, counterparty_subsidiary_id,
           component, account_id, journal_line_id, document_id, functional_currency,
           open_transaction_amount, open_carrying_amount, netted_amount, cash_amount,
           settlement_rate, realized_fx)
        values (${orgId}, ${id}, ${line.lineNumber}, ${line.pairId}, ${line.currency}, ${line.subsidiaryId},
                ${line.counterpartySubsidiaryId}, ${line.component}, ${line.accountId}, ${line.journalLineId},
                ${line.documentId}, ${line.functionalCurrency}, ${line.openTransaction}, ${line.openCarrying},
                ${line.netted}, ${line.cash}, ${line.rate}, ${line.realizedFx})
        returning id`,
        "objects",
      );
      requireOneRow(written, "a netting proposal line could not be stored");
    }
    await auditIntercompany(db, {
      orgId,
      table: "intercompany_netting_runs",
      rowId: id,
      action: "insert",
      actorId,
      changes: {
        mode: "intercompany_netting_proposed",
        reason: input.reason,
        after: {
          runNumber,
          asOfDate: input.asOfDate,
          subsidiaryIds: computation.subsidiaryIds,
          settleCash: input.settleCash,
          fingerprint,
          pairs: computation.pairs,
        },
      },
    });
    return id;
  });
  return loadNettingRun(orgId, runId, allowedSubsidiaryIds);
}

async function lockRun(
  runner: SqlExecutor,
  orgId: string,
  runId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{
  id: string;
  run_number: string;
  status: NettingRunStatus;
  subsidiary_ids: string[];
  as_of_date: string;
  book_id: string;
  period_id: string;
  settle_cash: boolean;
  fingerprint: string;
  computation: NettingComputation;
  proposed_by: string;
  submitted_by: string | null;
  reason: string;
}> {
  if (!isUuid(runId)) refuse("netting run not found", 404);
  const run = (
    await runner.execute<{
      id: string;
      run_number: string;
      status: NettingRunStatus;
      subsidiary_ids: string[];
      as_of_date: string;
      book_id: string;
      period_id: string;
      settle_cash: boolean;
      fingerprint: string;
      computation: NettingComputation;
      proposed_by: string;
      submitted_by: string | null;
      reason: string;
    }>(
      sql`
    select id, run_number, status, subsidiary_ids, as_of_date::text as as_of_date, book_id, period_id,
           settle_cash, fingerprint, computation, proposed_by, submitted_by, reason
      from intercompany_netting_runs
     where org_id = ${orgId} and id = ${runId}
     for update`,
      "objects",
    )
  )[0];
  if (!run || !scopeCovers(allowedSubsidiaryIds, run.subsidiary_ids))
    refuse("netting run not found", 404);
  return run;
}

/**
 * Submit a proposed run for approval. An enabled flow that raises a gate
 * parks it in pending approval; with none the run is approved at once and
 * the audit records that no approval applied.
 */
export async function submitNettingRun(
  orgId: string,
  actorId: string,
  runId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ status: "pending_approval" | "approved"; gated: boolean }> {
  type SubmitOutcome =
    { refusal: string } | { status: "pending_approval" | "approved"; gated: boolean };
  // A failed routing returns its refusal so the cancellation of whatever the
  // dispatch opened commits; the run itself stays proposed.
  const outcome = await withOrgTransaction(orgId, async (): Promise<SubmitOutcome> => {
    await requireIntercompanyPermission(db, orgId, actorId, "intercompany.manage");
    await assertNettingEnabled(db, orgId);
    const run = await lockRun(db, orgId, runId, allowedSubsidiaryIds);
    if (run.status !== "proposed")
      refuse(
        `only a proposed netting run can be submitted; this one is ${run.status.replace("_", " ")}`,
        409,
      );
    const dispatch = (
      await routeSubjectSubmission({
        orgId,
        actorId,
        subjectKind: INTERCOMPANY_NETTING_RUN_SUBJECT_KIND,
        subjectId: runId,
        source: "ui",
      })
    ).dispatch;
    if (dispatch.failed) {
      await cancelDispatchRuns(
        orgId,
        dispatch.runs.map((item) => item.runId),
        { actorId },
      );
      return {
        refusal: `netting run approval routing failed: ${dispatchFailureReason(dispatch) ?? "the flow could not run"}`,
      };
    }
    const gated = dispatch.gatesCreated > 0;
    const status = gated ? "pending_approval" : "approved";
    const gatingRun = dispatch.runs.find((item) => item.gatesCreated > 0)?.runId ?? null;
    const updated = await db.execute<{ id: string }>(
      sql`
      update intercompany_netting_runs
         set status = ${status}, submitted_by = ${actorId}, submitted_at = now(),
             flow_run_id = ${gatingRun},
             decided_by = ${gated ? null : actorId}, decided_at = ${gated ? null : sql`now()`},
             updated_at = now()
       where org_id = ${orgId} and id = ${runId} and status = 'proposed'
      returning id`,
      "objects",
    );
    requireOneRow(updated, "the netting run changed while it was being submitted");
    await auditIntercompany(db, {
      orgId,
      table: "intercompany_netting_runs",
      rowId: runId,
      action: "update",
      actorId,
      changes: {
        mode: "intercompany_netting_submitted",
        before: { status: "proposed" },
        after: { status },
        approval: gated ? "flow" : "not_required",
      },
    });
    return { status, gated };
  });
  if ("refusal" in outcome) refuse(outcome.refusal);
  return outcome;
}

/**
 * Release a netting run's Flows approval. Runs inside the gate decision's
 * transaction, so a refusal here rolls the decision back. The proposer or
 * submitter may decide only under an explicit frozen self-approval policy.
 */
export async function releaseNettingRunApproval(args: {
  orgId: string;
  runId: string;
  actorId: string | null;
  outcome: "approved" | "rejected";
  comment?: string | null;
  approvalRunId?: string;
}): Promise<void> {
  const { orgId, runId, actorId, outcome } = args;
  if (!actorId) refuse("a netting run approval must be decided by a signed-in user");
  await requireIntercompanyPermission(db, orgId, actorId, "intercompany.approve");
  await assertNettingEnabled(db, orgId);
  const run = (
    await db.execute<{ status: string; proposed_by: string; submitted_by: string | null }>(
      sql`
    select status, proposed_by, submitted_by from intercompany_netting_runs
     where org_id = ${orgId} and id = ${runId}
     for update`,
      "objects",
    )
  )[0];
  if (!run) refuse("netting run not found", 404);
  if (run.status !== "pending_approval")
    refuse(`the netting run is ${run.status.replace("_", " ")}, not awaiting approval`, 409);
  if (actorId === run.proposed_by || actorId === run.submitted_by) {
    const allowed = await completedGateAllowsSelfApproval(db, {
      orgId,
      subjectKind: INTERCOMPANY_NETTING_RUN_SUBJECT_KIND,
      subjectId: runId,
      approvalRunId: args.approvalRunId,
      actorId,
      outcome,
    });
    if (!allowed) {
      refuse(
        "the person who proposed or submitted a netting run cannot decide its approval without an explicit self-approval policy on the gate",
      );
    }
  }
  const note = args.comment?.trim() || null;
  if (outcome === "rejected" && !note) refuse("a rejection reason is required");
  const next = outcome === "approved" ? "approved" : "rejected";
  const updated = await db.execute<{ id: string }>(
    sql`
    update intercompany_netting_runs
       set status = ${next}, decided_by = ${actorId}, decided_at = now(), decision_note = ${note}, updated_at = now()
     where org_id = ${orgId} and id = ${runId} and status = 'pending_approval'
    returning id`,
    "objects",
  );
  requireOneRow(updated, "the netting run changed while its approval was being released");
  await auditIntercompany(db, {
    orgId,
    table: "intercompany_netting_runs",
    rowId: runId,
    action: "update",
    actorId,
    changes: {
      mode: `intercompany_netting_${next}`,
      before: { status: "pending_approval" },
      after: { status: next },
      reason: note,
    },
  });
}

/** Cancel a run that has not posted. */
export async function cancelNettingRun(
  orgId: string,
  actorId: string,
  runId: string,
  reasonInput: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<NettingRunDetail> {
  const reason = cleanReason(reasonInput, "a cancellation reason");
  await withOrgTransaction(orgId, async () => {
    await requireIntercompanyPermission(db, orgId, actorId, "intercompany.manage");
    await assertNettingEnabled(db, orgId);
    const run = await lockRun(db, orgId, runId, allowedSubsidiaryIds);
    if (!["proposed", "pending_approval", "approved"].includes(run.status)) {
      refuse(`a ${run.status.replace("_", " ")} netting run cannot be cancelled`, 409);
    }
    const updated = await db.execute<{ id: string }>(
      sql`
      update intercompany_netting_runs
         set status = 'cancelled', cancelled_by = ${actorId}, cancelled_at = now(), cancel_reason = ${reason}, updated_at = now()
       where org_id = ${orgId} and id = ${runId} and status = ${run.status}
      returning id`,
      "objects",
    );
    requireOneRow(updated, "the netting run changed while it was being cancelled");
    if (run.status === "pending_approval") {
      const flowRuns = (
        await db.execute<{ flow_run_id: string | null }>(
          sql`
        select flow_run_id from intercompany_netting_runs where org_id = ${orgId} and id = ${runId}`,
          "objects",
        )
      )[0]?.flow_run_id;
      if (flowRuns) await cancelDispatchRuns(orgId, [flowRuns], { actorId });
    }
    await auditIntercompany(db, {
      orgId,
      table: "intercompany_netting_runs",
      rowId: runId,
      action: "update",
      actorId,
      changes: {
        mode: "intercompany_netting_cancelled",
        before: { status: run.status },
        after: { status: "cancelled" },
        reason,
      },
    });
  });
  return loadNettingRun(orgId, runId, allowedSubsidiaryIds);
}

type StoredLine = {
  id: string;
  line_number: number;
  pair_id: string;
  currency: string;
  subsidiary_id: string;
  counterparty_subsidiary_id: string;
  component: "open_item" | "due_position" | "cash";
  account_id: string;
  journal_line_id: string | null;
  functional_currency: string;
  open_transaction_amount: string;
  open_carrying_amount: string;
  netted_amount: string;
  cash_amount: string;
  settlement_rate: string;
};

/**
 * Post an approved run. Every balance is re-read under lock and must equal
 * the proposal; one entry per pair and currency posts through the kernel,
 * cleared open items are applied, and realized exchange differences post in
 * each entity's functional currency. Idempotent: a posted run returns as is.
 */
export async function postNettingRun(
  orgId: string,
  actorId: string,
  runId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<NettingRunDetail> {
  await withOrgTransaction(orgId, async () => {
    await requireIntercompanyPermission(db, orgId, actorId, "intercompany.settle");
    await assertNettingEnabled(db, orgId);
    await lockNetting(db, orgId);
    const run = await lockRun(db, orgId, runId, allowedSubsidiaryIds);
    if (run.status === "posted") return;
    if (run.status !== "approved") {
      refuse(
        run.status === "proposed"
          ? "submit the netting run for approval before posting it"
          : `a ${run.status.replace("_", " ")} netting run cannot be posted`,
        409,
      );
    }
    const stored = await db.execute<StoredLine>(
      sql`
      select id, line_number, pair_id, currency, subsidiary_id, counterparty_subsidiary_id, component,
             account_id, journal_line_id, functional_currency,
             open_transaction_amount::text as open_transaction_amount,
             open_carrying_amount::text as open_carrying_amount,
             netted_amount::text as netted_amount, cash_amount::text as cash_amount,
             settlement_rate::text as settlement_rate
        from intercompany_netting_lines
       where org_id = ${orgId} and run_id = ${runId}
       order by line_number`,
      "objects",
    );
    if (stored.length === 0) refuse("this netting run has nothing to post", 409);

    const modules: ("ar" | "ap" | "banking")[] = [
      "ar",
      "ap",
      ...(run.settle_cash ? ["banking" as const] : []),
    ];
    await assertIntercompanyPeriodsOpen(db, {
      orgId,
      date: run.as_of_date,
      bookId: run.book_id,
      subsidiaryIds: run.subsidiary_ids,
      modules,
    });

    // The proposal must still describe the books exactly.
    const openLines = stored.filter((line) => line.component === "open_item");
    const current = await loadOpenItems(db, {
      orgId,
      bookId: run.book_id,
      asOfDate: run.as_of_date,
      keys: [],
      lineIds: openLines.map((line) => line.journal_line_id!),
      lock: true,
    });
    const currentById = new Map(current.map((row) => [row.id, row]));
    const stale: string[] = [];
    for (const line of openLines) {
      const row = currentById.get(line.journal_line_id!);
      if (
        !row ||
        toUnits(signedOpen(row.txn_amount, row.open_txn)) !==
          toUnits(line.open_transaction_amount) ||
        toUnits(signedOpen(row.amount, row.open_base)) !== toUnits(line.open_carrying_amount)
      ) {
        stale.push(`line ${line.line_number}`);
      }
    }
    const positionLines = stored.filter((line) => line.component === "due_position");
    if (positionLines.length > 0) {
      const positions = await loadPositions(db, {
        orgId,
        bookId: run.book_id,
        asOfDate: run.as_of_date,
        keys: positionLines.map((line) => ({
          subsidiaryId: line.subsidiary_id,
          accountId: line.account_id,
        })),
      });
      for (const line of positionLines) {
        const row = positions.find(
          (p) =>
            p.subsidiary_id === line.subsidiary_id &&
            p.account_id === line.account_id &&
            p.currency === line.currency,
        );
        if (
          !row ||
          toUnits(row.txn) !== toUnits(line.open_transaction_amount) ||
          toUnits(row.base) !== toUnits(line.open_carrying_amount)
        ) {
          stale.push(`line ${line.line_number}`);
        }
      }
    }
    if (stale.length > 0) {
      refuse(
        `intercompany balances changed since this run was proposed (${stale.join(", ")}); cancel the run and propose a new one`,
        409,
        { staleLines: stale },
      );
    }

    const fx = await loadControlAccountsForRoles(db, orgId, ["fxRealizedGainLoss"]);
    const ctx = await loadSubsidiaryContext(db, orgId);
    const pairs = [...new Set(stored.map((line) => `${line.pair_id}|${line.currency}`))].sort();
    const partyByLine = new Map(current.map((row) => [row.id, row.party_id]));
    let entryIndex = 0;
    for (const key of pairs) {
      const [pairId, currency] = key.split("|") as [string, string];
      const group = stored.filter((line) => line.pair_id === pairId && line.currency === currency);
      const header = group[0]!;
      const postLines: (PostEntryLineInput & { netting?: StoredLine })[] = [];
      // Open items settle at the spot rate like a payment; the difference to
      // their carrying amount moves the control account in a separate
      // realized-exchange entry, exactly as payment settlement does.
      const fxLines: PostEntryLineInput[] = [];
      const memo = `Intercompany netting ${run.run_number}`;
      for (const line of group) {
        const cleared = toUnits(line.netted_amount) + toUnits(line.cash_amount);
        if (line.component === "cash") {
          const amount = fromUnits(toUnits(line.cash_amount));
          postLines.push({
            accountId: line.account_id,
            subsidiaryId: line.subsidiary_id,
            currency,
            txnAmount: amount,
            fxRate: line.settlement_rate,
            amount: spotTranslation(amount, line.settlement_rate),
            memo,
            netting: line,
          });
          continue;
        }
        if (cleared === 0n) continue;
        const clearedText = fromUnits(cleared);
        if (line.component === "open_item") {
          const spotCleared = spotTranslation(clearedText, line.settlement_rate);
          const carrying = carryingOf(line, clearedText);
          const partyId = partyByLine.get(line.journal_line_id!) ?? null;
          postLines.push({
            accountId: line.account_id,
            subsidiaryId: line.subsidiary_id,
            partyId,
            currency,
            txnAmount: neg(clearedText),
            fxRate: line.settlement_rate,
            amount: neg(spotCleared),
            isOpenItem: true,
            memo,
            netting: line,
          });
          const adjustment = fromUnits(toUnits(spotCleared) - toUnits(carrying));
          if (toUnits(adjustment) !== 0n) {
            fxLines.push({
              accountId: line.account_id,
              subsidiaryId: line.subsidiary_id,
              partyId,
              currency: line.functional_currency,
              txnAmount: adjustment,
              fxRate: "1",
              amount: adjustment,
              memo: `${memo} — realized exchange difference`,
            });
          }
          continue;
        }
        // Due-to/due-from position: released at its carrying amount so the
        // remaining position keeps its historical translation.
        const carrying = carryingOf(line, clearedText);
        try {
          for (const translated of carryingRateLines(neg(clearedText), neg(carrying))) {
            postLines.push({
              accountId: line.account_id,
              subsidiaryId: line.subsidiary_id,
              currency,
              txnAmount: translated.txnAmount,
              fxRate: translated.fxRate,
              amount: translated.amount,
              memo,
              netting: line,
            });
          }
        } catch (error) {
          if (error instanceof NettingMathError)
            refuse(`line ${line.line_number}: ${error.message}`);
          throw error;
        }
      }
      if (postLines.length === 0) continue;
      // Each entity balances on its own; what is left in an entity's
      // functional currency is the realized exchange difference.
      const bySubsidiary = new Map<string, bigint>();
      for (const line of postLines) {
        bySubsidiary.set(
          line.subsidiaryId!,
          (bySubsidiary.get(line.subsidiaryId!) ?? 0n) + toUnits(line.amount),
        );
      }
      for (const [subsidiaryId, total] of [...bySubsidiary.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        if (total === 0n) continue;
        if (!fx.fxRealizedGainLoss) {
          refuse(
            "the realized FX gain/loss account is not configured; set it in Setup → Company & Accounting → Control accounts",
          );
        }
        const amount = fromUnits(-total);
        const functional = group.find(
          (line) => line.subsidiary_id === subsidiaryId,
        )!.functional_currency;
        postLines.push({
          accountId: fx.fxRealizedGainLoss,
          subsidiaryId,
          currency: functional,
          txnAmount: amount,
          fxRate: "1",
          amount,
          memo: `${memo} — realized exchange difference`,
        });
      }
      try {
        await validateSubsidiaryRestrictions(db, {
          orgId,
          ctx,
          docSubsidiaryId: header.subsidiary_id,
          lines: postLines.map((line) => ({
            accountId: line.accountId,
            amount: line.amount,
            subsidiaryId: line.subsidiaryId!,
            partyId: line.partyId ?? null,
          })),
        });
      } catch (error) {
        if (error instanceof SubsidiaryError) refuse(error.message);
        throw error;
      }
      entryIndex += 1;
      let posted: PostEntryResult;
      try {
        posted = await postEntry(db, {
          orgId,
          bookId: run.book_id,
          subsidiaryId: pairOrigin(group),
          entryNumber: `${run.run_number}-${entryIndex}`,
          postingDate: run.as_of_date,
          periodId: run.period_id,
          memo,
          origin: "intercompany",
          custom: { intercompanyNettingRunId: runId },
          actorId,
          idempotencyKey: `intercompany-netting:${runId}:${pairId}:${currency}`,
          closeModules: modules,
          lines: postLines.map(({ netting: _netting, ...line }, index) => ({
            ...line,
            lineNumber: index + 1,
          })),
        });
      } catch (error) {
        intercompanyPostingRefusal(error);
      }
      let fxEntryId: string | null = null;
      if (fxLines.length > 0) {
        if (!fx.fxRealizedGainLoss) {
          refuse(
            "the realized FX gain/loss account is not configured; set it in Setup → Company & Accounting → Control accounts",
          );
        }
        const bySub = new Map<string, { total: bigint; currency: string }>();
        for (const line of fxLines) {
          const prior = bySub.get(line.subsidiaryId!) ?? { total: 0n, currency: line.currency! };
          prior.total += toUnits(line.amount);
          bySub.set(line.subsidiaryId!, prior);
        }
        const offsets: PostEntryLineInput[] = [...bySub.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .filter(([, value]) => value.total !== 0n)
          .map(([subsidiaryId, value]) => {
            const amount = fromUnits(-value.total);
            return {
              accountId: fx.fxRealizedGainLoss!,
              subsidiaryId,
              currency: value.currency,
              txnAmount: amount,
              fxRate: "1",
              amount,
              memo: `${memo} — realized exchange difference`,
            };
          });
        try {
          const fxPosted = await postEntry(db, {
            orgId,
            bookId: run.book_id,
            subsidiaryId: pairOrigin(group),
            entryNumber: `${run.run_number}-${entryIndex}-FX`,
            postingDate: run.as_of_date,
            periodId: run.period_id,
            memo: `Realized exchange difference — intercompany netting ${run.run_number}`,
            origin: "fx_settlement",
            custom: { intercompanyNettingRunId: runId },
            actorId,
            idempotencyKey: `intercompany-netting-fx:${runId}:${pairId}:${currency}`,
            closeModules: modules,
            lines: [...fxLines, ...offsets].map((line, index) => ({
              ...line,
              lineNumber: index + 1,
            })),
          });
          fxEntryId = fxPosted.entryId;
        } catch (error) {
          intercompanyPostingRefusal(error);
        }
      }
      const lineIdByIndex = new Map(posted.lines.map((line) => [line.lineNumber, line.id]));
      for (const [index, line] of postLines.entries()) {
        const netting = line.netting;
        if (!netting) continue;
        const settlementLineId = lineIdByIndex.get(index + 1)!;
        let applicationId: string | null = null;
        if (netting.component === "open_item") {
          const clearedText = fromUnits(
            toUnits(netting.netted_amount) + toUnits(netting.cash_amount),
          );
          const magnitude = (value: string) =>
            fromUnits(toUnits(value) < 0n ? -toUnits(value) : toUnits(value));
          const carrying = magnitude(carryingOf(netting, clearedText));
          const settledBase = magnitude(line.amount);
          const settledTxn = magnitude(clearedText);
          const inserted = await db.execute<{ id: string }>(
            sql`
            insert into applications (org_id, from_line_id, to_line_id, amount, source_amount,
              source_transaction_amount, source_transaction_currency, target_transaction_amount,
              target_transaction_currency, settlement_rate, settlement_rate_source, settlement_rate_reference,
              applied_on, fx_gain_loss_entry_id, created_by, updated_by)
            values (${orgId}, ${settlementLineId}, ${netting.journal_line_id}, ${carrying}, ${settledBase},
              ${settledTxn}, ${currency}, ${settledTxn}, ${currency}, 1, 'same_currency',
              ${`Intercompany netting ${run.run_number}`}, ${run.as_of_date}, ${fxEntryId}, ${actorId}, ${actorId})
            returning id`,
            "objects",
          );
          requireOneRow(inserted, "an intercompany settlement could not be applied");
          applicationId = inserted[0]!.id;
        }
        // A position cleared through two translated lines records the first.
        const stamped = await db.execute<{ id: string }>(
          sql`
          update intercompany_netting_lines
             set settlement_entry_id = ${posted.entryId},
                 settlement_line_id = coalesce(settlement_line_id, ${settlementLineId}),
                 application_id = coalesce(application_id, ${applicationId})
           where org_id = ${orgId} and id = ${netting.id}
          returning id`,
          "objects",
        );
        requireOneRow(stamped, "the netting line changed while the run was posting");
      }
    }
    const updated = await db.execute<{ id: string }>(
      sql`
      update intercompany_netting_runs
         set status = 'posted', posted_by = ${actorId}, posted_at = now(), updated_at = now()
       where org_id = ${orgId} and id = ${runId} and status = 'approved'
      returning id`,
      "objects",
    );
    requireOneRow(updated, "the netting run changed while it was posting");
    await auditIntercompany(db, {
      orgId,
      table: "intercompany_netting_runs",
      rowId: runId,
      action: "update",
      actorId,
      changes: {
        mode: "intercompany_netting_posted",
        before: { status: "approved" },
        after: { status: "posted" },
        fingerprint: run.fingerprint,
      },
    });
  });
  return loadNettingRun(orgId, runId, allowedSubsidiaryIds);
}

/** The carrying amount a stored line's cleared total releases (same rule as the proposal). */
function carryingOf(
  line: Pick<StoredLine, "open_transaction_amount" | "open_carrying_amount">,
  cleared: string,
): string {
  return carryingForSettlement(line.open_carrying_amount, line.open_transaction_amount, cleared);
}

/** The entry's header entity: the entity of the group's first line. */
function pairOrigin(group: StoredLine[]): string {
  return [...group].sort((a, b) => a.line_number - b.line_number)[0]!.subsidiary_id;
}

/**
 * Reverse a posted run on a date: each settlement entry is mirrored, the
 * open items it cleared reopen, and the run is marked reversed with its
 * reason. Idempotent per run.
 */
export async function reverseNettingRun(
  orgId: string,
  actorId: string,
  runId: string,
  input: { reversalDate: string; reason: string },
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<NettingRunDetail> {
  if (!isIsoCalendarDate(input.reversalDate))
    refuse("the reversal date must be a valid calendar date (YYYY-MM-DD)");
  const reason = cleanReason(input.reason, "a reversal reason");
  await withOrgTransaction(orgId, async () => {
    await requireIntercompanyPermission(db, orgId, actorId, "intercompany.settle");
    await assertNettingEnabled(db, orgId);
    await lockNetting(db, orgId);
    const run = await lockRun(db, orgId, runId, allowedSubsidiaryIds);
    if (run.status === "reversed") return;
    if (run.status !== "posted")
      refuse(
        `only a posted netting run can be reversed; this one is ${run.status.replace("_", " ")}`,
        409,
      );
    if (input.reversalDate < run.as_of_date)
      refuse(`the reversal date cannot be before the run date ${run.as_of_date}`);
    const periodId = await intercompanyPostingPeriod(
      db,
      orgId,
      input.reversalDate,
      run.subsidiary_ids[0]!,
    );
    const modules: ("ar" | "ap" | "banking")[] = [
      "ar",
      "ap",
      ...(run.settle_cash ? ["banking" as const] : []),
    ];
    await assertIntercompanyPeriodsOpen(db, {
      orgId,
      date: input.reversalDate,
      bookId: run.book_id,
      subsidiaryIds: run.subsidiary_ids,
      modules,
    });
    // Settlement entries and their realized-exchange entries carry the run.
    const entries = await db.execute<{ entry_id: string }>(
      sql`
      select id as entry_id from journal_entries
       where org_id = ${orgId} and status = 'posted' and reverses_entry_id is null -- Live entries only: an already reversed settlement cannot be reversed again.
         and custom->>'intercompanyNettingRunId' = ${runId}
       order by entry_number`,
      "objects",
    );
    let index = 0;
    for (const entry of entries) {
      index += 1;
      await postMirrorReversal(db, {
        orgId,
        entryId: entry.entry_id,
        entryNumber: `${run.run_number}-R${index}`,
        postingDate: input.reversalDate,
        periodId,
        memo: `Reversal of intercompany netting ${run.run_number}: ${reason}`,
        actorId,
        idempotencyKey: `intercompany-netting-reversal:${runId}:${entry.entry_id}`,
        custom: { intercompanyNettingRunId: runId, reversal: true },
        closeModules: modules,
      });
    }
    const updated = await db.execute<{ id: string }>(
      sql`
      update intercompany_netting_runs
         set status = 'reversed', reversed_by = ${actorId}, reversed_at = now(),
             reversal_date = ${input.reversalDate}, reverse_reason = ${reason}, updated_at = now()
       where org_id = ${orgId} and id = ${runId} and status = 'posted'
      returning id`,
      "objects",
    );
    requireOneRow(updated, "the netting run changed while it was being reversed");
    await auditIntercompany(db, {
      orgId,
      table: "intercompany_netting_runs",
      rowId: runId,
      action: "update",
      actorId,
      changes: {
        mode: "intercompany_netting_reversed",
        before: { status: "posted" },
        after: { status: "reversed", reversalDate: input.reversalDate },
        reason,
      },
    });
  });
  return loadNettingRun(orgId, runId, allowedSubsidiaryIds);
}

/** One run with its lines, visible only when every entity is in scope. */
export async function loadNettingRun(
  orgId: string,
  runId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  runner: SqlExecutor = db,
): Promise<NettingRunDetail> {
  if (!isUuid(runId)) refuse("netting run not found", 404);
  const run = (
    await runner.execute<{
      id: string;
      run_number: string;
      status: NettingRunStatus;
      as_of_date: string;
      subsidiary_ids: string[];
      settle_cash: boolean;
      reason: string;
      fingerprint: string;
      computation: NettingComputation;
      flow_run_id: string | null;
      proposed_by: string;
      proposed_at: string;
      submitted_by: string | null;
      decided_by: string | null;
      decided_at: string | null;
      decision_note: string | null;
      posted_by: string | null;
      posted_at: string | null;
      cancel_reason: string | null;
      reverse_reason: string | null;
      reversal_date: string | null;
    }>(
      sql`
    select id, run_number, status, as_of_date::text as as_of_date, subsidiary_ids, settle_cash, reason, fingerprint,
           computation, flow_run_id, proposed_by, proposed_at::text as proposed_at, submitted_by, decided_by,
           decided_at::text as decided_at, decision_note, posted_by, posted_at::text as posted_at, cancel_reason,
           reverse_reason, reversal_date::text as reversal_date
      from intercompany_netting_runs
     where org_id = ${orgId} and id = ${runId}`,
      "objects",
    )
  )[0];
  if (!run || !scopeCovers(allowedSubsidiaryIds, run.subsidiary_ids))
    refuse("netting run not found", 404);
  const lines = await runner.execute<{
    line_number: number;
    pair_id: string;
    currency: string;
    subsidiary_id: string;
    counterparty_subsidiary_id: string;
    component: "open_item" | "due_position" | "cash";
    account_id: string;
    journal_line_id: string | null;
    document_id: string | null;
    party_id: string | null;
    functional_currency: string;
    open_transaction_amount: string;
    open_carrying_amount: string;
    netted_amount: string;
    cash_amount: string;
    settlement_rate: string;
    realized_fx: string;
    settlement_entry_id: string | null;
    subsidiary_name: string;
    counterparty_name: string;
    account_label: string;
    document_number: string | null;
    document_kind: string | null;
  }>(
    sql`
    select l.line_number, l.pair_id, l.currency, l.subsidiary_id, l.counterparty_subsidiary_id, l.component,
           l.account_id, l.journal_line_id, l.document_id, jl.party_id, l.functional_currency,
           l.open_transaction_amount::text as open_transaction_amount,
           l.open_carrying_amount::text as open_carrying_amount,
           l.netted_amount::text as netted_amount, l.cash_amount::text as cash_amount,
           l.settlement_rate::text as settlement_rate, l.realized_fx::text as realized_fx,
           l.settlement_entry_id, s.name as subsidiary_name, c.name as counterparty_name,
           concat_ws(' · ', a.number, a.name) as account_label, d.document_number, d.kind as document_kind
      from intercompany_netting_lines l
      join subsidiaries s on s.org_id = l.org_id and s.id = l.subsidiary_id
      join subsidiaries c on c.org_id = l.org_id and c.id = l.counterparty_subsidiary_id
      join accounts a on a.org_id = l.org_id and a.id = l.account_id
      left join journal_lines jl on jl.org_id = l.org_id and jl.id = l.journal_line_id
      left join documents d on d.org_id = l.org_id and d.id = l.document_id
     where l.org_id = ${orgId} and l.run_id = ${runId}
     order by l.line_number`,
    "objects",
  );
  const computation = run.computation;
  return {
    id: run.id,
    runNumber: run.run_number,
    status: run.status,
    asOfDate: run.as_of_date,
    subsidiaryIds: run.subsidiary_ids,
    settleCash: run.settle_cash,
    reason: run.reason,
    fingerprint: run.fingerprint,
    computation,
    lines: lines.map((line) => {
      const cleared = fromUnits(toUnits(line.netted_amount) + toUnits(line.cash_amount));
      const carrying =
        line.component === "cash" || toUnits(cleared) === 0n ? "0.0000" : carryingOf(line, cleared);
      return {
        lineNumber: line.line_number,
        pairId: line.pair_id,
        currency: line.currency,
        subsidiaryId: line.subsidiary_id,
        counterpartySubsidiaryId: line.counterparty_subsidiary_id,
        component: line.component,
        accountId: line.account_id,
        journalLineId: line.journal_line_id,
        documentId: line.document_id,
        partyId: line.party_id,
        functionalCurrency: line.functional_currency,
        openTransaction: fromUnits(toUnits(line.open_transaction_amount)),
        openCarrying: fromUnits(toUnits(line.open_carrying_amount)),
        netted: fromUnits(toUnits(line.netted_amount)),
        cash: fromUnits(toUnits(line.cash_amount)),
        rate: line.settlement_rate,
        realizedFx: fromUnits(toUnits(line.realized_fx)),
        carryingCleared: carrying,
        spotCleared: spotTranslation(cleared, line.settlement_rate),
        subsidiaryName: line.subsidiary_name,
        counterpartySubsidiaryName: line.counterparty_name,
        accountLabel: line.account_label,
        documentNumber: line.document_number,
        documentKind: line.document_kind,
        settlementEntryId: line.settlement_entry_id,
      };
    }),
    flowRunId: run.flow_run_id,
    proposedBy: run.proposed_by,
    proposedAt: run.proposed_at,
    submittedBy: run.submitted_by,
    decidedBy: run.decided_by,
    decidedAt: run.decided_at,
    decisionNote: run.decision_note,
    postedBy: run.posted_by,
    postedAt: run.posted_at,
    cancelReason: run.cancel_reason,
    reverseReason: run.reverse_reason,
    reversalDate: run.reversal_date,
    entryIds: [
      ...new Set(
        lines.map((line) => line.settlement_entry_id).filter((id): id is string => Boolean(id)),
      ),
    ],
  };
}

export interface NettingRunSummary {
  id: string;
  runNumber: string;
  status: NettingRunStatus;
  asOfDate: string;
  subsidiaryIds: string[];
  settleCash: boolean;
  pairCount: number;
  lineCount: number;
  proposedAt: string;
}

/** Runs the caller can see in full (every entity in scope), newest first. */
export async function listNettingRuns(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  options: { limit?: number } = {},
): Promise<NettingRunSummary[]> {
  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);
  const rows = await db.execute<{
    id: string;
    run_number: string;
    status: NettingRunStatus;
    as_of_date: string;
    subsidiary_ids: string[];
    settle_cash: boolean;
    pair_count: number;
    line_count: number;
    proposed_at: string;
  }>(
    sql`
    select r.id, r.run_number, r.status, r.as_of_date::text as as_of_date, r.subsidiary_ids, r.settle_cash,
           coalesce(jsonb_array_length(r.computation->'pairs'), 0)::int as pair_count,
           (select count(*)::int from intercompany_netting_lines l where l.org_id = r.org_id and l.run_id = r.id) as line_count,
           r.proposed_at::text as proposed_at
      from intercompany_netting_runs r
     where r.org_id = ${orgId}
       and (${allowedSubsidiaryIds === null}::boolean
            or r.subsidiary_ids <@ ${uuidArray(allowedSubsidiaryIds === null ? [] : [...allowedSubsidiaryIds])}::uuid[])
     order by r.proposed_at desc, r.run_number desc
     limit ${limit}`,
    "objects",
  );
  return rows.map((row) => ({
    id: row.id,
    runNumber: row.run_number,
    status: row.status,
    asOfDate: row.as_of_date,
    subsidiaryIds: row.subsidiary_ids,
    settleCash: row.settle_cash,
    pairCount: row.pair_count,
    lineCount: row.line_count,
    proposedAt: row.proposed_at,
  }));
}
