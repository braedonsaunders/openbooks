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
 * Every event is the equity.manage duty. Repurchases, repayments,
 * cancelling a SAFE or note, voids and reversals are governed actions: an
 * Equity action Flow may require approval before they apply (see
 * governance.ts).
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  conversionClassOf,
  conversionRatio,
  convertibleState,
  electionOnVoidedSource,
  eventCeiling,
  eventsOf,
  holdingState,
  reversedElections,
  vestingTermsOf,
} from "./cap-table.ts";
import { equityError, fig, type EquityTermName } from "./errors.ts";
import { functionalUnits, restate, spotRate } from "./fx.ts";
import { governEquityAction, type EquityAction, type GovernedStatus } from "./governance.ts";
import {
  currencyExponent,
  requireReason,
  writeEquityAudit,
  type ReasonSubject,
} from "./internal.ts";
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
import {
  earlyExerciseSchedule,
  earlyExerciseSource,
  election83bDeadline,
  liveElection,
  needs83b,
  depositSlice,
  repurchasedRange,
} from "./restricted-stock.ts";
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
import { vestingInstallments } from "./vesting.ts";
import {
  assertPoolsCovered,
  assertWithinAuthorized,
  inEquityCommand,
  requireDate,
  type EquityCommand,
} from "./structure.ts";
import {
  REVERSIBLE_EVENT_KINDS,
  type EquityBook,
  type SecurityEventKind,
  type SecurityEventRecord,
  type SecurityRecord,
} from "./types.ts";

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

/** An applied event. */
export interface AppliedEventResult {
  eventId: string;
  resultingSecurityId: string | null;
  journalEntryId: string | null;
  reversalEntryId: string | null;
  /** Interest accrued to the settlement date of a note, posted before the settlement. */
  accrualEntryId: string | null;
  replayed: boolean;
}

/**
 * The outcome of recording an event: applied (with its records), or, for a
 * governed event an Equity action Flow gates, awaiting approval (its records
 * are null until the request is approved).
 */
export interface RecordEventResult {
  status: GovernedStatus;
  /** The action request of a governed event; null for an ungoverned one. */
  requestId: string | null;
  eventId: string | null;
  resultingSecurityId: string | null;
  journalEntryId: string | null;
  reversalEntryId: string | null;
  accrualEntryId: string | null;
  replayed: boolean;
}

const REASON_REQUIRED = [
  "forfeit",
  "expire",
  "cancel",
  "repurchase",
  "void",
  "reverse",
] as const satisfies readonly (SecurityEventKind & ReasonSubject)[];

/** The reason subject of an event that must state why it was recorded, or null when a reason is optional. */
function reasonSubject(kind: SecurityEventKind): (typeof REASON_REQUIRED)[number] | null {
  return (REASON_REQUIRED as readonly SecurityEventKind[]).includes(kind)
    ? (kind as (typeof REASON_REQUIRED)[number])
    : null;
}

/** The date field the event form shows: an 83(b) election is dated by its filing. */
const eventDateTerm = (kind: SecurityEventKind): EquityTermName =>
  kind === "election_83b" ? "filedOn" : "effectiveOn";

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

/**
 * The governed action an event is, if any: money leaving the company and
 * corrections may need approval in Flows.
 */
