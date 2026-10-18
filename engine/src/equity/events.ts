/**
 * Security events: exercise, settlement, forfeiture, expiry, cancellation,
 * repurchase, transfer, conversion, repayment, void, the governed reversal of
 * one event, and the 83(b) election on restricted stock.
 *
 * Every event is validated by replaying the security's whole history with
 * the new event in place (see cap-table.ts), so a backdated event can never
 * leave a later one exceeding what the security held. Events that produce
 * shares write the resulting certificate; events that move money post
 * through the journal kernel first and record their entry:
 *   option exercise  Dr consideration, Dr paid-in capital (share-based)
 *                    / Cr share capital at par / Cr APIC; cash for units
 *                    exercised before they vest / Cr early-exercise deposit
 *   warrant exercise Dr consideration / Cr share capital at par / Cr APIC
 *   RSU settlement   Dr paid-in capital (share-based) / Cr share capital / Cr APIC
 *   repurchase       Dr treasury stock / Cr consideration (cost method);
 *                    unvested early-exercised shares: Dr early-exercise
 *                    deposit / Cr consideration, the difference to APIC
 *   SAFE or note     Dr convertible instruments, Dr accrued interest
 *   conversion       / Cr share capital at par / Cr APIC
 *   repayment        Dr convertible instruments, Dr accrued interest
 *                    / Cr consideration (a note's premium or discount to
 *                    interest expense)
 *   cancellation     Dr convertible instruments, Dr accrued interest / Cr APIC
 *   preferred to     Dr preferred stock at par / Cr common stock at par,
 *   common           the difference to APIC
 * A note's settlement first accrues its interest to the settlement date
 * (see settlement.ts). The share-based paid-in capital reclassified on
 * exercise or settlement is the vested units' grant-date fair value: their
 * cost is fully attributed. Restricted units release theirs as they vest
 * (see restricted-stock.ts and compensation-run.ts).
 *
 * A void corrects a security recorded in error: its issuance entry, or the
 * entry of the event that produced it, is reversed on the void date and the
 * originating event is undone (a voided exercise certificate returns its
 * units to the option). A security with later recorded activity is not
 * voided; the certificates that activity produced are voided first.
 *
 * A reversal undoes one forfeiture, expiry, cancellation, repurchase,
 * repayment or 83(b) election recorded in error: the event's entry, if any,
 * is reversed on the reversal date and its units or balance are restored
 * from that date. Later activity on the security that relied on the event
 * is reversed first; the refusal names it.
 *
 * Exercising, settling, forfeiting, expiring, cancelling awards,
 * transferring, converting and recording an 83(b) election are bookkeeping
 * duties (equity.manage); repurchases, repayments, cancelling a SAFE or note,
 * voids and reversals are approvals (equity.approve).
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  conversionClassOf,
  conversionRatio,
  convertibleState,
  eventCeiling,
  eventsOf,
  holdingState,
} from "./cap-table.ts";
import { EquityError } from "./errors.ts";
import { functionalUnits, restate, spotRate } from "./fx.ts";
import { currencyExponent, requireReason, writeEquityAudit } from "./internal.ts";
import {
  instrumentBalance,
  postEquityEntry,
  requireConsiderationAccount,
  requirePolicyAccount,
  resolveAccountPolicy,
  reverseEquityEntry,
  type EquityLeg,
} from "./posting.ts";
import {
  divideRational,
  floorShares,
  formatPrice,
  ledgerUnits,
  minRational,
  multiplyRational,
  parseMoney,
  parsePrice,
  parseShares,
  rational,
  type Rational,
} from "./quantities.ts";
import { earlyExerciseSchedule, earlyExerciseSource, election83bDeadline, liveElection, needs83b, depositSlice, repurchasedRange } from "./restricted-stock.ts";
import { conversionAtRound, roundInstruments } from "./round-conversion.ts";
import {
  formatLedger,
  insertSecurity,
  newEquityId,
  nextSecurityNumber,
  parUnits,
  requireHolder,
  securityRecordOf,
  type SecurityInsert,
} from "./securities.ts";
import { settleConvertible, type Settlement } from "./settlement.ts";
import { restatePrice, splitFactor } from "./splits.ts";
import { assertPoolsCovered, assertWithinAuthorized, inEquityCommand, requireDate, type EquityCommand } from "./structure.ts";
import { REVERSIBLE_EVENT_KINDS, type EquityBook, type SecurityEventKind, type SecurityEventRecord, type SecurityRecord } from "./types.ts";

export interface RecordEventInput extends EquityCommand {
  securityId: string;
  kind: SecurityEventKind;
  effectiveOn: string;
  quantity?: string | null;
  reason?: string | null;
  considerationAccountId?: string | null;
  /** Cash paid on a repurchase or repayment, in the security's currency. */
  amount?: string | null;
  transfereePartyId?: string | null;
  /** The round a SAFE or note converts in. */
  roundId?: string | null;
  /** The common class preferred shares convert into. */
  targetShareClassId?: string | null;
  /** Fair market value per share on a repurchase of unvested early-exercised shares. */
  fairMarketValuePerShare?: string | null;
  /** The event a reversal undoes. */
  reversesEventId?: string | null;
  idempotencyKey?: string | null;
}

export interface RecordEventResult {
  eventId: string;
  resultingSecurityId: string | null;
  journalEntryId: string | null;
  reversalEntryId: string | null;
  /** Interest accrued to the settlement date of a note, posted before the settlement. */
  accrualEntryId: string | null;
  replayed: boolean;
}

const REASON_REQUIRED: readonly SecurityEventKind[] = ["forfeit", "expire", "cancel", "repurchase", "void", "reverse"];
const ALLOWED: Record<SecurityEventKind, readonly SecurityRecord["kind"][]> = {
  exercise: ["option", "warrant"],
  settle: ["rsu"],
  forfeit: ["option", "rsu"],
  expire: ["option", "warrant"],
  cancel: ["option", "rsu", "warrant", "safe", "note"],
  repurchase: ["share"],
  transfer: ["share", "warrant"],
  convert: ["share", "safe", "note"],
  void: ["share", "option", "rsu", "warrant", "safe", "note"],
  repay: ["safe", "note"],
  reverse: ["share", "option", "rsu", "warrant", "safe", "note"],
  election_83b: ["share"],
};

