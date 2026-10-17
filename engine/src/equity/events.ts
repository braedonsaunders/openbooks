/**
 * Security events: exercise, settlement, forfeiture, expiry, cancellation,
 * repurchase, transfer, conversion and void.
 *
 * Every event is validated by replaying the security's whole history with
 * the new event in place (see cap-table.ts), so a backdated event can never
 * leave a later one exceeding what the security held. Events that produce
 * shares write the resulting certificate; events that move money post
 * through the journal kernel first and record their entry:
 *   option exercise  Dr consideration, Dr paid-in capital (share-based)
 *                    / Cr share capital at par / Cr APIC
 *   warrant exercise Dr consideration / Cr share capital at par / Cr APIC
 *   RSU settlement   Dr paid-in capital (share-based) / Cr share capital / Cr APIC
 *   repurchase       Dr treasury stock / Cr consideration (cost method)
 *   SAFE or note     Dr convertible instruments (the converting amount)
 *   conversion       / Cr share capital at par / Cr APIC
 *   preferred to     Dr preferred stock at par / Cr common stock at par,
 *   common           the difference to APIC
 * The share-based paid-in capital reclassified on exercise or settlement is
 * the units' grant-date fair value: exercised and settled units are vested,
 * so their cost is fully attributed.
 *
 * A void corrects a security recorded in error: its issuance entry, or the
 * entry of the event that produced it, is reversed on the void date and the
 * originating event is undone (a voided exercise certificate returns its
 * units to the option). A security with later recorded activity is not
 * voided; the certificates that activity produced are voided first.
 *
 * Exercising, settling, forfeiting, expiring, cancelling, transferring and
 * converting are bookkeeping duties (equity.manage); repurchases and voids
 * are approvals (equity.approve).
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  buildCapTable,
  conversionRatio,
  convertibleState,
  convertibleTerms,
  eventCeiling,
  eventsOf,
  holdingState,
} from "./cap-table.ts";
import { convertAtRound, convertingAmount } from "./convertibles.ts";
import { EquityError } from "./errors.ts";
import { currencyExponent, requireReason, writeEquityAudit } from "./internal.ts";
import { postEquityEntry, requireConsiderationAccount, resolveAccountPolicy, reverseEquityEntry, type EquityLeg } from "./posting.ts";
import {
  divideRational,
  floorShares,
  formatPrice,
  ledgerUnits,
  multiplyRational,
  parseMoney,
  parsePrice,
  parseShares,
  rational,
  type Rational,
} from "./quantities.ts";
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
import { restatePrice, splitFactor } from "./splits.ts";
import { assertWithinAuthorized, inEquityCommand, requireDate, type EquityCommand } from "./structure.ts";
import type { EquityBook, SecurityEventKind, SecurityEventRecord, SecurityRecord } from "./types.ts";

export interface RecordEventInput extends EquityCommand {
  securityId: string;
  kind: SecurityEventKind;
  effectiveOn: string;
  quantity?: string | null;
  reason?: string | null;
  considerationAccountId?: string | null;
  /** Cash paid on a repurchase. */
  amount?: string | null;
  transfereePartyId?: string | null;
  /** The round a SAFE or note converts in. */
  roundId?: string | null;
  /** The common class preferred shares convert into. */
  targetShareClassId?: string | null;
  idempotencyKey?: string | null;
}

export interface RecordEventResult {
  eventId: string;
  resultingSecurityId: string | null;
  journalEntryId: string | null;
  reversalEntryId: string | null;
  replayed: boolean;
}

const APPROVAL_EVENTS: readonly SecurityEventKind[] = ["repurchase", "void"];
const REASON_REQUIRED: readonly SecurityEventKind[] = ["forfeit", "expire", "cancel", "repurchase", "void"];
const ALLOWED: Record<SecurityEventKind, readonly SecurityRecord["kind"][]> = {
  exercise: ["option", "warrant"],
  settle: ["rsu"],
  forfeit: ["option", "rsu"],
  expire: ["option", "warrant"],
  cancel: ["option", "rsu", "warrant"],
  repurchase: ["share"],
  transfer: ["share", "warrant"],
  convert: ["share", "safe", "note"],
  void: ["share", "option", "rsu", "warrant", "safe", "note"],
};

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
}