export function governedEventAction(
  kind: SecurityEventKind,
  securityKind: SecurityRecord["kind"],
): EquityAction | null {
  if (kind === "void" || kind === "reverse" || kind === "repurchase" || kind === "repay")
    return kind;
  if (kind === "cancel" && (securityKind === "safe" || securityKind === "note"))
    return "cancel_convertible";
  return null;
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

async function insertEvent(
  runner: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
  actorId: string,
  row: EventInsert,
): Promise<void> {
  const inserted = await runner.execute<{ id: string }>(
    sql`
    insert into equity_security_events (id, org_id, subsidiary_id, security_id, kind, effective_on, quantity, price_per_share, amount,
      resulting_security_id, round_id, consideration_account_id, journal_entry_id, reversal_entry_id, reason, idempotency_key, created_by,
      reverses_event_id, interest_amount, interest_accrued_amount, interest_accrued_functional, interest_accrual_entry_id,
      deposit_amount, fair_market_value, fx_rate)
    values (${row.id}, ${orgId}, ${subsidiaryId}, ${row.securityId}, ${row.kind}, ${row.effectiveOn}::date, ${row.quantity?.toString() ?? null}::bigint,
      ${row.pricePerShare}::numeric, ${row.amount}::numeric, ${row.resultingSecurityId}, ${row.roundId}, ${row.considerationAccountId},
      ${row.journalEntryId}, ${row.reversalEntryId}, ${row.reason}, ${row.idempotencyKey}, ${actorId},
      ${row.reversesEventId}, ${row.interestAmount}::numeric, ${row.interestAccruedAmount}::numeric, ${row.interestAccruedFunctional}::numeric,
      ${row.interestAccrualEntryId}, ${row.depositAmount}::numeric, ${row.fairMarketValue}::numeric, ${row.fxRate}::numeric)
    returning id`,
    "objects",
  );
  if (inserted.length !== 1) throw equityError("notSaved", { record: fig.choice("event") });
}

const asRecord = (row: EventInsert): SecurityEventRecord => ({
  id: row.id,
  securityId: row.securityId,
  kind: row.kind,
  effectiveOn: row.effectiveOn,
  quantity: row.quantity,
  pricePerShare: row.pricePerShare,
  amount: row.amount,
  resultingSecurityId: row.resultingSecurityId,
  roundId: row.roundId,
  reversesEventId: row.reversesEventId,
});

/** Replay every share-based security of the book to the end of time; any event that no longer fits refuses. */
function assertReplayable(book: EquityBook, securityId: string): void {
  const security = book.securities.find((row) => row.id === securityId);
  if (security && security.quantity !== null) holdingState(book, security, "9999-12-31");
}

/** A resulting certificate that inherits its source's terms except the ones the caller sets. */
function certificate(
  source: SecurityRecord,
  overrides: Partial<SecurityInsert> &
    Pick<SecurityInsert, "id" | "securityNumber" | "issueDate" | "quantity" | "holderPartyId">,
  base: { orgId: string; subsidiaryId: string; actorId: string },
): SecurityInsert {
  return {
    orgId: base.orgId,
    subsidiaryId: base.subsidiaryId,
    kind: "share",
    shareClassId: source.shareClassId,
    planId: null,
    roundId: null,
    sourceSecurityId: source.id,
    pricePerShare: null,
    considerationAmount: null,
    currency: source.currency,
    considerationAccountId: null,
    vestingStart: null,
    vestingMonths: null,
    cliffMonths: null,
    vestingFrequency: null,
    vestingTranches: null,
    acceleration: "none",
    accelerationPercent: null,
    expirationDate: null,
    optionType: null,
    earlyExercise: false,
    safeType: null,
    valuationCap: null,
    discountPercent: null,
    interestRatePercent: null,
    interestBasis: null,
    interestDayCount: null,
    maturityDate: null,
    mfn: false,
    unvestedRepurchaseBasis: null,
    fxRate: source.fxRate,
    valuationMethod: null,
    valuationSharePrice: null,
    volatilityPercent: null,
    riskFreeRatePercent: null,
    expectedTermYears: null,
    dividendYieldPercent: null,
    fairValuePerUnit: null,
    expenseAttribution: null,
    memo: null,
    journalEntryId: null,
    idempotencyKey: null,
    actorId: base.actorId,
    ...overrides,
  };
}

/** Grant-date value of `quantity` units stated on `on`, in functional ledger units (exercised and settled units are fully attributed). */
function grantValueUnits(
  book: EquityBook,
  security: SecurityRecord,
  quantity: bigint,
  on: string,
  exponent: number,
): bigint {
  if (!security.fairValuePerUnit || !security.shareClassId) return 0n;
  const issueUnits = divideRational(
    rational(quantity),
    splitFactor(book.splits, security.shareClassId, security.issueDate, on),
  );
  return ledgerUnits(
    restate(
      multiplyRational(issueUnits, parsePrice(security.fairValuePerUnit, "fairValuePerUnit")),
      security.fxRate,
    ),
    exponent,
  );
}

/** Live holding events of a security that a reversal of `target` would leave relying on a state that no longer holds. */
function dependentEvents(
  book: EquityBook,
  security: SecurityRecord,
  target: SecurityEventRecord,
): SecurityEventRecord[] {
  const order = new Map(book.events.map((event, index) => [event.id, index]));
  const targetIndex = order.get(target.id)!;
  return eventsOf(book, security.id, "9999-12-31").filter(
    (event) =>
      event.id !== target.id &&
      event.effectiveOn >= target.effectiveOn &&
      (order.get(event.id) ?? 0) > targetIndex,
  );
}

/**
 * Record one security event (equity.manage). A governed event is submitted
 * to any Equity action Flow and applies when no Flow gates it, or when its
 * gate approves.
 */
export async function recordSecurityEvent(input: RecordEventInput): Promise<RecordEventResult> {
  if (!isUuid(input.securityId)) throw equityError("securityUnknown");
  const located = await withOrgTransaction(
    input.orgId,
    async () =>
      (
        await db.execute<{
          subsidiary_id: string;
          kind: SecurityRecord["kind"];
          security_number: string;
          holder_name: string | null;
          class_code: string | null;
          currency: string;
        }>(
          sql`
    select s.subsidiary_id, s.kind, s.security_number, p.display_name as holder_name, c.code as class_code, s.currency
      from equity_securities s
      left join parties p on p.org_id = s.org_id and p.id = s.holder_party_id
      left join equity_share_classes c on c.org_id = s.org_id and c.id = s.share_class_id
     where s.org_id = ${input.orgId} and s.id = ${input.securityId}`,
          "objects",
        )
      )[0],
  );
  if (!located) throw equityError("securityUnknown");
  const action = input.kind in ALLOWED ? governedEventAction(input.kind, located!.kind) : null;
  if (!action) return { status: "applied", requestId: null, ...(await applySecurityEvent(input)) };
  // A reversal carries the figures of the event it undoes: what it restores is what an approver weighs.
  const reversed =
    input.kind === "reverse" &&
    typeof input.reversesEventId === "string" &&
    isUuid(input.reversesEventId)
      ? await withOrgTransaction(
          input.orgId,
          async () =>
            (
              await db.execute<{ quantity: string | null; amount: string | null }>(
                sql`
      select quantity::text as quantity, amount::text as amount from equity_security_events
       where org_id = ${input.orgId} and security_id = ${input.securityId} and id = ${input.reversesEventId}`,
                "objects",
              )
            )[0],
        )
      : undefined;
  const { orgId: _org, actorId: _actor, ...payload } = input;
  const outcome = await governEquityAction(
    {
      orgId: input.orgId,
      actorId: input.actorId,
      subsidiaryId: located!.subsidiary_id,
      action,
      subjectId: input.securityId,
      subjectLabel: located!.security_number,
      effectiveOn: requireDate(input.effectiveOn, "effectiveOn", eventDateTerm(input.kind)),
      reason:
        typeof input.reason === "string" && input.reason.trim() !== ""
          ? input.reason.trim().slice(0, 2000)
          : null,
      summary: {
        securityKind: located!.kind,
        holderName: located!.holder_name,
        shareClassCode: located!.class_code,
        quantity: input.quantity ?? reversed?.quantity ?? null,
        amount: input.amount ?? reversed?.amount ?? null,
        currency: located!.currency,
      },
      payload,
      idempotencyKey:
        typeof input.idempotencyKey === "string" && input.idempotencyKey.trim() !== ""
          ? `event:${input.idempotencyKey.trim()}`
          : null,
    },
    (actorId) => applySecurityEvent({ ...input, actorId }),
  );
  const result = outcome.result;
  return {
    status: outcome.status,
    requestId: outcome.requestId,
    eventId: result?.eventId ?? null,
    resultingSecurityId: result?.resultingSecurityId ?? null,
    journalEntryId: result?.journalEntryId ?? null,
    reversalEntryId: result?.reversalEntryId ?? null,
    accrualEntryId: result?.accrualEntryId ?? null,
    replayed: outcome.replayed || (result?.replayed ?? false),
  };
}

/** Apply one security event: the command a governed event's approval releases. */
export async function applySecurityEvent(input: RecordEventInput): Promise<AppliedEventResult> {
  const kind = input.kind;
  if (!(kind in ALLOWED)) throw equityError("eventKindMissing", {}, { field: "kind" });
  const effectiveOn = requireDate(input.effectiveOn, "effectiveOn", eventDateTerm(kind));
  const subject = reasonSubject(kind);
  const reason = subject
    ? requireReason(input.reason, subject)
    : typeof input.reason === "string" && input.reason.trim() !== ""
      ? input.reason.trim().slice(0, 2000)
      : null;
  const idempotencyKey =
    typeof input.idempotencyKey === "string" && input.idempotencyKey.trim() !== ""
      ? input.idempotencyKey.trim()
      : null;
  if (!isUuid(input.securityId)) throw equityError("securityUnknown");
  const located = await withOrgTransaction(
    input.orgId,
    async () =>
      (
        await db.execute<{ subsidiary_id: string; kind: SecurityRecord["kind"] }>(
          sql`
    select subsidiary_id, kind from equity_securities where org_id = ${input.orgId} and id = ${input.securityId}`,
          "objects",
        )
      )[0],
  );
  if (!located) throw equityError("securityUnknown");
  const subsidiaryId = located!.subsidiary_id;
  return inEquityCommand(
    { ...input, subsidiaryId },
    "equity.manage",
    async ({ book, currency: functional }) => {
      if (idempotencyKey) {
        const existing = (
          await db.execute<{
            id: string;
            security_id: string;
            kind: string;
            resulting_security_id: string | null;
            journal_entry_id: string | null;
            reversal_entry_id: string | null;
            interest_accrual_entry_id: string | null;
          }>(
            sql`
        select id, security_id, kind, resulting_security_id, journal_entry_id, reversal_entry_id, interest_accrual_entry_id from equity_security_events
         where org_id = ${input.orgId} and idempotency_key = ${idempotencyKey}`,
            "objects",
          )
        )[0];
        if (existing) {
          if (existing.security_id !== input.securityId || existing.kind !== kind) {
            throw equityError("idempotencyConflict", { subject: fig.choice("event") });
          }
          return {
            eventId: existing.id,
            resultingSecurityId: existing.resulting_security_id,
            journalEntryId: existing.journal_entry_id,
            reversalEntryId: existing.reversal_entry_id,
            accrualEntryId: existing.interest_accrual_entry_id,
            replayed: true,
          };
        }
      }
      // Pin the security row for the rest of the command.
      await db.execute(
        sql`select id from equity_securities where org_id = ${input.orgId} and id = ${input.securityId} for update`,
      );
      const security = book.securities.find((row) => row.id === input.securityId)!;
      if (!ALLOWED[kind].includes(security.kind)) {
        throw equityError(
          "eventNotApplicable",
          { event: fig.choice(kind), kind: fig.choice(security.kind) },
          { field: "kind" },
        );
      }
      if (book.events.some((event) => event.securityId === security.id && event.kind === "void")) {
        throw equityError("eventSecurityVoid", { security: fig.text(security.securityNumber) });
      }
      if (effectiveOn < security.issueDate)
        throw equityError(
          "eventBeforeIssue",
          { issueDate: fig.date(security.issueDate) },
          { field: "effectiveOn" },
        );
      const securityExponent = await currencyExponent(db, security.currency);
      const functionalExponent =
        security.currency === functional
          ? securityExponent
          : await currencyExponent(db, functional);
      const foreign = security.currency !== functional;
      const rateOn = async (date: string): Promise<string> =>
        foreign ? spotRate(db, input.orgId, security.currency, functional, date, functional) : "1";
      const foreignLeg = (txnUnits: bigint, fxRate: string) =>
        foreign ? { currency: security.currency, txnUnits, fxRate } : undefined;
      const base = { orgId: input.orgId, subsidiaryId, actorId: input.actorId };
      const eventId = await newEquityId(db);
      const event: EventInsert = {
        id: eventId,
        securityId: security.id,
        kind,
        effectiveOn,
        quantity: null,
        pricePerShare: null,
        amount: null,
        resultingSecurityId: null,
        roundId: null,
        considerationAccountId: null,
        journalEntryId: null,
        reversalEntryId: null,
        reason,
        idempotencyKey,
        reversesEventId: null,
        interestAmount: null,
        interestAccruedAmount: null,
        interestAccruedFunctional: null,
        interestAccrualEntryId: null,
        depositAmount: null,
        fairMarketValue: null,
        fxRate: null,
      };
      const shareClass = security.shareClassId
        ? book.classes.find((row) => row.id === security.shareClassId)!
        : null;
      const quantityTerm: EquityTermName = kind === "convert" ? "sharesToConvert" : "quantity";
      const quantity = (): bigint => {
        const value = parseShares(input.quantity ?? "", quantityTerm);
        if (value <= 0n)
          throw equityError(
            "eventQuantityNotPositive",
            { field: fig.term(quantityTerm) },
            { field: "quantity" },
          );
        return value;
      };
      const convertible = security.kind === "safe" || security.kind === "note";
      const assertConvertibleOutstanding = (): void => {
        const now = convertibleState(book, security, effectiveOn);
        const lifetime = convertibleState(book, security, "9999-12-31");
        if (now.status !== "outstanding" || lifetime.status !== "outstanding") {
          const state = now.status !== "outstanding" ? now : lifetime;
          throw equityError("convertibleNotOutstanding", {
            security: fig.text(security.securityNumber),
            status: fig.choice(state.status),
            date: fig.date(state.endedOn ?? effectiveOn),
          });
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
          if (
            kind === "exercise" &&
            security.expirationDate &&
            effectiveOn > security.expirationDate
          ) {
            throw equityError("exerciseAfterExpiry", {
              security: fig.text(security.securityNumber),
              date: fig.date(security.expirationDate),
            });
          }
          const state = holdingState(book, security, effectiveOn);
          const vestedCeiling = eventCeiling(
            book,
            security,
            state.exact.vestedAvailable,
            effectiveOn,
          );
          const early = kind === "exercise" && security.kind === "option" && security.earlyExercise;
          const ceiling = early
            ? eventCeiling(book, security, state.exact.outstanding, effectiveOn)
            : vestedCeiling;
          if (units > ceiling && ceiling === 0n && !early) {
            // Nothing is available yet: name when the schedule next vests, or that nothing more will.
            const installments = vestingInstallments(vestingTermsOf(security));
            const next =
              state.exact.outstanding.numerator > 0n
                ? installments.find((installment) => installment.date > effectiveOn)
                : undefined;
            const vestedBefore = installments.some(
              (installment) => installment.date <= effectiveOn,
            );
            const named = {
              security: fig.text(security.securityNumber),
              date: fig.date(effectiveOn),
            };
            if (next) {
              const figures = {
                ...named,
                nextVest: fig.date(next.date),
                field: fig.term("effectiveOn"),
              };
              throw vestedBefore
                ? equityError(
                    "nothingVestedUntilNext",
                    { ...figures, event: fig.choice(kind) },
                    { field: "effectiveOn" },
                  )
                : equityError("nothingVestedYet", figures, { field: "effectiveOn" });
            }
            throw equityError(
              "nothingVestedEver",
              { ...named, event: fig.choice(kind) },
              { field: "quantity" },
            );
          }
          if (units > ceiling) {
            throw early
              ? equityError(
                  "exerciseExceedsOutstanding",
                  { ceiling: fig.shares(ceiling), date: fig.date(effectiveOn) },
                  { field: "quantity" },
                )
              : equityError(
                  "exerciseExceedsVested",
                  {
                    ceiling: fig.shares(ceiling),
                    event: fig.choice(kind),
                    date: fig.date(effectiveOn),
                  },
                  { field: "quantity" },
                );
          }
          const schedule =
            early && units > vestedCeiling
              ? earlyExerciseSchedule(book, security, units, effectiveOn)
              : null;
          if (schedule && !security.unvestedRepurchaseBasis) {
            throw equityError(
              "earlyExerciseTermsMissing",
              { security: fig.text(security.securityNumber), ceiling: fig.shares(vestedCeiling) },
              { field: "quantity" },
            );
          }
          const price =
            kind === "exercise"
              ? restatePrice(
                  book.splits,
                  shareClass!.id,
                  parsePrice(security.pricePerShare, "exercisePrice"),
                  security.issueDate,
                  effectiveOn,
                )
              : rational(0n);
          const cashTxn = ledgerUnits(multiplyRational(price, rational(units)), securityExponent);
          // The certificate is measured at the exercise or settlement date's rate, whether or not cash changes hands.
          const fxRate = await rateOn(effectiveOn);
          const cash = functionalUnits(cashTxn, fxRate);
          const vestedUnits = schedule ? schedule.vestedOnIssue : units;
          const deposit = schedule
            ? cash -
              functionalUnits(
                ledgerUnits(multiplyRational(price, rational(vestedUnits)), securityExponent),
                fxRate,
              )
            : 0n;
          const reclass =
            security.kind === "warrant"
              ? 0n
              : grantValueUnits(book, security, vestedUnits, effectiveOn, functionalExponent);
          const par = parUnits(book, shareClass!, vestedUnits, effectiveOn, functionalExponent);
          const reclassAll =
            security.kind === "warrant"
              ? 0n
              : grantValueUnits(book, security, units, effectiveOn, functionalExponent);
          if (
            cash + reclassAll <
            parUnits(book, shareClass!, units, effectiveOn, functionalExponent)
          ) {
            throw equityError("exerciseBelowPar");
          }
          const account =
            cashTxn > 0n
              ? await requireConsiderationAccount(db, input.orgId, input.considerationAccountId)
              : null;
          const certificateId = await newEquityId(db);
          resulting = certificate(
            security,
            {
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
            },
            base,
          );
          event.quantity = units;
          event.pricePerShare = kind === "exercise" ? formatPrice(price) : null;
          event.amount = kind === "exercise" ? formatLedger(cashTxn) : null;
          event.considerationAccountId = account;
          event.depositAmount = schedule ? formatLedger(deposit) : null;
          event.fxRate = foreign && cashTxn > 0n ? fxRate : null;
          if (cash + reclass > 0n) {
            const policy = await resolveAccountPolicy(db, input.orgId, subsidiaryId, effectiveOn);
            legs = [
              ...(account
                ? [{ accountId: account, units: cash, foreign: foreignLeg(cashTxn, fxRate) }]
                : []),
              { accountId: policy.apicShareBasedAccountId, units: reclass },
              {
                accountId:
                  shareClass!.kind === "preferred"
                    ? policy.preferredStockAccountId
                    : policy.commonStockAccountId,
                units: -par,
              },
              { accountId: policy.apicAccountId, units: -(cash - deposit + reclass - par) },
              ...(deposit > 0n
                ? [
                    {
                      accountId: requirePolicyAccount(policy, "earlyExerciseDepositAccountId"),
                      units: -deposit,
                      balance: { securityId: certificateId, role: "deposit" as const },
                    },
                  ]
                : []),
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
            const settlement = await settleConvertible({
              orgId: input.orgId,
              subsidiaryId,
              actorId: input.actorId,
              book,
              security,
              on: effectiveOn,
              functional,
              eventId,
            });
            const policy = await resolveAccountPolicy(db, input.orgId, subsidiaryId, effectiveOn);
            legs = [
              ...settlement.legs,
              { accountId: policy.apicAccountId, units: -settlement.settlementUnits },
            ];
            recordSettlement(settlement);
            entryMemo = `Cancellation of ${security.securityNumber}`;
            break;
          }
          const units = quantity();
          const state = holdingState(book, security, effectiveOn);
          const available =
            kind === "forfeit"
              ? state.exact.unvested
              : kind === "expire"
                ? state.exact.vestedAvailable
                : state.exact.outstanding;
          const ceiling = eventCeiling(book, security, available, effectiveOn);
          if (units > ceiling) {
            throw equityError(
              "eventExceedsHolding",
              {
                ceiling: fig.shares(ceiling),
                event: fig.choice(kind),
                date: fig.date(effectiveOn),
              },
              { field: "quantity" },
            );
          }
          event.quantity = units;
          break;
        }
        case "repurchase": {
          const units = quantity();
          const state = holdingState(book, security, effectiveOn);
          const ceiling = eventCeiling(book, security, state.exact.outstanding, effectiveOn);
          if (units > ceiling)
            throw equityError(
              "repurchaseExceedsOutstanding",
              { ceiling: fig.shares(ceiling), date: fig.date(effectiveOn) },
              { field: "quantity" },
            );
          const source = earlyExerciseSource(book, security);
          const unvested = eventCeiling(book, security, state.exact.unvested, effectiveOn);
          event.quantity = units;
          if (source && unvested > 0n) {
            if (units > unvested) {
              throw equityError(
                "restrictedRepurchaseMixed",
                { ceiling: fig.shares(unvested), date: fig.date(effectiveOn) },
                { field: "quantity" },
              );
            }
            const basis = source.unvestedRepurchaseBasis;
            if (!basis)
              throw equityError("restrictedRepurchaseTermsMissing", {
                grant: fig.text(source.securityNumber),
                field: fig.term("unvestedRepurchaseBasis"),
              });
            const cost = restatePrice(
              book.splits,
              shareClass!.id,
              parsePrice(security.pricePerShare ?? "0", "exercisePrice"),
              security.issueDate,
              effectiveOn,
            );
            const fmvText =
              typeof input.fairMarketValuePerShare === "string" &&
              input.fairMarketValuePerShare.trim() !== ""
                ? input.fairMarketValuePerShare.trim()
                : null;
            if (basis === "lower_of_cost_or_fmv" && !fmvText) {
              throw equityError(
                "repurchaseFairValueMissing",
                { field: fig.term("fairMarketValuePerShare") },
                { field: "fairMarketValuePerShare" },
              );
            }
            const fmv = fmvText ? parsePrice(fmvText, "fairMarketValuePerShare") : null;
            if (fmv && fmv.numerator < 0n)
              throw equityError(
                "repurchaseFairValueNegative",
                { field: fig.term("fairMarketValuePerShare") },
                { field: "fairMarketValuePerShare" },
              );
            const price: Rational =
              basis === "lower_of_cost_or_fmv" ? minRational(cost, fmv!) : cost;
            const paidTxn = ledgerUnits(multiplyRational(price, rational(units)), securityExponent);
            if (
              input.amount &&
              ledgerUnits(parseMoney(input.amount, "amountPaid"), securityExponent) !== paidTxn
            ) {
              throw equityError(
                "repurchasePriceFixed",
                {
                  amount: fig.money(formatLedger(paidTxn), security.currency),
                  field: fig.term("amountPaid"),
                },
                { field: "amount" },
              );
            }
            const fxRate = paidTxn > 0n ? await rateOn(effectiveOn) : "1";
            const paid = functionalUnits(paidTxn, fxRate);
            const range = repurchasedRange(book, security, units, effectiveOn);
            const deposit = depositSlice(security, range.from, range.to, securityExponent);
            const account =
              paidTxn > 0n
                ? await requireConsiderationAccount(db, input.orgId, input.considerationAccountId)
                : null;
            const held = await instrumentBalance(
              db,
              input.orgId,
              subsidiaryId,
              security.id,
              "deposit",
            );
            if (deposit > 0n && held.length !== 1) {
              throw equityError("earlyExerciseDepositUnreconciled", {
                security: fig.text(security.securityNumber),
              });
            }
            const policy = await resolveAccountPolicy(db, input.orgId, subsidiaryId, effectiveOn);
            legs = [
              ...(deposit > 0n
                ? [
                    {
                      accountId: held[0]!.accountId,
                      units: deposit,
                      balance: { securityId: security.id, role: "deposit" as const },
                    },
                  ]
                : []),
              ...(account
                ? [{ accountId: account, units: -paid, foreign: foreignLeg(-paidTxn, fxRate) }]
                : []),
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
          const paidTxn = input.amount
            ? ledgerUnits(parseMoney(input.amount, "amountPaid"), securityExponent)
            : 0n;
          if (paidTxn < 0n)
            throw equityError(
              "repurchaseAmountNegative",
              { field: fig.term("amountPaid") },
              { field: "amount" },
            );
          const fxRate = paidTxn > 0n ? await rateOn(effectiveOn) : "1";
          const paid = functionalUnits(paidTxn, fxRate);
          const account =
            paidTxn > 0n
              ? await requireConsiderationAccount(db, input.orgId, input.considerationAccountId)
              : null;
          event.amount = formatLedger(paidTxn);
          event.pricePerShare = formatPrice(
            divideRational(rational(paidTxn, 10_000n), rational(units)),
          );
          event.considerationAccountId = account;
          event.fxRate = foreign && paidTxn > 0n ? fxRate : null;
          if (paidTxn > 0n) {
            const policy = await resolveAccountPolicy(db, input.orgId, subsidiaryId, effectiveOn);
            legs = [
              { accountId: policy.treasuryStockAccountId, units: paid },
              { accountId: account!, units: -paid, foreign: foreignLeg(-paidTxn, fxRate) },
            ];
          }
          entryMemo = `Repurchase of ${units} shares of ${security.securityNumber}`;
          break;
        }
        case "transfer": {
          const units = quantity();
          const transferee = input.transfereePartyId ?? "";
          await requireHolder(db, input.orgId, transferee, "transfereePartyId");
          if (transferee === security.holderPartyId)
            throw equityError(
              "transfereeIsHolder",
              { field: fig.term("transferee") },
              { field: "transfereePartyId" },
            );
          const state = holdingState(book, security, effectiveOn);
          const ceiling = eventCeiling(book, security, state.exact.vestedAvailable, effectiveOn);
          if (units > ceiling)
            throw equityError(
              "transferExceedsVested",
              { ceiling: fig.shares(ceiling), date: fig.date(effectiveOn) },
              { field: "quantity" },
            );
          const restatedPrice =
            security.pricePerShare && shareClass
              ? formatPrice(
                  restatePrice(
                    book.splits,
                    shareClass.id,
                    parsePrice(security.pricePerShare, "price"),
                    security.issueDate,
                    effectiveOn,
                  ),
                )
              : null;
          resulting = certificate(
            security,
            {
              id: await newEquityId(db),
              kind: security.kind,
              securityNumber: nextSecurityNumber(book, security.kind, shareClass),
              issueDate: effectiveOn,
              quantity: units,
              holderPartyId: transferee,
              pricePerShare: restatedPrice,
              expirationDate: security.kind === "warrant" ? security.expirationDate : null,
            },
            base,
          );
          event.quantity = units;
          break;
        }
        case "convert": {
          if (security.kind === "share") {
            if (!shareClass || shareClass.kind !== "preferred")
              throw equityError("conversionNotPreferred", {}, { field: "kind" });
            const named = conversionClassOf(book, shareClass!, effectiveOn);
            const targetId = input.targetShareClassId ?? named;
            const target = book.classes.find((row) => row.id === targetId);
            if (!target || target.kind !== "common")
              throw equityError("conversionTargetMissing", {}, { field: "targetShareClassId" });
            if (named && target!.id !== named) {
              const conversionClass = book.classes.find((row) => row.id === named);
              throw conversionClass
                ? equityError(
                    "conversionClassMismatch",
                    {
                      shareClass: fig.text(shareClass!.code),
                      target: fig.text(conversionClass.code),
                    },
                    { field: "targetShareClassId" },
                  )
                : equityError(
                    "conversionClassMismatchUnnamed",
                    { shareClass: fig.text(shareClass!.code) },
                    { field: "targetShareClassId" },
                  );
            }
            if (effectiveOn < target!.effectiveOn)
              throw equityError(
                "conversionClassNotEffective",
                { shareClass: fig.text(target!.code), date: fig.date(target!.effectiveOn) },
                { field: "effectiveOn" },
              );
            const units = quantity();
            const state = holdingState(book, security, effectiveOn);
            const ceiling = eventCeiling(book, security, state.exact.vestedAvailable, effectiveOn);
            if (units > ceiling)
              throw equityError(
                "conversionExceedsHolding",
                { ceiling: fig.shares(ceiling), date: fig.date(effectiveOn) },
                { field: "quantity" },
              );
            const commonShares = floorShares(
              multiplyRational(rational(units), conversionRatio(book, shareClass!, effectiveOn)),
            );
            if (commonShares <= 0n)
              throw equityError("conversionBelowOneCommon", {}, { field: "quantity" });
            resulting = certificate(
              security,
              {
                id: await newEquityId(db),
                shareClassId: target!.id,
                securityNumber: nextSecurityNumber(book, "share", target!),
                issueDate: effectiveOn,
                quantity: commonShares,
                holderPartyId: security.holderPartyId,
              },
              base,
            );
            const preferredPar = parUnits(
              book,
              shareClass!,
              units,
              effectiveOn,
              functionalExponent,
            );
            const commonPar = parUnits(
              book,
              target!,
              commonShares,
              effectiveOn,
              functionalExponent,
            );
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
          if (!round) throw equityError("conversionRoundMissing", {}, { field: "roundId" });
          if (effectiveOn !== round!.closedOn)
            throw equityError(
              "conversionOffClosingDate",
              { round: fig.text(round!.name), date: fig.date(round!.closedOn) },
              { field: "effectiveOn" },
            );
          assertConvertibleOutstanding();
          // An election naming a void instrument's terms is reversed on the record before the SAFE converts.
          const relied = electionOnVoidedSource(book, security, effectiveOn);
          if (relied) {
            const source = book.securities.find(
              (row) => row.id === relied.election.sourceSecurityId,
            );
            throw equityError("conversionTermsVoid", {
              security: fig.text(security.securityNumber),
              electedOn: fig.date(relied.election.effectiveOn),
              source: fig.text(source?.securityNumber ?? relied.election.sourceSecurityId),
              voidedOn: fig.date(relied.sourceVoidedOn),
              closedOn: fig.date(round!.closedOn),
            });
          }
          const roundClass = book.classes.find((row) => row.id === round!.shareClassId)!;
          const rates = new Map<string, string>();
          const exponents = new Map<string, number>();
          for (const instrument of roundInstruments(book, round!.id)) {
            if (!rates.has(instrument.currency)) {
              rates.set(
                instrument.currency,
                await spotRate(
                  db,
                  input.orgId,
                  instrument.currency,
                  round!.currency,
                  round!.closedOn,
                  functional,
                ),
              );
              exponents.set(instrument.currency, await currencyExponent(db, instrument.currency));
            }
          }
          const conversion = conversionAtRound(book, security, round!.id, { rates, exponents });
          if (conversion.shares <= 0n) throw equityError("conversionBelowOneShare");
          const settlement = await settleConvertible({
            orgId: input.orgId,
            subsidiaryId,
            actorId: input.actorId,
            book,
            security,
            on: effectiveOn,
            functional,
            eventId,
          });
          if (
            ledgerUnits(conversion.amount, 4) !==
            settlement.principalTxnUnits + settlement.interestTxnUnits
          ) {
            throw equityError("convertingAmountUnreconciled", {
              security: fig.text(security.securityNumber),
            });
          }
          const par = parUnits(
            book,
            roundClass,
            conversion.shares,
            effectiveOn,
            functionalExponent,
          );
          if (settlement.settlementUnits < par) throw equityError("conversionBelowPar");
          const roundExponent = await currencyExponent(db, round!.currency);
          const roundRate =
            round!.currency === functional
              ? "1"
              : await spotRate(
                  db,
                  input.orgId,
                  round!.currency,
                  functional,
                  effectiveOn,
                  functional,
                );
          resulting = certificate(
            security,
            {
              id: await newEquityId(db),
              shareClassId: roundClass.id,
              roundId: round!.id,
              securityNumber: nextSecurityNumber(book, "share", roundClass),
              issueDate: effectiveOn,
              quantity: conversion.shares,
              holderPartyId: security.holderPartyId,
              pricePerShare: formatPrice(conversion.price),
              considerationAmount: formatLedger(
                ledgerUnits(
                  restate(conversion.amount, rates.get(security.currency)!),
                  roundExponent,
                ),
              ),
              currency: round!.currency,
              fxRate: roundRate,
            },
            base,
          );
          const policy = await resolveAccountPolicy(db, input.orgId, subsidiaryId, effectiveOn);
          legs = [
            ...settlement.legs,
            {
              accountId:
                roundClass.kind === "preferred"
                  ? policy.preferredStockAccountId
                  : policy.commonStockAccountId,
              units: -par,
            },
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
          const paidTxn = ledgerUnits(
            parseMoney(input.amount ?? "", "amountRepaid"),
            securityExponent,
          );
          if (paidTxn <= 0n)
            throw equityError(
              "repaymentAmountMissing",
              { field: fig.term("amountRepaid") },
              { field: "amount" },
            );
          const account = await requireConsiderationAccount(
            db,
            input.orgId,
            input.considerationAccountId,
          );
          const settlement = await settleConvertible({
            orgId: input.orgId,
            subsidiaryId,
            actorId: input.actorId,
            book,
            security,
            on: effectiveOn,
            functional,
            eventId,
          });
          const carrying = settlement.principalTxnUnits + settlement.interestTxnUnits;
          if (security.kind === "safe" && paidTxn !== carrying) {
            throw equityError(
              "safeRepaymentAmount",
              { amount: fig.money(formatLedger(carrying), security.currency) },
              { field: "amount" },
            );
          }
          const paid = functionalUnits(paidTxn, settlement.fxRate);
          legs = [
            ...settlement.legs,
            { accountId: account, units: -paid, foreign: foreignLeg(-paidTxn, settlement.fxRate) },
          ];
          if (paid !== settlement.settlementUnits) {
            // A note repaid above or below its carrying amount: the premium or discount is interest.
            const policy = await resolveAccountPolicy(db, input.orgId, subsidiaryId, effectiveOn);
            legs.push({
              accountId: requirePolicyAccount(policy, "interestExpenseAccountId"),
              units: paid - settlement.settlementUnits,
              memo: `Repayment premium or discount on ${security.securityNumber}`,
            });
          }
          recordSettlement(settlement);
          event.amount = formatLedger(paidTxn);
          event.considerationAccountId = account;
          entryMemo = `Repayment of ${security.securityNumber}`;
          break;
        }
        case "void": {
          // An MFN election that adopted this instrument's terms names them while it stands.
          const reversed = reversedElections(book, "9999-12-31");
          const adopting = book.securityAmendments.find(
            (row) =>
              row.kind === "mfn_election" &&
              row.sourceSecurityId === security.id &&
              !reversed.has(row.id),
          );
          if (adopting) {
            const safe = book.securities.find((row) => row.id === adopting.securityId)!;
            const settled = convertibleState(book, safe, "9999-12-31");
            const certificate = settled.resultingSecurityId
              ? book.securities.find((row) => row.id === settled.resultingSecurityId)
              : null;
            const named = {
              safe: fig.text(safe.securityNumber),
              security: fig.text(security.securityNumber),
              electedOn: fig.date(adopting.effectiveOn),
            };
            throw certificate
              ? equityError("voidMfnSourceConverted", {
                  ...named,
                  certificate: fig.text(certificate.securityNumber),
                  convertedOn: fig.date(settled.endedOn ?? effectiveOn),
                })
              : equityError("voidMfnSource", named);
          }
          const live = eventsOf(book, security.id, "9999-12-31");
          if (live.length > 0) {
            throw equityError("voidHasActivity", { security: fig.text(security.securityNumber) });
          }
          const origin = book.events.find((row) => row.resultingSecurityId === security.id);
          const originRow = origin
            ? (
                await db.execute<{
                  journal_entry_id: string | null;
                  interest_accrual_entry_id: string | null;
                }>(
                  sql`
              select journal_entry_id, interest_accrual_entry_id from equity_security_events where org_id = ${input.orgId} and id = ${origin.id}`,
                  "objects",
                )
              )[0]
            : undefined;
          const issued = (
            await db.execute<{ journal_entry_id: string | null }>(
              sql`
          select journal_entry_id from equity_securities where org_id = ${input.orgId} and id = ${security.id}`,
              "objects",
            )
          )[0];
          const entryId = originRow?.journal_entry_id ?? issued?.journal_entry_id ?? null;
          if (entryId) {
            event.reversalEntryId = await reverseEquityEntry(db, {
              orgId: input.orgId,
              entryId,
              reversalDate: effectiveOn,
              memo: `Void of ${security.securityNumber}`,
              idempotencyKey: `equity:security:${security.id}:void`,
              actorId: input.actorId,
              auditChanges: {
                securityId: security.id,
                securityNumber: security.securityNumber,
                reason,
              },
            });
          }
          if (originRow?.interest_accrual_entry_id) {
            const reversalEntryId = await reverseEquityEntry(db, {
              orgId: input.orgId,
              entryId: originRow.interest_accrual_entry_id,
              reversalDate: effectiveOn,
              memo: `Void of ${security.securityNumber} interest accrual`,
              idempotencyKey: `equity:security:${security.id}:void:interest-accrual`,
              actorId: input.actorId,
              auditChanges: { securityId: security.id, eventId: origin!.id, reason },
            });
            event.reversalEntryId ??= reversalEntryId;
          }
          break;
        }
        case "reverse": {
          const targetId = input.reversesEventId ?? "";
          const target = isUuid(targetId)
            ? book.events.find((row) => row.id === targetId && row.securityId === security.id)
            : undefined;
          if (!target) throw equityError("reversalTargetUnknown", {}, { field: "reversesEventId" });
          if (!REVERSIBLE_EVENT_KINDS.includes(target!.kind)) {
            throw target!.kind === "void" || target!.kind === "reverse"
              ? equityError("eventFinal", { event: fig.choice(target!.kind) })
              : equityError("eventNotReversible", { event: fig.choice(target!.kind) });
          }
          if (
            book.events.some((row) => row.kind === "reverse" && row.reversesEventId === target!.id)
          ) {
            throw equityError("eventAlreadyReversed");
          }
          if (effectiveOn < target!.effectiveOn)
            throw equityError(
              "reversalBeforeEvent",
              { date: fig.date(target!.effectiveOn) },
              { field: "effectiveOn" },
            );
          if (target!.kind !== "election_83b") {
            const dependents = dependentEvents(book, security, target!);
            if (dependents.length > 0) {
              const latest = dependents.at(-1)!;
              throw equityError("reversalHasDependents", {
                security: fig.text(security.securityNumber),
                event: fig.choice(target!.kind),
                date: fig.date(target!.effectiveOn),
                count: fig.count(dependents.length),
                latest: fig.choice(latest.kind),
                latestOn: fig.date(latest.effectiveOn),
              });
            }
          }
          const targetRow = (
            await db.execute<{
              journal_entry_id: string | null;
              interest_accrual_entry_id: string | null;
            }>(
              sql`
          select journal_entry_id, interest_accrual_entry_id from equity_security_events where org_id = ${input.orgId} and id = ${target!.id}`,
              "objects",
            )
          )[0];
          if (targetRow?.journal_entry_id) {
            event.reversalEntryId = await reverseEquityEntry(db, {
              orgId: input.orgId,
              entryId: targetRow.journal_entry_id,
              reversalDate: effectiveOn,
              memo: `Reversal of the ${target!.kind} of ${security.securityNumber} on ${target!.effectiveOn}`,
              idempotencyKey: `equity:event:${target!.id}:reverse`,
              actorId: input.actorId,
              auditChanges: { securityId: security.id, eventId: target!.id, reason },
            });
          }
          if (targetRow?.interest_accrual_entry_id) {
            const reversalEntryId = await reverseEquityEntry(db, {
              orgId: input.orgId,
              entryId: targetRow.interest_accrual_entry_id,
              reversalDate: effectiveOn,
              memo: `Reversal of the ${target!.kind} interest accrual on ${security.securityNumber} on ${target!.effectiveOn}`,
              idempotencyKey: `equity:event:${target!.id}:interest-accrual-reverse`,
              actorId: input.actorId,
              auditChanges: { securityId: security.id, eventId: target!.id, reason },
            });
            event.reversalEntryId ??= reversalEntryId;
          }
          event.reversesEventId = target!.id;
          break;
        }
        case "election_83b": {
          if (!needs83b(security))
            throw equityError("election83bNotApplicable", {
              security: fig.text(security.securityNumber),
            });
          const deadline = election83bDeadline(security);
          if (effectiveOn > deadline) {
            throw equityError(
              "election83bWindowClosed",
              {
                security: fig.text(security.securityNumber),
                deadline: fig.date(deadline),
                issueDate: fig.date(security.issueDate),
              },
              { field: "effectiveOn" },
            );
          }
          const existing = liveElection(book, security, "9999-12-31");
          if (existing)
            throw equityError("election83bRecorded", { date: fig.date(existing.effectiveOn) });
          break;
        }
      }

      const pending: EquityBook = {
        ...book,
        securities: resulting ? [...book.securities, securityRecordOf(resulting)] : book.securities,
        events: [
          ...book.events,
          asRecord({ ...event, resultingSecurityId: resulting?.id ?? null }),
        ],
      };
      assertReplayable(pending, security.id);
      if (resulting?.shareClassId)
        assertWithinAuthorized(pending, resulting.shareClassId, effectiveOn);
      if (kind === "reverse" && security.shareClassId) {
        assertWithinAuthorized(pending, security.shareClassId, effectiveOn, "reversal");
        const planId =
          security.planId ??
          book.securities.find((row) => row.id === security.sourceSecurityId)?.planId ??
          null;
        if (planId) assertPoolsCovered(pending, planId, effectiveOn);
      }
      if (legs.some((leg) => leg.units !== 0n)) {
        event.journalEntryId = await postEquityEntry(db, {
          orgId: input.orgId,
          subsidiaryId,
          currency: functional,
          postingDate: effectiveOn,
          entryNumberBase: `EQ-${security.securityNumber}-${kind.toUpperCase()}`,
          memo: entryMemo,
          idempotencyKey: `equity:event:${eventId}`,
          actorId: input.actorId,
          auditAction: `equity.${kind}`,
          auditChanges: { securityId: security.id, eventId },
          legs,
        });
      }
      if (resulting) {
        await insertSecurity(db, resulting);
        event.resultingSecurityId = resulting.id;
      }
      await insertEvent(db, input.orgId, subsidiaryId, input.actorId, event);
      await writeEquityAudit(db, {
        orgId: input.orgId,
        table: "equity_securities",
        rowId: security.id,
        action: `equity.event.${kind}`,
        actorId: input.actorId,
        changes: {
          eventId,
          kind,
          effectiveOn,
          quantity: event.quantity,
          amount: event.amount,
          pricePerShare: event.pricePerShare,
          resultingSecurityId: event.resultingSecurityId,
          transfereePartyId: kind === "transfer" ? input.transfereePartyId : undefined,
          reversesEventId: event.reversesEventId,
          interestAmount: event.interestAmount,
          interestAccrued: event.interestAccruedAmount,
          depositAmount: event.depositAmount,
          fairMarketValue: event.fairMarketValue,
          fxRate: event.fxRate,
          journalEntryId: event.journalEntryId,
          reversalEntryId: event.reversalEntryId,
          accrualEntryId: event.interestAccrualEntryId,
          reason,
          before: { holderPartyId: security.holderPartyId },
          after: resulting
            ? {
                resultingHolderPartyId: resulting.holderPartyId,
                resultingQuantity: resulting.quantity,
              }
            : null,
        },
      });
      return {
        eventId,
        resultingSecurityId: event.resultingSecurityId,
        journalEntryId: event.journalEntryId,
        reversalEntryId: event.reversalEntryId,
        accrualEntryId: event.interestAccrualEntryId,
        replayed: false,
      };
    },
  );
}