/** The duty an event needs: money leaving the company and corrections are approvals. */
export function eventPermission(kind: SecurityEventKind, securityKind: SecurityRecord["kind"]): "equity.manage" | "equity.approve" {
  if (kind === "repurchase" || kind === "void" || kind === "reverse" || kind === "repay") return "equity.approve";
  if (kind === "cancel" && (securityKind === "safe" || securityKind === "note")) return "equity.approve";
  return "equity.manage";
}

function refuse(message: string, remedy: string, options: { field?: string; status?: 404 | 409 | 422; code?: string } = {}): never {
  throw new EquityError(message, { code: options.code ?? "equity_event_invalid", status: options.status ?? 422, remedy, field: options.field });
}

interface EventInsert {
  id: string;
  securityId: string;
  kind: SecurityEventKind;
  effectiveOn: string;
  quantity: bigint | null;
  pricePerShare: string | null;
  amount: string | null;
  resultingSecurityId: string | null;
  roundId: string | null;
  considerationAccountId: string | null;
  journalEntryId: string | null;
  reversalEntryId: string | null;
  reason: string | null;
  idempotencyKey: string | null;
  reversesEventId: string | null;
  interestAmount: string | null;
  interestAccruedAmount: string | null;
  interestAccruedFunctional: string | null;
  interestAccrualEntryId: string | null;
  depositAmount: string | null;
  fairMarketValue: string | null;
  fxRate: string | null;
}