async function insertEvent(runner: SqlExecutor, orgId: string, subsidiaryId: string, actorId: string, row: EventInsert): Promise<void> {
  const inserted = (await runner.execute<{ id: string }>(sql`
    insert into equity_security_events (id, org_id, subsidiary_id, security_id, kind, effective_on, quantity, price_per_share, amount,
      resulting_security_id, round_id, consideration_account_id, journal_entry_id, reversal_entry_id, reason, idempotency_key, created_by)
    values (${row.id}, ${orgId}, ${subsidiaryId}, ${row.securityId}, ${row.kind}, ${row.effectiveOn}::date, ${row.quantity?.toString() ?? null}::bigint,
      ${row.pricePerShare}::numeric, ${row.amount}::numeric, ${row.resultingSecurityId}, ${row.roundId}, ${row.considerationAccountId},
      ${row.journalEntryId}, ${row.reversalEntryId}, ${row.reason}, ${row.idempotencyKey}, ${actorId})
    returning id`)).rows;
  if (inserted.length !== 1) throw new EquityError("The event was not saved.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
}

const asRecord = (row: EventInsert): SecurityEventRecord => ({
  id: row.id, securityId: row.securityId, kind: row.kind, effectiveOn: row.effectiveOn, quantity: row.quantity,
  pricePerShare: row.pricePerShare, amount: row.amount, resultingSecurityId: row.resultingSecurityId, roundId: row.roundId,
});

/** Replay every share-based security of the book to the end of time; any event that no longer fits refuses. */
function assertReplayable(book: EquityBook, securityId: string): void {
  const security = book.securities.find((row) => row.id === securityId);
  if (security && security.quantity !== null) holdingState(book, security, "9999-12-31");
}

/** A resulting certificate that inherits its source's terms except the ones the caller sets. */
function certificate(source: SecurityRecord, overrides: Partial<SecurityInsert> & Pick<SecurityInsert, "id" | "securityNumber" | "issueDate" | "quantity" | "holderPartyId">, base: { orgId: string; subsidiaryId: string; currency: string; actorId: string }): SecurityInsert {
  return {
    orgId: base.orgId, subsidiaryId: base.subsidiaryId, kind: "share", shareClassId: source.shareClassId, planId: null, roundId: null,
    sourceSecurityId: source.id, pricePerShare: null, considerationAmount: null, currency: base.currency, considerationAccountId: null,
    vestingStart: null, vestingMonths: null, cliffMonths: null, vestingFrequency: null, vestingTranches: null, acceleration: "none",
    accelerationPercent: null, expirationDate: null, optionType: null, earlyExercise: false, safeType: null, valuationCap: null,
    discountPercent: null, interestRatePercent: null, interestBasis: null, maturityDate: null, valuationMethod: null,
    valuationSharePrice: null, volatilityPercent: null, riskFreeRatePercent: null, expectedTermYears: null, dividendYieldPercent: null,
    fairValuePerUnit: null, expenseAttribution: null, memo: null, journalEntryId: null, idempotencyKey: null, actorId: base.actorId,
    ...overrides,
  };
}

/** Grant-date value of `quantity` units stated on `on`, as ledger units (exercised and settled units are fully attributed). */
function grantValueUnits(book: EquityBook, security: SecurityRecord, quantity: bigint, on: string, exponent: number): bigint {
  if (!security.fairValuePerUnit || !security.shareClassId) return 0n;
  const issueUnits = divideRational(rational(quantity), splitFactor(book.splits, security.shareClassId, security.issueDate, on));
  return ledgerUnits(multiplyRational(issueUnits, parsePrice(security.fairValuePerUnit, "the fair value per unit")), exponent);
}

/** The book as it stood before a round: its own investors' shares and its conversions taken out. */
function bookBeforeRound(book: EquityBook, roundId: string): EquityBook {
  const roundSecurities = new Set(book.securities.filter((row) => row.roundId === roundId).map((row) => row.id));
  return {
    ...book,
    securities: book.securities.filter((row) => !roundSecurities.has(row.id)),
    events: book.events.filter((event) => !(event.resultingSecurityId && roundSecurities.has(event.resultingSecurityId)) && !roundSecurities.has(event.securityId)),
  };
}

/** Shares a SAFE or note converts into at a round, measured with every instrument converting in it. */
export function conversionAtRound(book: EquityBook, security: SecurityRecord, roundId: string): { price: Rational; shares: bigint; amount: Rational; pricedBy: string } {
  const round = book.rounds.find((row) => row.id === roundId)!;
  const before = bookBeforeRound(book, roundId);
  const table = buildCapTable(before, round.closedOn);
  const instruments = before.securities
    .filter((row) => (row.kind === "safe" || row.kind === "note") && row.issueDate <= round.closedOn)
    .filter((row) => convertibleState(before, row, round.closedOn).status === "outstanding")
    .map((row) => {
      const terms = convertibleTerms(row);
      return { terms, amount: convertingAmount(terms, round.closedOn) };
    });
  if (!instruments.some((instrument) => instrument.terms.id === security.id)) {
    refuse("The instrument is not outstanding on the round's closing date.", "Check the instrument's issue date and history.", { status: 409 });
  }
  const { conversions } = convertAtRound(instruments, parsePrice(round.pricePerShare, "the round price"), BigInt(table.totals.fullyDiluted));
  const mine = conversions.find((conversion) => conversion.securityId === security.id)!;
  return { price: mine.price, shares: mine.shares, amount: mine.amount, pricedBy: mine.pricedBy };
}

/** Record one security event. */
export async function recordSecurityEvent(input: RecordEventInput): Promise<RecordEventResult> {
  const kind = input.kind;
  if (!(kind in ALLOWED)) refuse("Choose what happened to the security.", "Choose an event kind.", { field: "kind" });
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", "The event date");
  const reason = REASON_REQUIRED.includes(kind)
    ? requireReason(input.reason, `the ${kind}`)
    : typeof input.reason === "string" && input.reason.trim() !== "" ? input.reason.trim().slice(0, 2000) : null;
  const idempotencyKey = typeof input.idempotencyKey === "string" && input.idempotencyKey.trim() !== "" ? input.idempotencyKey.trim() : null;
  if (!isUuid(input.securityId)) refuse("The security does not exist.", "Choose a security.", { status: 404, code: "equity_security_unknown" });
  const located = await withOrgTransaction(input.orgId, async () => (await db.execute<{ subsidiary_id: string }>(sql`
    select subsidiary_id from equity_securities where org_id = ${input.orgId} and id = ${input.securityId}`)).rows[0]);
  if (!located) refuse("The security does not exist.", "Choose a security.", { status: 404, code: "equity_security_unknown" });
  const subsidiaryId = located!.subsidiary_id;
  const permission = APPROVAL_EVENTS.includes(kind) ? "equity.approve" : "equity.manage";
  return inEquityCommand({ ...input, subsidiaryId }, permission, async ({ book, currency }) => {
    if (idempotencyKey) {
      const existing = (await db.execute<{ id: string; security_id: string; kind: string; resulting_security_id: string | null; journal_entry_id: string | null; reversal_entry_id: string | null }>(sql`
        select id, security_id, kind, resulting_security_id, journal_entry_id, reversal_entry_id from equity_security_events
         where org_id = ${input.orgId} and idempotency_key = ${idempotencyKey}`)).rows[0];
      if (existing) {
        if (existing.security_id !== input.securityId || existing.kind !== kind) {
          throw new EquityError("This request key was already used for a different event.", { status: 409, code: "equity_idempotency_conflict", remedy: "Retry with a new request key." });
        }
        return { eventId: existing.id, resultingSecurityId: existing.resulting_security_id, journalEntryId: existing.journal_entry_id, reversalEntryId: existing.reversal_entry_id, replayed: true };
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
    const exponent = await currencyExponent(db, currency);
    const base = { orgId: input.orgId, subsidiaryId, currency, actorId: input.actorId };
    const eventId = await newEquityId(db);
    const event: EventInsert = {
      id: eventId, securityId: security.id, kind, effectiveOn, quantity: null, pricePerShare: null, amount: null, resultingSecurityId: null,
      roundId: null, considerationAccountId: null, journalEntryId: null, reversalEntryId: null, reason, idempotencyKey,
    };
    const shareClass = security.shareClassId ? book.classes.find((row) => row.id === security.shareClassId)! : null;
    const quantity = (): bigint => {
      const value = parseShares(input.quantity ?? "", "the quantity");
      if (value <= 0n) refuse("The quantity must be at least one share.", "Enter the quantity.", { field: "quantity" });
      return value;
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
        const ceiling = eventCeiling(book, security, state.exact.vestedAvailable, effectiveOn);
        if (units > ceiling) {
          refuse(`Only ${ceiling} units are vested and unexercised on ${effectiveOn}.`, `Record no more than ${ceiling} units; unvested units cannot be ${kind === "exercise" ? "exercised" : "settled"}.`, { field: "quantity", status: 409, code: "equity_event_exceeds_vested" });
        }
        const price = kind === "exercise" ? restatePrice(book.splits, shareClass!.id, parsePrice(security.pricePerShare, "the exercise price"), security.issueDate, effectiveOn) : rational(0n);
        const cash = ledgerUnits(multiplyRational(price, rational(units)), exponent);
        const reclass = security.kind === "warrant" ? 0n : grantValueUnits(book, security, units, effectiveOn, exponent);
        const par = parUnits(book, shareClass!, units, effectiveOn, exponent);
        if (cash + reclass < par) refuse("The shares would be issued below par value.", "Review the exercise price and the class's par value.", { status: 409, code: "equity_below_par" });
        const account = cash > 0n ? await requireConsiderationAccount(db, input.orgId, input.considerationAccountId) : null;
        resulting = certificate(security, {
          id: await newEquityId(db),
          securityNumber: nextSecurityNumber(book, "share", shareClass),
          issueDate: effectiveOn,
          quantity: units,
          holderPartyId: security.holderPartyId,
          pricePerShare: kind === "exercise" ? formatPrice(price) : null,
          considerationAmount: cash > 0n ? formatLedger(cash) : null,
          considerationAccountId: account,
        }, base);
        event.quantity = units;
        event.pricePerShare = kind === "exercise" ? formatPrice(price) : null;
        event.amount = kind === "exercise" ? formatLedger(cash) : null;
        event.considerationAccountId = account;
        if (cash + reclass > 0n) {
          const policy = await resolveAccountPolicy(db, input.orgId, subsidiaryId, effectiveOn);
          legs = [
            ...(account ? [{ accountId: account, units: cash }] : []),
            { accountId: policy.apicShareBasedAccountId, units: reclass },
            { accountId: shareClass!.kind === "preferred" ? policy.preferredStockAccountId : policy.commonStockAccountId, units: -par },
            { accountId: policy.apicAccountId, units: -(cash + reclass - par) },
          ];
        }
        entryMemo = `${kind === "exercise" ? "Exercise" : "Settlement"} of ${units} units of ${security.securityNumber}`;
        break;
      }
      case "forfeit":
      case "expire":
      case "cancel": {
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
        const paid = input.amount ? ledgerUnits(parseMoney(input.amount, "the amount paid"), exponent) : 0n;
        if (paid < 0n) refuse("The amount paid cannot be negative.", "Enter the cash paid for the shares.", { field: "amount" });
        const account = paid > 0n ? await requireConsiderationAccount(db, input.orgId, input.considerationAccountId) : null;
        event.quantity = units;
        event.amount = formatLedger(paid);
        event.pricePerShare = formatPrice(divideRational(rational(paid, 10_000n), rational(units)));
        event.considerationAccountId = account;
        if (paid > 0n) {
          const policy = await resolveAccountPolicy(db, input.orgId, subsidiaryId, effectiveOn);
          legs = [{ accountId: policy.treasuryStockAccountId, units: paid }, { accountId: account!, units: -paid }];
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
          const target = book.classes.find((row) => row.id === input.targetShareClassId);
          if (!target || target.kind !== "common") refuse("Choose the common class the shares convert into.", "Choose a common class of the legal entity.", { field: "targetShareClassId" });
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
          const preferredPar = parUnits(book, shareClass!, units, effectiveOn, exponent);
          const commonPar = parUnits(book, target!, commonShares, effectiveOn, exponent);
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
        const roundClass = book.classes.find((row) => row.id === round!.shareClassId)!;
        const conversion = conversionAtRound(book, security, round!.id);
        if (conversion.shares <= 0n) refuse("The instrument converts into less than one share.", "Review the round price and the instrument's terms.", { status: 409 });
        const amountUnits = ledgerUnits(conversion.amount, exponent);
        const par = parUnits(book, roundClass, conversion.shares, effectiveOn, exponent);
        if (amountUnits < par) refuse("The conversion would issue shares below par value.", "Review the round price and the class's par value.", { status: 409, code: "equity_below_par" });
        resulting = certificate(security, {
          id: await newEquityId(db),
          shareClassId: roundClass.id,
          roundId: round!.id,
          securityNumber: nextSecurityNumber(book, "share", roundClass),
          issueDate: effectiveOn,
          quantity: conversion.shares,
          holderPartyId: security.holderPartyId,
          pricePerShare: formatPrice(conversion.price),
          considerationAmount: formatLedger(amountUnits),
        }, base);
        const policy = await resolveAccountPolicy(db, input.orgId, subsidiaryId, effectiveOn);
        legs = [
          { accountId: policy.convertibleInstrumentsAccountId, units: amountUnits },
          { accountId: roundClass.kind === "preferred" ? policy.preferredStockAccountId : policy.commonStockAccountId, units: -par },
          { accountId: policy.apicAccountId, units: -(amountUnits - par) },
        ];
        event.pricePerShare = formatPrice(conversion.price);
        event.amount = formatLedger(amountUnits);
        event.roundId = round!.id;
        entryMemo = `Conversion of ${security.securityNumber} in ${round!.name}`;
        break;
      }
      case "void": {
        const live = eventsOf(book, security.id, "9999-12-31");
        if (live.length > 0) {
          refuse(`Security ${security.securityNumber} has recorded activity and cannot be voided.`, "Void the certificates its events produced first, or record a cancellation instead.", { status: 409, code: "equity_void_has_activity" });
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
    }

    const pending: EquityBook = {
      ...book,
      securities: resulting ? [...book.securities, securityRecordOf(resulting)] : book.securities,
      events: [...book.events, asRecord({ ...event, resultingSecurityId: resulting?.id ?? null })],
    };
    assertReplayable(pending, security.id);
    if (resulting?.shareClassId) assertWithinAuthorized(pending, resulting.shareClassId, effectiveOn);
    if (legs.some((leg) => leg.units !== 0n)) {
      event.journalEntryId = await postEquityEntry(db, {
        orgId: input.orgId, subsidiaryId, currency, postingDate: effectiveOn,
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
        journalEntryId: event.journalEntryId, reversalEntryId: event.reversalEntryId, reason,
        before: { holderPartyId: security.holderPartyId }, after: resulting ? { resultingHolderPartyId: resulting.holderPartyId, resultingQuantity: resulting.quantity } : null,
      },
    });
    return { eventId, resultingSecurityId: event.resultingSecurityId, journalEntryId: event.journalEntryId, reversalEntryId: event.reversalEntryId, replayed: false };
  });
}