async function insertEvent(runner: SqlExecutor, orgId: string, subsidiaryId: string, actorId: string, row: EventInsert): Promise<void> {
  const inserted = (await runner.execute<{ id: string }>(sql`
    insert into equity_security_events (id, org_id, subsidiary_id, security_id, kind, effective_on, quantity, price_per_share, amount,
      resulting_security_id, round_id, consideration_account_id, journal_entry_id, reversal_entry_id, reason, idempotency_key, created_by,
      reverses_event_id, interest_amount, interest_accrued_amount, interest_accrued_functional, interest_accrual_entry_id,
      deposit_amount, fair_market_value, fx_rate)
    values (${row.id}, ${orgId}, ${subsidiaryId}, ${row.securityId}, ${row.kind}, ${row.effectiveOn}::date, ${row.quantity?.toString() ?? null}::bigint,
      ${row.pricePerShare}::numeric, ${row.amount}::numeric, ${row.resultingSecurityId}, ${row.roundId}, ${row.considerationAccountId},
      ${row.journalEntryId}, ${row.reversalEntryId}, ${row.reason}, ${row.idempotencyKey}, ${actorId},
      ${row.reversesEventId}, ${row.interestAmount}::numeric, ${row.interestAccruedAmount}::numeric, ${row.interestAccruedFunctional}::numeric,
      ${row.interestAccrualEntryId}, ${row.depositAmount}::numeric, ${row.fairMarketValue}::numeric, ${row.fxRate}::numeric)
    returning id`)).rows;
  if (inserted.length !== 1) throw new EquityError("The event was not saved.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
}

const asRecord = (row: EventInsert): SecurityEventRecord => ({
  id: row.id, securityId: row.securityId, kind: row.kind, effectiveOn: row.effectiveOn, quantity: row.quantity,
  pricePerShare: row.pricePerShare, amount: row.amount, resultingSecurityId: row.resultingSecurityId, roundId: row.roundId,
  reversesEventId: row.reversesEventId,
});

/** Replay every share-based security of the book to the end of time; any event that no longer fits refuses. */
function assertReplayable(book: EquityBook, securityId: string): void {
  const security = book.securities.find((row) => row.id === securityId);
  if (security && security.quantity !== null) holdingState(book, security, "9999-12-31");
}

/** A resulting certificate that inherits its source's terms except the ones the caller sets. */
function certificate(source: SecurityRecord, overrides: Partial<SecurityInsert> & Pick<SecurityInsert, "id" | "securityNumber" | "issueDate" | "quantity" | "holderPartyId">, base: { orgId: string; subsidiaryId: string; actorId: string }): SecurityInsert {
  return {
    orgId: base.orgId, subsidiaryId: base.subsidiaryId, kind: "share", shareClassId: source.shareClassId, planId: null, roundId: null,
    sourceSecurityId: source.id, pricePerShare: null, considerationAmount: null, currency: source.currency, considerationAccountId: null,
    vestingStart: null, vestingMonths: null, cliffMonths: null, vestingFrequency: null, vestingTranches: null, acceleration: "none",
    accelerationPercent: null, expirationDate: null, optionType: null, earlyExercise: false, safeType: null, valuationCap: null,
    discountPercent: null, interestRatePercent: null, interestBasis: null, interestDayCount: null, maturityDate: null, mfn: false,
    unvestedRepurchaseBasis: null, fxRate: source.fxRate, valuationMethod: null,
    valuationSharePrice: null, volatilityPercent: null, riskFreeRatePercent: null, expectedTermYears: null, dividendYieldPercent: null,
    fairValuePerUnit: null, expenseAttribution: null, memo: null, journalEntryId: null, idempotencyKey: null, actorId: base.actorId,
    ...overrides,
  };
}

/** Grant-date value of `quantity` units stated on `on`, in functional ledger units (exercised and settled units are fully attributed). */
function grantValueUnits(book: EquityBook, security: SecurityRecord, quantity: bigint, on: string, exponent: number): bigint {
  if (!security.fairValuePerUnit || !security.shareClassId) return 0n;
  const issueUnits = divideRational(rational(quantity), splitFactor(book.splits, security.shareClassId, security.issueDate, on));
  return ledgerUnits(restate(multiplyRational(issueUnits, parsePrice(security.fairValuePerUnit, "the fair value per unit")), security.fxRate), exponent);
}

/** Live holding events of a security that a reversal of `target` would leave relying on a state that no longer holds. */
function dependentEvents(book: EquityBook, security: SecurityRecord, target: SecurityEventRecord): SecurityEventRecord[] {
  const order = new Map(book.events.map((event, index) => [event.id, index]));
  const targetIndex = order.get(target.id)!;
  return eventsOf(book, security.id, "9999-12-31")
    .filter((event) => event.id !== target.id && event.effectiveOn >= target.effectiveOn && (order.get(event.id) ?? 0) > targetIndex);
}

/** Record one security event. */
export async function recordSecurityEvent(input: RecordEventInput): Promise<RecordEventResult> {
  const kind = input.kind;
  if (!(kind in ALLOWED)) refuse("Choose what happened to the security.", "Choose an event kind.", { field: "kind" });
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The event date");
  const reason = REASON_REQUIRED.includes(kind)
    ? requireReason(input.reason, `the ${kind === "reverse" ? "reversal" : kind}`)
    : typeof input.reason === "string" && input.reason.trim() !== "" ? input.reason.trim().slice(0, 2000) : null;
  const idempotencyKey = typeof input.idempotencyKey === "string" && input.idempotencyKey.trim() !== "" ? input.idempotencyKey.trim() : null;
  if (!isUuid(input.securityId)) refuse("The security does not exist.", "Choose a security.", { status: 404, code: "equity_security_unknown" });
  const located = await withOrgTransaction(input.orgId, async () => (await db.execute<{ subsidiary_id: string; kind: SecurityRecord["kind"] }>(sql`
    select subsidiary_id, kind from equity_securities where org_id = ${input.orgId} and id = ${input.securityId}`)).rows[0]);
  if (!located) refuse("The security does not exist.", "Choose a security.", { status: 404, code: "equity_security_unknown" });
  const subsidiaryId = located!.subsidiary_id;
  return inEquityCommand({ ...input, subsidiaryId }, eventPermission(kind, located!.kind), async ({ book, currency: functional }) => {
    if (idempotencyKey) {
      const existing = (await db.execute<{ id: string; security_id: string; kind: string; resulting_security_id: string | null; journal_entry_id: string | null; reversal_entry_id: string | null; interest_accrual_entry_id: string | null }>(sql`
        select id, security_id, kind, resulting_security_id, journal_entry_id, reversal_entry_id, interest_accrual_entry_id from equity_security_events
         where org_id = ${input.orgId} and idempotency_key = ${idempotencyKey}`)).rows[0];
      if (existing) {
        if (existing.security_id !== input.securityId || existing.kind !== kind) {
          throw new EquityError("This request key was already used for a different event.", { status: 409, code: "equity_idempotency_conflict", remedy: "Retry with a new request key." });
        }
        return {
          eventId: existing.id, resultingSecurityId: existing.resulting_security_id, journalEntryId: existing.journal_entry_id,
          reversalEntryId: existing.reversal_entry_id, accrualEntryId: existing.interest_accrual_entry_id, replayed: true,
        };
      }
    }
    // Pin the security row for the rest of the command.
    await db.execute(sql`select id from equity_securities where org_id = ${input.orgId} and id = ${input.securityId} for update`);
    const security = book.securities.find((row) => row.id === input.securityId)!;
    if (!ALLOWED[kind].includes(security.kind)) {
      refuse(`A ${security.kind} cannot be recorded with a ${kind}.`, "Choose an event that applies to this security.", { field: "kind" });
    }
    if (book.events.some((event) => event.securityId === security.id && event.kind === "void")) {
      refuse(`Security ${security.securityNumber} is void.`, "Voided securities take no further events.", { status: 409, code: "equity_security_void" });
    }
    if (effectiveOn < security.issueDate) refuse(`The event cannot precede the issue date (${security.issueDate}).`, `Date the event on or after ${security.issueDate}.`, { field: "effectiveOn" });
    const securityExponent = await currencyExponent(db, security.currency);
    const functionalExponent = security.currency === functional ? securityExponent : await currencyExponent(db, functional);
    const foreign = security.currency !== functional;
    const rateOn = async (date: string): Promise<string> => (foreign ? spotRate(db, input.orgId, security.currency, functional, date, functional) : "1");
    const foreignLeg = (txnUnits: bigint, fxRate: string) => (foreign ? { currency: security.currency, txnUnits, fxRate } : undefined);
    const base = { orgId: input.orgId, subsidiaryId, actorId: input.actorId };
    const eventId = await newEquityId(db);
    const event: EventInsert = {
      id: eventId, securityId: security.id, kind, effectiveOn, quantity: null, pricePerShare: null, amount: null, resultingSecurityId: null,
      roundId: null, considerationAccountId: null, journalEntryId: null, reversalEntryId: null, reason, idempotencyKey,
      reversesEventId: null, interestAmount: null, interestAccruedAmount: null, interestAccruedFunctional: null, interestAccrualEntryId: null,
      depositAmount: null, fairMarketValue: null, fxRate: null,
    };
    const shareClass = security.shareClassId ? book.classes.find((row) => row.id === security.shareClassId)! : null;
    const quantity = (): bigint => {
      const value = parseShares(input.quantity ?? "", "the quantity");
      if (value <= 0n) refuse("The quantity must be at least one share.", "Enter the quantity.", { field: "quantity" });
      return value;
    };
    const convertible = security.kind === "safe" || security.kind === "note";
    const assertConvertibleOutstanding = (): void => {
      const now = convertibleState(book, security, effectiveOn);
      const lifetime = convertibleState(book, security, "9999-12-31");
      if (now.status !== "outstanding" || lifetime.status !== "outstanding") {
        const state = now.status !== "outstanding" ? now : lifetime;
        refuse(`Security ${security.securityNumber} is ${state.status} as of ${state.endedOn ?? effectiveOn}.`, "Record a settlement only on an outstanding SAFE or note; reverse the earlier settlement first if it was recorded in error.", { status: 409, code: "equity_convertible_settled" });
      }
    };
    const recordSettlement = (settlement: Settlement): void => {
      event.amount = formatLedger(settlement.principalTxnUnits + settlement.interestTxnUnits);
      event.interestAmount = formatLedger(settlement.interestTxnUnits);
      event.fxRate = foreign ? settlement.fxRate : null;
      if (settlement.accrual) {
        event.interestAccruedAmount = formatLedger(settlement.accrual.txnUnits);
        event.interestAccruedFunctional = formatLedger(settlement.accrual.functionalUnits);
        event.interestAccrualEntryId = settlement.accrual.entryId;
      }
    };
    let resulting: SecurityInsert | null = null;
    let legs: EquityLeg[] = [];
    let entryMemo = "";

    switch (kind) {
      case "exercise":
      case "settle": {
        const units = quantity();
        if (kind === "exercise" && security.expirationDate && effectiveOn > security.expirationDate) {
          refuse(`Security ${security.securityNumber} expired on ${security.expirationDate}.`, "Record the expiry instead.", { status: 409, code: "equity_security_expired" });
        }
        const state = holdingState(book, security, effectiveOn);
        const vestedCeiling = eventCeiling(book, security, state.exact.vestedAvailable, effectiveOn);
        const early = kind === "exercise" && security.kind === "option" && security.earlyExercise;
        const ceiling = early ? eventCeiling(book, security, state.exact.outstanding, effectiveOn) : vestedCeiling;
        if (units > ceiling) {
          refuse(
            early ? `Only ${ceiling} units are outstanding on ${effectiveOn}.` : `Only ${ceiling} units are vested and unexercised on ${effectiveOn}.`,
            early ? `Exercise no more than ${ceiling} units.` : `Record no more than ${ceiling} units; unvested units cannot be ${kind === "exercise" ? "exercised" : "settled"}.`,
            { field: "quantity", status: 409, code: "equity_event_exceeds_vested" },
          );
        }
        const schedule = early && units > vestedCeiling ? earlyExerciseSchedule(book, security, units, effectiveOn) : null;
        if (schedule && !security.unvestedRepurchaseBasis) {
          refuse(`Grant ${security.securityNumber} does not record the price at which the company repurchases unvested shares.`, `Exercise no more than the ${vestedCeiling} vested units.`, { field: "quantity", status: 409, code: "equity_repurchase_terms_missing" });
        }
        const price = kind === "exercise" ? restatePrice(book.splits, shareClass!.id, parsePrice(security.pricePerShare, "the exercise price"), security.issueDate, effectiveOn) : rational(0n);
        const cashTxn = ledgerUnits(multiplyRational(price, rational(units)), securityExponent);
        const fxRate = cashTxn > 0n ? await rateOn(effectiveOn) : "1";
        const cash = functionalUnits(cashTxn, fxRate);
        const vestedUnits = schedule ? schedule.vestedOnIssue : units;
        const deposit = schedule ? cash - functionalUnits(ledgerUnits(multiplyRational(price, rational(vestedUnits)), securityExponent), fxRate) : 0n;
        const reclass = security.kind === "warrant" ? 0n : grantValueUnits(book, security, vestedUnits, effectiveOn, functionalExponent);
        const par = parUnits(book, shareClass!, vestedUnits, effectiveOn, functionalExponent);
        const reclassAll = security.kind === "warrant" ? 0n : grantValueUnits(book, security, units, effectiveOn, functionalExponent);
        if (cash + reclassAll < parUnits(book, shareClass!, units, effectiveOn, functionalExponent)) {
          refuse("The shares would be issued below par value.", "Review the exercise price and the class's par value.", { status: 409, code: "equity_below_par" });
        }
        const account = cashTxn > 0n ? await requireConsiderationAccount(db, input.orgId, input.considerationAccountId) : null;
        const certificateId = await newEquityId(db);
        resulting = certificate(security, {
          id: certificateId,
          securityNumber: nextSecurityNumber(book, "share", shareClass),
          issueDate: effectiveOn,
          quantity: units,
          holderPartyId: security.holderPartyId,
          pricePerShare: kind === "exercise" ? formatPrice(price) : null,
          considerationAmount: cashTxn > 0n ? formatLedger(cashTxn) : null,
          considerationAccountId: account,
          vestingTranches: schedule?.tranches ?? null,
          fxRate,
        }, base);
        event.quantity = units;
        event.pricePerShare = kind === "exercise" ? formatPrice(price) : null;
        event.amount = kind === "exercise" ? formatLedger(cashTxn) : null;
        event.considerationAccountId = account;
        event.depositAmount = schedule ? formatLedger(deposit) : null;
        event.fxRate = foreign && cashTxn > 0n ? fxRate : null;
        if (cash + reclass > 0n) {
          const policy = await resolveAccountPolicy(db, input.orgId, subsidiaryId, effectiveOn);
          legs = [
            ...(account ? [{ accountId: account, units: cash, foreign: foreignLeg(cashTxn, fxRate) }] : []),
            { accountId: policy.apicShareBasedAccountId, units: reclass },
            { accountId: shareClass!.kind === "preferred" ? policy.preferredStockAccountId : policy.commonStockAccountId, units: -par },
            { accountId: policy.apicAccountId, units: -(cash - deposit + reclass - par) },
            ...(deposit > 0n ? [{
              accountId: requirePolicyAccount(policy, "earlyExerciseDepositAccountId"), units: -deposit,
              balance: { securityId: certificateId, role: "deposit" as const },
            }] : []),
          ];
        }
        entryMemo = `${kind === "exercise" ? (schedule ? "Early exercise" : "Exercise") : "Settlement"} of ${units} units of ${security.securityNumber}`;
        break;
      }
      case "forfeit":
      case "expire":
      case "cancel": {
        if (convertible) {
          assertConvertibleOutstanding();
          const settlement = await settleConvertible({ orgId: input.orgId, subsidiaryId, actorId: input.actorId, book, security, on: effectiveOn, functional, eventId });
          const policy = await resolveAccountPolicy(db, input.orgId, subsidiaryId, effectiveOn);
          legs = [...settlement.legs, { accountId: policy.apicAccountId, units: -settlement.settlementUnits }];
          recordSettlement(settlement);
          entryMemo = `Cancellation of ${security.securityNumber}`;
          break;
        }
        const units = quantity();
        const state = holdingState(book, security, effectiveOn);
        const available = kind === "forfeit" ? state.exact.unvested : kind === "expire" ? state.exact.vestedAvailable : state.exact.outstanding;
        const ceiling = eventCeiling(book, security, available, effectiveOn);
        if (units > ceiling) {
          const what = kind === "forfeit" ? "unvested" : kind === "expire" ? "vested and unexercised" : "outstanding";
          refuse(`Only ${ceiling} units are ${what} on ${effectiveOn}.`, `Record no more than ${ceiling} units.`, { field: "quantity", status: 409, code: "equity_event_exceeds_holding" });
        }
        event.quantity = units;
        break;
      }
      case "repurchase": {
        const units = quantity();
        const state = holdingState(book, security, effectiveOn);
        const ceiling = eventCeiling(book, security, state.exact.outstanding, effectiveOn);
        if (units > ceiling) refuse(`Only ${ceiling} shares are outstanding on ${effectiveOn}.`, `Repurchase no more than ${ceiling} shares.`, { field: "quantity", status: 409, code: "equity_event_exceeds_holding" });
        const source = earlyExerciseSource(book, security);
        const unvested = eventCeiling(book, security, state.exact.unvested, effectiveOn);
        event.quantity = units;
        if (source && unvested > 0n) {
          if (units > unvested) {
            refuse(`${unvested} of the shares are unvested on ${effectiveOn}; the company repurchases them on the grant's terms.`, `Repurchase the ${unvested} unvested shares first, then record a separate repurchase of vested shares.`, { field: "quantity", status: 409, code: "equity_restricted_repurchase_mixed" });
          }
          const basis = source.unvestedRepurchaseBasis;
          if (!basis) refuse(`Grant ${source.securityNumber} does not record the repurchase price of unvested shares.`, "Record the repurchase price basis on the grant's terms before repurchasing unvested shares.", { status: 409, code: "equity_repurchase_terms_missing" });
          const cost = restatePrice(book.splits, shareClass!.id, parsePrice(security.pricePerShare ?? "0", "the exercise price"), security.issueDate, effectiveOn);
          const fmvText = typeof input.fairMarketValuePerShare === "string" && input.fairMarketValuePerShare.trim() !== "" ? input.fairMarketValuePerShare.trim() : null;
          if (basis === "lower_of_cost_or_fmv" && !fmvText) {
            refuse("Enter the fair market value per share on the repurchase date.", "The grant repurchases unvested shares at the lower of cost and fair market value; enter the fair market value.", { field: "fairMarketValuePerShare" });
          }
          const fmv = fmvText ? parsePrice(fmvText, "the fair market value per share") : null;
          if (fmv && fmv.numerator < 0n) refuse("The fair market value cannot be negative.", "Enter the fair market value per share.", { field: "fairMarketValuePerShare" });
          const price: Rational = basis === "lower_of_cost_or_fmv" ? minRational(cost, fmv!) : cost;
          const paidTxn = ledgerUnits(multiplyRational(price, rational(units)), securityExponent);
          if (input.amount && ledgerUnits(parseMoney(input.amount, "the amount paid"), securityExponent) !== paidTxn) {
            refuse(`The grant prices this repurchase at ${formatLedger(paidTxn)} ${security.currency}.`, "Clear the amount; the repurchase price follows the grant's terms.", { field: "amount", status: 409, code: "equity_repurchase_price_fixed" });
          }
          const fxRate = paidTxn > 0n ? await rateOn(effectiveOn) : "1";
          const paid = functionalUnits(paidTxn, fxRate);
          const range = repurchasedRange(book, security, units, effectiveOn);
          const deposit = depositSlice(security, range.from, range.to, securityExponent);
          const account = paidTxn > 0n ? await requireConsiderationAccount(db, input.orgId, input.considerationAccountId) : null;
          const held = await instrumentBalance(db, input.orgId, subsidiaryId, security.id, "deposit");
          if (deposit > 0n && held.length !== 1) {
            refuse(`The early-exercise deposit of ${security.securityNumber} is not on the ledger.`, "Review the exercise entry in the journal; the deposit is credited by the exercise and released by the compensation run.", { status: 409, code: "equity_deposit_unreconciled" });
          }
          const policy = await resolveAccountPolicy(db, input.orgId, subsidiaryId, effectiveOn);
          legs = [
            ...(deposit > 0n ? [{ accountId: held[0]!.accountId, units: deposit, balance: { securityId: security.id, role: "deposit" as const } }] : []),
            ...(account ? [{ accountId: account, units: -paid, foreign: foreignLeg(-paidTxn, fxRate) }] : []),
            { accountId: policy.apicAccountId, units: paid - deposit },
          ];
          event.amount = formatLedger(paidTxn);
          event.pricePerShare = formatPrice(price);
          event.fairMarketValue = fmv ? formatPrice(fmv) : null;
          event.depositAmount = formatLedger(deposit);
          event.considerationAccountId = account;
          event.fxRate = foreign && paidTxn > 0n ? fxRate : null;
          entryMemo = `Repurchase of ${units} unvested shares of ${security.securityNumber}`;
          break;
        }
        const paidTxn = input.amount ? ledgerUnits(parseMoney(input.amount, "the amount paid"), securityExponent) : 0n;
        if (paidTxn < 0n) refuse("The amount paid cannot be negative.", "Enter the cash paid for the shares.", { field: "amount" });
        const fxRate = paidTxn > 0n ? await rateOn(effectiveOn) : "1";
        const paid = functionalUnits(paidTxn, fxRate);
        const account = paidTxn > 0n ? await requireConsiderationAccount(db, input.orgId, input.considerationAccountId) : null;
        event.amount = formatLedger(paidTxn);
        event.pricePerShare = formatPrice(divideRational(rational(paidTxn, 10_000n), rational(units)));
        event.considerationAccountId = account;
        event.fxRate = foreign && paidTxn > 0n ? fxRate : null;
        if (paidTxn > 0n) {
          const policy = await resolveAccountPolicy(db, input.orgId, subsidiaryId, effectiveOn);
          legs = [{ accountId: policy.treasuryStockAccountId, units: paid }, { accountId: account!, units: -paid, foreign: foreignLeg(-paidTxn, fxRate) }];
        }
        entryMemo = `Repurchase of ${units} shares of ${security.securityNumber}`;
        break;
      }
      case "transfer": {
        const units = quantity();
        const transferee = input.transfereePartyId ?? "";
        await requireHolder(db, input.orgId, transferee, "transfereePartyId");
        if (transferee === security.holderPartyId) refuse("The transferee is already the holder.", "Choose a different holder.", { field: "transfereePartyId" });
        const state = holdingState(book, security, effectiveOn);
        const ceiling = eventCeiling(book, security, state.exact.vestedAvailable, effectiveOn);
        if (units > ceiling) refuse(`Only ${ceiling} vested units can be transferred on ${effectiveOn}.`, `Transfer no more than ${ceiling} units.`, { field: "quantity", status: 409, code: "equity_event_exceeds_vested" });
        const restatedPrice = security.pricePerShare && shareClass
          ? formatPrice(restatePrice(book.splits, shareClass.id, parsePrice(security.pricePerShare, "the price"), security.issueDate, effectiveOn))
          : null;
        resulting = certificate(security, {
          id: await newEquityId(db),
          kind: security.kind,
          securityNumber: nextSecurityNumber(book, security.kind, shareClass),
          issueDate: effectiveOn,
          quantity: units,
          holderPartyId: transferee,
          pricePerShare: restatedPrice,
          expirationDate: security.kind === "warrant" ? security.expirationDate : null,
        }, base);
        event.quantity = units;
        break;
      }
      case "convert": {
        if (security.kind === "share") {
          if (!shareClass || shareClass.kind !== "preferred") refuse("Only preferred shares convert into common.", "Choose a preferred share certificate.", { field: "kind" });
          const named = conversionClassOf(book, shareClass!, effectiveOn);
          const targetId = input.targetShareClassId ?? named;
          const target = book.classes.find((row) => row.id === targetId);
          if (!target || target.kind !== "common") refuse("Choose the common class the shares convert into.", "Choose a common class of the legal entity.", { field: "targetShareClassId" });
          if (named && target!.id !== named) {
            refuse(`Class ${shareClass!.code} converts into ${book.classes.find((row) => row.id === named)?.code ?? "its conversion class"}.`, "Convert into the class's conversion class, or amend the conversion class first (an approval).", { field: "targetShareClassId", status: 409 });
          }
          if (effectiveOn < target!.effectiveOn) refuse(`Class ${target!.code} is not effective until ${target!.effectiveOn}.`, `Date the conversion on or after ${target!.effectiveOn}.`, { field: "effectiveOn" });
          const units = quantity();
          const state = holdingState(book, security, effectiveOn);
          const ceiling = eventCeiling(book, security, state.exact.vestedAvailable, effectiveOn);
          if (units > ceiling) refuse(`Only ${ceiling} shares can convert on ${effectiveOn}.`, `Convert no more than ${ceiling} shares.`, { field: "quantity", status: 409, code: "equity_event_exceeds_holding" });
          const commonShares = floorShares(multiplyRational(rational(units), conversionRatio(book, shareClass!, effectiveOn)));
          if (commonShares <= 0n) refuse("The shares convert into less than one common share.", "Convert more shares.", { field: "quantity" });
          resulting = certificate(security, {
            id: await newEquityId(db),
            shareClassId: target!.id,
            securityNumber: nextSecurityNumber(book, "share", target!),
            issueDate: effectiveOn,
            quantity: commonShares,
            holderPartyId: security.holderPartyId,
          }, base);
          const preferredPar = parUnits(book, shareClass!, units, effectiveOn, functionalExponent);
          const commonPar = parUnits(book, target!, commonShares, effectiveOn, functionalExponent);
          if (preferredPar !== 0n || commonPar !== 0n) {
            const policy = await resolveAccountPolicy(db, input.orgId, subsidiaryId, effectiveOn);
            legs = [
              { accountId: policy.preferredStockAccountId, units: preferredPar },
              { accountId: policy.commonStockAccountId, units: -commonPar },
              { accountId: policy.apicAccountId, units: commonPar - preferredPar },
            ];
          }
          event.quantity = units;
          entryMemo = `Conversion of ${units} shares of ${security.securityNumber} into ${target!.code}`;
          break;
        }
        const round = book.rounds.find((row) => row.id === input.roundId);
        if (!round) refuse("Choose the round the instrument converts in.", "Choose a round of the legal entity.", { field: "roundId" });
        if (effectiveOn !== round!.closedOn) refuse(`The round closed on ${round!.closedOn}.`, `Date the conversion on ${round!.closedOn}.`, { field: "effectiveOn" });
        assertConvertibleOutstanding();
        const roundClass = book.classes.find((row) => row.id === round!.shareClassId)!;
        const rates = new Map<string, string>();
        const exponents = new Map<string, number>();
        for (const instrument of roundInstruments(book, round!.id)) {
          if (!rates.has(instrument.currency)) {
            rates.set(instrument.currency, await spotRate(db, input.orgId, instrument.currency, round!.currency, round!.closedOn, functional));
            exponents.set(instrument.currency, await currencyExponent(db, instrument.currency));
          }
        }
        const conversion = conversionAtRound(book, security, round!.id, { rates, exponents });
        if (conversion.shares <= 0n) refuse("The instrument converts into less than one share.", "Review the round price and the instrument's terms.", { status: 409 });
        const settlement = await settleConvertible({ orgId: input.orgId, subsidiaryId, actorId: input.actorId, book, security, on: effectiveOn, functional, eventId });
        if (ledgerUnits(conversion.amount, 4) !== settlement.principalTxnUnits + settlement.interestTxnUnits) {
          refuse(`The converting amount of ${security.securityNumber} does not match what the ledger carries.`, "Review the instrument's issuance and interest entries in the journal.", { status: 409, code: "equity_interest_unreconciled" });
        }
        const par = parUnits(book, roundClass, conversion.shares, effectiveOn, functionalExponent);
        if (settlement.settlementUnits < par) refuse("The conversion would issue shares below par value.", "Review the round price and the class's par value.", { status: 409, code: "equity_below_par" });
        const roundExponent = await currencyExponent(db, round!.currency);
        const roundRate = round!.currency === functional ? "1" : await spotRate(db, input.orgId, round!.currency, functional, effectiveOn, functional);
        resulting = certificate(security, {
          id: await newEquityId(db),
          shareClassId: roundClass.id,
          roundId: round!.id,
          securityNumber: nextSecurityNumber(book, "share", roundClass),
          issueDate: effectiveOn,
          quantity: conversion.shares,
          holderPartyId: security.holderPartyId,
          pricePerShare: formatPrice(conversion.price),
          considerationAmount: formatLedger(ledgerUnits(restate(conversion.amount, rates.get(security.currency)!), roundExponent)),
          currency: round!.currency,
          fxRate: roundRate,
        }, base);
        const policy = await resolveAccountPolicy(db, input.orgId, subsidiaryId, effectiveOn);
        legs = [
          ...settlement.legs,
          { accountId: roundClass.kind === "preferred" ? policy.preferredStockAccountId : policy.commonStockAccountId, units: -par },
          { accountId: policy.apicAccountId, units: -(settlement.settlementUnits - par) },
        ];
        recordSettlement(settlement);
        event.pricePerShare = formatPrice(conversion.price);
        event.roundId = round!.id;
        entryMemo = `Conversion of ${security.securityNumber} in ${round!.name}`;
        break;
      }
      case "repay": {
        assertConvertibleOutstanding();
        const paidTxn = ledgerUnits(parseMoney(input.amount ?? "", "the amount repaid"), securityExponent);
        if (paidTxn <= 0n) refuse("Enter the amount repaid.", "Enter the cash paid to the holder.", { field: "amount" });
        const account = await requireConsiderationAccount(db, input.orgId, input.considerationAccountId);
        const settlement = await settleConvertible({ orgId: input.orgId, subsidiaryId, actorId: input.actorId, book, security, on: effectiveOn, functional, eventId });
        const carrying = settlement.principalTxnUnits + settlement.interestTxnUnits;
        if (security.kind === "safe" && paidTxn !== carrying) {
          refuse(`A SAFE is repaid at its purchase amount (${formatLedger(carrying)} ${security.currency}).`, "Record the repayment at the purchase amount; record any settlement difference as a separate journal entry.", { field: "amount", status: 409, code: "equity_repayment_amount" });
        }
        const paid = functionalUnits(paidTxn, settlement.fxRate);
        legs = [...settlement.legs, { accountId: account, units: -paid, foreign: foreignLeg(-paidTxn, settlement.fxRate) }];
        if (paid !== settlement.settlementUnits) {
          // A note repaid above or below its carrying amount: the premium or discount is interest.
          const policy = await resolveAccountPolicy(db, input.orgId, subsidiaryId, effectiveOn);
          legs.push({ accountId: requirePolicyAccount(policy, "interestExpenseAccountId"), units: paid - settlement.settlementUnits, memo: `Repayment premium or discount on ${security.securityNumber}` });
        }
        recordSettlement(settlement);
        event.amount = formatLedger(paidTxn);
        event.considerationAccountId = account;
        entryMemo = `Repayment of ${security.securityNumber}`;
        break;
      }
      case "void": {
        const live = eventsOf(book, security.id, "9999-12-31");
        if (live.length > 0) {
          refuse(`Security ${security.securityNumber} has recorded activity and cannot be voided.`, "Void the certificates its events produced first, reverse its other events, or record a cancellation instead.", { status: 409, code: "equity_void_has_activity" });
        }
        const origin = book.events.find((row) => row.resultingSecurityId === security.id);
        const originRow = origin
          ? (await db.execute<{ journal_entry_id: string | null }>(sql`
              select journal_entry_id from equity_security_events where org_id = ${input.orgId} and id = ${origin.id}`)).rows[0]
          : undefined;
        const issued = (await db.execute<{ journal_entry_id: string | null }>(sql`
          select journal_entry_id from equity_securities where org_id = ${input.orgId} and id = ${security.id}`)).rows[0];
        const entryId = originRow?.journal_entry_id ?? issued?.journal_entry_id ?? null;
        if (entryId) {
          event.reversalEntryId = await reverseEquityEntry(db, {
            orgId: input.orgId, entryId, reversalDate: effectiveOn, memo: `Void of ${security.securityNumber}`,
            idempotencyKey: `equity:security:${security.id}:void`, actorId: input.actorId,
            auditChanges: { securityId: security.id, securityNumber: security.securityNumber, reason },
          });
        }
        break;
      }
      case "reverse": {
        const targetId = input.reversesEventId ?? "";
        const target = isUuid(targetId) ? book.events.find((row) => row.id === targetId && row.securityId === security.id) : undefined;
        if (!target) refuse("The event to reverse does not exist on this security.", "Choose an event from the security's history.", { status: 404, code: "equity_event_unknown", field: "reversesEventId" });
        if (!REVERSIBLE_EVENT_KINDS.includes(target!.kind)) {
          refuse(
            `A ${target!.kind} cannot be reversed.`,
            target!.kind === "void" || target!.kind === "reverse"
              ? "Voids and reversals are final; record the security or event again if it is still needed."
              : "Void the certificate the event produced instead; that undoes the event.",
            { status: 409, code: "equity_event_not_reversible" },
          );
        }
        if (book.events.some((row) => row.kind === "reverse" && row.reversesEventId === target!.id)) {
          refuse("The event is already reversed.", "Reload the security's history.", { status: 409, code: "equity_event_reversed" });
        }
        if (effectiveOn < target!.effectiveOn) refuse(`The reversal cannot precede the event it reverses (${target!.effectiveOn}).`, `Date the reversal on or after ${target!.effectiveOn}.`, { field: "effectiveOn" });
        if (target!.kind !== "election_83b") {
          const dependents = dependentEvents(book, security, target!);
          if (dependents.length > 0) {
            const named = dependents.map((row) => `${row.kind} on ${row.effectiveOn}${row.quantity !== null ? ` (${row.quantity})` : ""}`).join(", ");
            refuse(`Later activity on ${security.securityNumber} relies on the ${target!.kind} of ${target!.effectiveOn}: ${named}.`, "Reverse those events (or void the certificates they produced), latest first, then reverse this one.", { status: 409, code: "equity_reversal_has_dependents" });
          }
        }
        const targetRow = (await db.execute<{ journal_entry_id: string | null }>(sql`
          select journal_entry_id from equity_security_events where org_id = ${input.orgId} and id = ${target!.id}`)).rows[0];
        if (targetRow?.journal_entry_id) {
          event.reversalEntryId = await reverseEquityEntry(db, {
            orgId: input.orgId, entryId: targetRow.journal_entry_id, reversalDate: effectiveOn,
            memo: `Reversal of the ${target!.kind} of ${security.securityNumber} on ${target!.effectiveOn}`,
            idempotencyKey: `equity:event:${target!.id}:reverse`, actorId: input.actorId,
            auditChanges: { securityId: security.id, eventId: target!.id, reason },
          });
        }
        event.reversesEventId = target!.id;
        break;
      }
      case "election_83b": {
        if (!needs83b(security)) refuse(`Security ${security.securityNumber} has no vesting schedule, so no 83(b) election applies.`, "Record 83(b) elections on restricted stock only.", { status: 409, code: "equity_83b_not_applicable" });
        const deadline = election83bDeadline(security);
        if (effectiveOn > deadline) {
          refuse(`The 83(b) window for ${security.securityNumber} closed on ${deadline}.`, `An election must be filed within 30 days of ${security.issueDate}; record only an election filed on or before ${deadline}.`, { field: "effectiveOn", status: 409, code: "equity_83b_window_closed" });
        }
        const existing = liveElection(book, security, "9999-12-31");
        if (existing) refuse(`An 83(b) election filed on ${existing.effectiveOn} is already recorded.`, "Reverse the recorded election first if its date was entered in error.", { status: 409, code: "equity_83b_recorded" });
        break;
      }
    }

    const pending: EquityBook = {
      ...book,
      securities: resulting ? [...book.securities, securityRecordOf(resulting)] : book.securities,
      events: [...book.events, asRecord({ ...event, resultingSecurityId: resulting?.id ?? null })],
    };
    assertReplayable(pending, security.id);
    if (resulting?.shareClassId) assertWithinAuthorized(pending, resulting.shareClassId, effectiveOn);
    if (kind === "reverse" && security.shareClassId) {
      assertWithinAuthorized(pending, security.shareClassId, effectiveOn);
      const planId = security.planId ?? book.securities.find((row) => row.id === security.sourceSecurityId)?.planId ?? null;
      if (planId) assertPoolsCovered(pending, planId, effectiveOn);
    }
    if (legs.some((leg) => leg.units !== 0n)) {
      event.journalEntryId = await postEquityEntry(db, {
        orgId: input.orgId, subsidiaryId, currency: functional, postingDate: effectiveOn,
        entryNumberBase: `EQ-${security.securityNumber}-${kind.toUpperCase()}`, memo: entryMemo,
        idempotencyKey: `equity:event:${eventId}`, actorId: input.actorId, auditAction: `equity.${kind}`,
        auditChanges: { securityId: security.id, eventId }, legs,
      });
    }
    if (resulting) {
      await insertSecurity(db, resulting);
      event.resultingSecurityId = resulting.id;
    }
    await insertEvent(db, input.orgId, subsidiaryId, input.actorId, event);
    await writeEquityAudit(db, {
      orgId: input.orgId, table: "equity_securities", rowId: security.id, action: `equity.event.${kind}`, actorId: input.actorId,
      changes: {
        eventId, kind, effectiveOn, quantity: event.quantity, amount: event.amount, pricePerShare: event.pricePerShare,
        resultingSecurityId: event.resultingSecurityId, transfereePartyId: kind === "transfer" ? input.transfereePartyId : undefined,
        reversesEventId: event.reversesEventId, interestAmount: event.interestAmount, interestAccrued: event.interestAccruedAmount,
        depositAmount: event.depositAmount, fairMarketValue: event.fairMarketValue, fxRate: event.fxRate,
        journalEntryId: event.journalEntryId, reversalEntryId: event.reversalEntryId, accrualEntryId: event.interestAccrualEntryId, reason,
        before: { holderPartyId: security.holderPartyId }, after: resulting ? { resultingHolderPartyId: resulting.holderPartyId, resultingQuantity: resulting.quantity } : null,
      },
    });
    return {
      eventId, resultingSecurityId: event.resultingSecurityId, journalEntryId: event.journalEntryId, reversalEntryId: event.reversalEntryId,
      accrualEntryId: event.interestAccrualEntryId, replayed: false,
    };
  });
}
