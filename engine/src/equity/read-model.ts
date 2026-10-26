/**
 * Equity reads: the legal entities an actor can see, the cap table as of a
 * date, securities and their history, the capital structure, stakeholders,
 * scenario models and the stock compensation schedule. Every read checks
 * equity.read and the actor's reach to the legal entity in the engine, and
 * runs as one read-only snapshot so its figures agree with each other.
 */
import { sql } from "drizzle-orm";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  authorizedShares,
  buildCapTable,
  conversionClassOf,
  conversionPrice,
  convertibleState,
  effectiveConvertibleTerms,
  electionInForce,
  eventCeiling,
  holdingState,
  planPool,
  reversedElections,
  reversedEvents,
  vestingTermsOf,
  voidedSecurities,
  type CapTable,
  type HoldingState,
} from "./cap-table.ts";
import { cumulativeCompensation, isCompensatory, totalCompensation } from "./compensation.ts";
import {
  reviewRecordedConversion,
  roundConversionDrift,
  type ConversionDrift,
} from "./conversion-review.ts";
import type { RoundPricing } from "./round-conversion.ts";
import { equityError } from "./errors.ts";
import {
  assertEquityReadable,
  currencyExponent,
  loadLegalEntity,
  requireEquityReader,
  type LegalEntity,
} from "./internal.ts";
import { restate, spotRate } from "./fx.ts";
import { mfnCandidates, type MfnCandidate } from "./mfn.ts";
import {
  modelCurrencies,
  modelRoundFromBook,
  waterfallCurveFromBook,
  waterfallFromBook,
  type ExitScenario,
  type ModelRates,
  type RoundScenario,
} from "./models.ts";
import { instrumentBalance } from "./posting.ts";
import {
  floorShares,
  formatMoney,
  formatPrice,
  ledgerUnits,
  multiplyRational,
  parseMoney,
  parsePrice,
  rational,
} from "./quantities.ts";
import {
  earlyExerciseSource,
  election83bStatus,
  releasedUnits,
  restrictedPortion,
  unreleasedDeposit,
  type Election83b,
} from "./restricted-stock.ts";
import { accruedToDate } from "./settlement.ts";
import { toUnits } from "../money/money.ts";
import type { RoundModelResult } from "./round-model.ts";
import { bookBeforeRound } from "./round-conversion.ts";
import { formatLedger } from "./securities.ts";
import { restatePrice } from "./splits.ts";
import { roundPreMoneyDrift } from "./structure.ts";
import {
  applyRoundAmendments,
  EVENT_COLUMNS,
  loadEquityBook,
  loadRoundAmendments,
  SECURITY_COLUMNS,
  securityFromRow,
  type RoundAmendmentRecord,
} from "./store.ts";
import { REVERSIBLE_EVENT_KINDS, type EquityBook, type SecurityKind } from "./types.ts";
import { vestingInstallments } from "./vesting.ts";
import type { WaterfallResult } from "./waterfall.ts";

interface ReadInput {
  orgId: string;
  actorId: string;
}

async function snapshot<T>(orgId: string, work: () => Promise<T>): Promise<T> {
  await assertEquityReadable(orgId);
  return withOrgTransaction(orgId, work, { isolationLevel: "REPEATABLE READ", readOnly: true });
}

async function partyNames(orgId: string, ids: Iterable<string>): Promise<Record<string, string>> {
  const list = [...new Set(ids)].filter(isUuid);
  if (list.length === 0) return {};
  const rows = await db.execute<{ id: string; display_name: string }>(
    sql`
    select id, display_name from parties where org_id = ${orgId} and id = any(${`{${list.join(",")}}`}::uuid[])`,
    "objects",
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.display_name]));
}

/** Legal entities the actor can read equity for. */
export async function listEquityEntities(input: ReadInput): Promise<LegalEntity[]> {
  return snapshot(input.orgId, async () => {
    await requireEquityReader(db, input.orgId, input.actorId, null);
    const allowed = await actorAllowedSubsidiaryIds(db, input.orgId, input.actorId);
    const rows = await db.execute<{ id: string; name: string; currency: string | null }>(
      sql`
      select id, name, nullif(trim(base_currency), '') as currency from subsidiaries
       where org_id = ${input.orgId} and is_active and not is_elimination
       order by name, id`,
      "objects",
    );
    return rows
      .filter((row) => row.currency && (allowed === null || allowed.has(row.id)))
      .map((row) => ({ id: row.id, name: row.name, currency: row.currency! }));
  });
}

async function entityBook(
  input: ReadInput & { subsidiaryId: string },
): Promise<{ entity: LegalEntity; book: EquityBook }> {
  await requireEquityReader(db, input.orgId, input.actorId, input.subsidiaryId);
  const entity = await loadLegalEntity(db, input.orgId, input.subsidiaryId);
  return { entity, book: await loadEquityBook(db, input.orgId, input.subsidiaryId) };
}

export interface CapTableView {
  entity: LegalEntity;
  table: CapTable;
  parties: Record<string, string>;
  hasAccountPolicy: boolean;
}

/** The cap table of a legal entity as of a date. */
export async function loadCapTableView(
  input: ReadInput & { subsidiaryId: string; asOf: string },
): Promise<CapTableView> {
  return snapshot(input.orgId, async () => {
    const { entity, book } = await entityBook(input);
    const table = buildCapTable(book, input.asOf);
    const policy = (
      await db.execute<{ id: string }>(
        sql`
      select id from equity_account_policies where org_id = ${input.orgId} and subsidiary_id = ${input.subsidiaryId}
         and effective_from <= ${input.asOf}::date limit 1`,
        "objects",
      )
    )[0];
    return {
      entity,
      table,
      parties: await partyNames(input.orgId, [
        ...table.holders.map((row) => row.holderPartyId),
        ...table.convertibles.map((row) => row.holderPartyId),
      ]),
      hasAccountPolicy: Boolean(policy),
    };
  });
}

export interface SecurityRow {
  id: string;
  securityNumber: string;
  kind: SecurityKind;
  holderPartyId: string;
  holderName: string;
  shareClassCode: string | null;
  planCode: string | null;
  issueDate: string;
  status: string;
  quantity: string | null;
  outstanding: string | null;
  vested: string | null;
  price: string | null;
  principal: string | null;
  /** A SAFE's or note's principal still outstanding on the date: zero once it converted, was repaid, cancelled or voided. */
  outstandingAmount: string | null;
  /** The share certificate a SAFE or note converted into. */
  resultingSecurityId: string | null;
  resultingSecurityNumber: string | null;
  currency: string;
  /** Restricted stock's 83(b) election standing (null when none is called for). */
  election83b: Election83b | null;
}

/** Securities of a legal entity with their state as of a date. */
export async function listSecurities(
  input: ReadInput & {
    subsidiaryId: string;
    asOf: string;
    kind?: SecurityKind | null;
    holderPartyId?: string | null;
  },
): Promise<{ entity: LegalEntity; rows: SecurityRow[] }> {
  return snapshot(input.orgId, async () => {
    const { entity, book } = await entityBook(input);
    const table = buildCapTable(book, input.asOf);
    const holdings = new Map(table.holdings.map((row) => [row.securityId, row]));
    const convertibles = new Map(table.convertibles.map((row) => [row.securityId, row]));
    const classes = new Map(book.classes.map((row) => [row.id, row.code]));
    const plans = new Map(book.plans.map((row) => [row.id, row.code]));
    const numbers = new Map(book.securities.map((row) => [row.id, row.securityNumber]));
    const securities = book.securities.filter(
      (row) =>
        (!input.kind || row.kind === input.kind) &&
        (!input.holderPartyId || row.holderPartyId === input.holderPartyId),
    );
    const names = await partyNames(
      input.orgId,
      securities.map((row) => row.holderPartyId),
    );
    const rows = securities
      .map((security): SecurityRow => {
        const holding = holdings.get(security.id);
        const convertible = convertibles.get(security.id);
        return {
          id: security.id,
          securityNumber: security.securityNumber,
          kind: security.kind,
          holderPartyId: security.holderPartyId,
          holderName: names[security.holderPartyId] ?? "",
          shareClassCode: security.shareClassId
            ? (classes.get(security.shareClassId) ?? null)
            : null,
          planCode: security.planId ? (plans.get(security.planId) ?? null) : null,
          issueDate: security.issueDate,
          status: holding?.status ?? convertible?.status ?? "not_issued",
          quantity: security.quantity?.toString() ?? null,
          outstanding: holding?.outstanding ?? null,
          vested: holding?.vested ?? null,
          price: holding?.exercisePrice ?? security.pricePerShare,
          principal: convertible?.principal ?? null,
          outstandingAmount: convertible?.outstandingPrincipal ?? null,
          resultingSecurityId: convertible?.resultingSecurityId ?? null,
          resultingSecurityNumber: convertible?.resultingSecurityId
            ? (numbers.get(convertible.resultingSecurityId) ?? null)
            : null,
          currency: security.currency,
          election83b: election83bStatus(book, security, input.asOf),
        };
      })
      .sort((a, b) =>
        a.issueDate < b.issueDate
          ? 1
          : a.issueDate > b.issueDate
            ? -1
            : a.securityNumber < b.securityNumber
              ? -1
              : 1,
      );
    return { entity, rows };
  });
}

export interface SecurityDetail {
  entity: LegalEntity;
  asOf: string;
  security: Record<string, unknown>;
  holderName: string;
  shareClass: { id: string; code: string; name: string; kind: string } | null;
  plan: { id: string; code: string; name: string } | null;
  round: { id: string; name: string } | null;
  /** Whole-share counts travel as decimal strings: bigints do not serialize. */
  state: {
    status: HoldingState["status"];
    outstanding: string;
    vestedAvailable: string;
    unvested: string;
    consumed: Record<string, string>;
  } | null;
  convertible: {
    status: string;
    principal: string;
    accruedInterest: string;
    convertingAmount: string;
    endedOn: string | null;
    convertedOn: string | null;
    /** Principal still outstanding on the date: zero once converted, repaid, cancelled or voided. */
    outstanding: string;
    resultingSecurityId: string | null;
    resultingSecurityNumber: string | null;
    valuationCap: string | null;
    discountPercent: string | null;
    safeType: string | null;
    electionId: string | null;
    /** The terms the instrument was issued with, beside the terms in force. */
    issuedTerms: {
      valuationCap: string | null;
      discountPercent: string | null;
      safeType: string | null;
    };
    /**
     * A conversion that used terms an MFN election adopted from an
     * instrument since voided: the terms no longer stand, so the conversion
     * is corrected by voiding the certificate it produced and converting again.
     */
    invalidConversionTerms: {
      electionId: string;
      sourceSecurityId: string;
      sourceSecurityNumber: string;
      sourceVoidedOn: string;
    } | null;
    /**
     * A conversion on the terms that stand whose recorded price differs from
     * the price the round now gives them: activity recorded later and dated
     * before the round changed the count the conversion divided by. The
     * conversion stands as recorded; the round reports the same drift.
     */
    conversionDrift:
      | (ConversionDrift & {
          roundName: string;
          currency: string;
          resultingSecurityNumber: string | null;
        })
      | null;
  } | null;
  vesting: { date: string; quantity: string; cumulative: string }[];
  /**
   * Share-based payment cost: the full grant-date fair value of the units
   * granted, the cost expected once forfeitures to the date are taken out,
   * what is recognized through the date and what runs through it posted.
   */
  compensation: {
    grantDateValue: string;
    expectedAfterForfeitures: string;
    recognized: string;
    posted: string;
  } | null;
  /** Events as recorded; one whose resulting security was voided names that void (it is undone from then). */
  events: (Record<string, unknown> & {
    resulting_voided: { securityId: string; securityNumber: string; voidedOn: string } | null;
  })[];
  source: { id: string; securityNumber: string } | null;
  resulting: { id: string; securityNumber: string; holderName: string }[];
  exercisePrice: string | null;
  /** An MFN SAFE: later instruments whose better terms the holder may adopt, and the elections recorded. */
  mfn: {
    candidates: MfnCandidate[];
    /**
     * Elections and their reversals in date order: each election's adopted
     * terms beside the terms in force before it, whether it still stands on
     * the date, and why not (reversed, or its source voided).
     */
    elections: MfnElectionView[];
  } | null;
  /** Interest a note carries on the ledger (posted accruals, in its currency) beside what has accrued to the date. */
  interest: { posted: string; accrued: string } | null;
  /** An option that admits early exercise: units exercisable now, vested or not, and the unvested repurchase basis. */
  earlyExercise: { exercisable: string; vested: string; repurchaseBasis: string | null } | null;
  /** Restricted stock bought by early exercise: its source option, repurchase basis and deposit standing. */
  restricted: {
    sourceSecurityId: string;
    sourceSecurityNumber: string;
    repurchaseBasis: string | null;
    vestedOnIssue: string;
    restrictedShares: string;
    releasedShares: string;
    /** The certificate's deposit on the ledger as of the date: credited by the exercise, less what runs dated by then released. */
    depositHeld: string;
    /** The deposit the vesting schedule leaves held on the date: the cash paid for restricted shares not yet vested and still held. */
    depositUnvested: string;
  } | null;
  election83b: Election83b | null;
}

export interface MfnElectionView {
  id: string;
  kind: "mfn_election" | "mfn_reversal";
  effectiveOn: string;
  sourceSecurityId: string;
  sourceSecurityNumber: string;
  /** An election's adopted terms; a reversal's restored terms. */
  valuationCap: string | null;
  discountPercent: string | null;
  safeType: string;
  /** The terms in force immediately before the record. */
  before: { valuationCap: string | null; discountPercent: string | null; safeType: string | null };
  /** The election a reversal undid. */
  reversesAmendmentId: string | null;
  /** An election's standing on the date. */
  standing: "in_force" | "reversed" | "source_void" | "superseded" | null;
  reversedOn: string | null;
  reason: string;
}

/** One security with its state, schedule, cost and history. */
export async function loadSecurityDetail(
  input: ReadInput & { securityId: string; asOf: string },
): Promise<SecurityDetail> {
  if (!isUuid(input.securityId)) throw equityError("securityUnknown");
  return snapshot(input.orgId, async () => {
    const raw = (
      await db.execute<Record<string, unknown>>(
        sql`
      select ${SECURITY_COLUMNS} from equity_securities where org_id = ${input.orgId} and id = ${input.securityId}`,
        "objects",
      )
    )[0];
    if (!raw) throw equityError("securityUnknown");
    const subsidiaryId = String(raw.subsidiary_id);
    const { entity, book } = await entityBook({ ...input, subsidiaryId });
    const security = securityFromRow(raw);
    const exponent = await currencyExponent(db, entity.currency);
    const shareClass = security.shareClassId
      ? (book.classes.find((row) => row.id === security.shareClassId) ?? null)
      : null;
    const plan = security.planId
      ? (book.plans.find((row) => row.id === security.planId) ?? null)
      : null;
    const round = security.roundId
      ? (book.rounds.find((row) => row.id === security.roundId) ?? null)
      : null;
    const state = security.quantity !== null ? holdingState(book, security, input.asOf) : null;
    const convertible =
      security.kind === "safe" || security.kind === "note"
        ? convertibleState(book, security, input.asOf)
        : null;
    const reversed = reversedEvents(book, "9999-12-31");
    const reversalOf = new Map(
      book.events
        .filter((event) => event.kind === "reverse" && event.reversesEventId)
        .map((event) => [event.reversesEventId!, event.id]),
    );
    const numberOf = new Map(book.securities.map((row) => [row.id, row.securityNumber]));
    const voidedOn = new Map(
      book.events
        .filter((event) => event.kind === "void")
        .map((event) => [event.securityId, event.effectiveOn]),
    );
    const source83b = earlyExerciseSource(book, security);
    let restricted: SecurityDetail["restricted"] = null;
    if (source83b) {
      const portion = restrictedPortion(security);
      const held = await instrumentBalance(
        db,
        input.orgId,
        subsidiaryId,
        security.id,
        "deposit",
        input.asOf,
      );
      const certificateExponent = await currencyExponent(db, security.currency);
      restricted = {
        sourceSecurityId: source83b.id,
        sourceSecurityNumber: source83b.securityNumber,
        repurchaseBasis: source83b.unvestedRepurchaseBasis,
        vestedOnIssue: portion.vestedOnIssue.toString(),
        restrictedShares: portion.restricted.toString(),
        releasedShares: floorShares(releasedUnits(book, security, input.asOf)).toString(),
        depositHeld: formatLedger(-held.reduce((sum, group) => sum + group.units, 0n)),
        depositUnvested: formatLedger(
          unreleasedDeposit(book, security, input.asOf, certificateExponent),
        ),
      };
    }
    const eventRows = await db.execute<Record<string, unknown>>(
      sql`
      select ${EVENT_COLUMNS} from equity_security_events where org_id = ${input.orgId} and security_id = ${input.securityId}
       order by effective_on, created_at, id`,
      "objects",
    );
    const entryIds = [
      ...eventRows.flatMap((row) => [
        row.journal_entry_id,
        row.reversal_entry_id,
        row.interest_accrual_entry_id,
      ]),
      raw.journal_entry_id,
    ].filter((id): id is string => typeof id === "string");
    const entries =
      entryIds.length === 0
        ? []
        : await db.execute<{ id: string; entry_number: string; status: string }>(
            sql`
      select id, entry_number, status from journal_entries where org_id = ${input.orgId} and id = any(${`{${entryIds.join(",")}}`}::uuid[])`,
            "objects",
          );
    const entryNumbers = new Map(entries.map((row) => [row.id, row.entry_number]));
    const resulting = book.securities.filter((row) => row.sourceSecurityId === security.id);
    const names = await partyNames(input.orgId, [
      security.holderPartyId,
      ...resulting.map((row) => row.holderPartyId),
    ]);
    const source = security.sourceSecurityId
      ? (book.securities.find((row) => row.id === security.sourceSecurityId) ?? null)
      : null;
    let compensation: SecurityDetail["compensation"] = null;
    if (isCompensatory(security)) {
      const posted = (
        await db.execute<{ cumulative_amount: string }>(
          sql`
        select l.cumulative_amount::text as cumulative_amount from equity_compensation_run_lines l
          join equity_compensation_runs r on r.org_id = l.org_id and r.id = l.run_id
         where l.org_id = ${input.orgId} and l.security_id = ${security.id} and r.through_date <= ${input.asOf}::date
         order by r.through_date desc limit 1`,
          "objects",
        )
      )[0];
      const fairValue = parsePrice(security.fairValuePerUnit, "fairValuePerUnit");
      compensation = {
        grantDateValue: formatLedger(
          ledgerUnits(
            restate(
              multiplyRational(rational(security.quantity ?? 0n), fairValue),
              security.fxRate,
            ),
            exponent,
          ),
        ),
        expectedAfterForfeitures: formatLedger(
          ledgerUnits(
            restate(totalCompensation(book, security, input.asOf), security.fxRate),
            exponent,
          ),
        ),
        recognized: formatLedger(
          ledgerUnits(
            restate(cumulativeCompensation(book, security, input.asOf), security.fxRate),
            exponent,
          ),
        ),
        posted: posted?.cumulative_amount ?? "0.0000",
      };
    }
    const review = convertible
      ? await reviewRecordedConversion(db, input.orgId, book, security, input.asOf, entity.currency)
      : null;
    const onVoided = review?.voidedTerms ?? null;
    const driftRound = review?.drift
      ? (book.rounds.find((row) => row.id === review.drift!.roundId) ?? null)
      : null;
    const conversionDrift: NonNullable<SecurityDetail["convertible"]>["conversionDrift"] =
      review?.drift && driftRound
        ? {
            ...review.drift,
            roundName: driftRound.name,
            currency: driftRound.currency,
            resultingSecurityNumber: review.drift.resultingSecurityId
              ? (numberOf.get(review.drift.resultingSecurityId) ?? null)
              : null,
          }
        : null;
    const invalidConversionTerms: NonNullable<
      SecurityDetail["convertible"]
    >["invalidConversionTerms"] = onVoided
      ? {
          electionId: onVoided.electionId,
          sourceSecurityId: onVoided.sourceSecurityId,
          sourceSecurityNumber: numberOf.get(onVoided.sourceSecurityId) ?? "",
          sourceVoidedOn: onVoided.sourceVoidedOn,
        }
      : null;
    let mfn: SecurityDetail["mfn"] = null;
    if (security.kind === "safe" && security.mfn) {
      const records = book.securityAmendments.filter((row) => row.securityId === security.id);
      const reversedOn = new Map(
        records
          .filter((row) => row.kind === "mfn_reversal" && row.reversesAmendmentId)
          .map((row) => [row.reversesAmendmentId!, row.effectiveOn]),
      );
      const reversedNow = reversedElections(book, input.asOf);
      const voidedEver = voidedSecurities(book, "9999-12-31");
      const inForce = electionInForce(book, security, input.asOf);
      const reasons = new Map(
        (
          await db.execute<{ id: string; reason: string }>(
            sql`
        select id, reason from equity_security_amendments where org_id = ${input.orgId} and security_id = ${security.id}`,
            "objects",
          )
        ).map((row) => [row.id, row.reason]),
      );
      mfn = {
        candidates: mfnCandidates(book, security, input.asOf),
        elections: records.map((row, index): MfnElectionView => {
          // The terms in force just before this record as recorded (an election adopting a since-voided
          // instrument's terms included): the history without it and anything after it. A reversal
          // reverts from the terms its election adopted to those it restores.
          const prior = { ...book, securityAmendments: records.slice(0, index) };
          const { terms: before } = effectiveConvertibleTerms(prior, security, row.effectiveOn, {
            includeVoidedSources: true,
          });
          const standing: MfnElectionView["standing"] =
            row.kind !== "mfn_election" || row.effectiveOn > input.asOf
              ? null
              : reversedNow.has(row.id)
                ? "reversed"
                : voidedEver.has(row.sourceSecurityId)
                  ? "source_void"
                  : inForce?.id === row.id
                    ? "in_force"
                    : "superseded";
          return {
            id: row.id,
            kind: row.kind,
            effectiveOn: row.effectiveOn,
            sourceSecurityId: row.sourceSecurityId,
            sourceSecurityNumber: numberOf.get(row.sourceSecurityId) ?? "",
            valuationCap: row.valuationCap,
            discountPercent: row.discountPercent,
            safeType: row.safeType,
            before: {
              valuationCap: before.valuationCap,
              discountPercent: before.discountPercent,
              safeType: before.safeType,
            },
            reversesAmendmentId: row.reversesAmendmentId,
            standing,
            reversedOn: reversedOn.get(row.id) ?? null,
            reason: reasons.get(row.id) ?? "",
          };
        }),
      };
    }
    return {
      entity,
      asOf: input.asOf,
      security: {
        ...raw,
        quantity: security.quantity?.toString() ?? null,
        vesting_tranches:
          security.vestingTranches?.map((tranche) => ({
            date: tranche.date,
            quantity: tranche.quantity.toString(),
          })) ?? null,
      },
      holderName: names[security.holderPartyId] ?? "",
      shareClass: shareClass
        ? { id: shareClass.id, code: shareClass.code, name: shareClass.name, kind: shareClass.kind }
        : null,
      plan: plan ? { id: plan.id, code: plan.code, name: plan.name } : null,
      round: round ? { id: round.id, name: round.name } : null,
      state: state
        ? {
            status: state.status,
            outstanding: state.outstanding.toString(),
            vestedAvailable: state.vestedAvailable.toString(),
            unvested: state.unvested.toString(),
            consumed: Object.fromEntries(
              Object.entries(state.consumed).map(([key, value]) => [key, value.toString()]),
            ),
          }
        : null,
      convertible: convertible
        ? {
            status: convertible.status,
            principal: convertible.principal,
            accruedInterest: convertible.accruedInterest,
            convertingAmount: convertible.convertingAmount,
            endedOn: convertible.endedOn,
            convertedOn: convertible.convertedOn,
            outstanding: convertible.status === "outstanding" ? convertible.principal : "0.0000",
            resultingSecurityId: convertible.resultingSecurityId,
            resultingSecurityNumber: convertible.resultingSecurityId
              ? (numberOf.get(convertible.resultingSecurityId) ?? null)
              : null,
            valuationCap: convertible.terms.valuationCap,
            discountPercent: convertible.terms.discountPercent,
            safeType: convertible.terms.safeType,
            electionId: convertible.electionId,
            issuedTerms: {
              valuationCap: security.valuationCap,
              discountPercent: security.discountPercent,
              safeType: security.safeType,
            },
            invalidConversionTerms,
            conversionDrift,
          }
        : null,
      vesting:
        security.quantity !== null
          ? vestingInstallments(vestingTermsOf(security)).map((row) => ({
              date: row.date,
              quantity: row.quantity.toString(),
              cumulative: row.cumulative.toString(),
            }))
          : [],
      compensation,
      events: eventRows.map((row) => ({
        ...row,
        journal_entry_number:
          typeof row.journal_entry_id === "string"
            ? (entryNumbers.get(row.journal_entry_id) ?? null)
            : null,
        reversal_entry_number:
          typeof row.reversal_entry_id === "string"
            ? (entryNumbers.get(row.reversal_entry_id) ?? null)
            : null,
        reversed_by_event_id: reversalOf.get(String(row.id)) ?? null,
        // A conversion, exercise or transfer whose resulting security was voided is undone from the void.
        resulting_voided:
          typeof row.resulting_security_id === "string" && voidedOn.has(row.resulting_security_id)
            ? {
                securityId: row.resulting_security_id,
                securityNumber: numberOf.get(row.resulting_security_id) ?? "",
                voidedOn: voidedOn.get(row.resulting_security_id)!,
              }
            : null,
        reversible:
          (REVERSIBLE_EVENT_KINDS as readonly string[]).includes(String(row.kind)) &&
          !reversed.has(String(row.id)),
      })),
      source: source ? { id: source.id, securityNumber: source.securityNumber } : null,
      resulting: resulting.map((row) => ({
        id: row.id,
        securityNumber: row.securityNumber,
        holderName: names[row.holderPartyId] ?? "",
      })),
      exercisePrice:
        (security.kind === "option" || security.kind === "warrant") &&
        security.pricePerShare &&
        shareClass
          ? formatPrice(
              restatePrice(
                book.splits,
                shareClass.id,
                parsePrice(security.pricePerShare, "exercisePrice"),
                security.issueDate,
                input.asOf,
              ),
            )
          : null,
      mfn,
      interest:
        security.kind === "note"
          ? {
              posted: formatLedger(await accruedToDate(input.orgId, security.id, input.asOf)),
              accrued: convertible?.accruedInterest ?? "0.0000",
            }
          : null,
      earlyExercise:
        security.kind === "option" && security.earlyExercise && state
          ? {
              exercisable: eventCeiling(
                book,
                security,
                state.exact.outstanding,
                input.asOf,
              ).toString(),
              vested: state.vestedAvailable.toString(),
              repurchaseBasis: security.unvestedRepurchaseBasis,
            }
          : null,
      restricted,
      election83b: election83bStatus(book, security, input.asOf),
    };
  });
}

/** Map in order, one at a time: the reads share the snapshot's connection. */
async function mapInOrder<T, R>(rows: readonly T[], work: (row: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const row of rows) out.push(await work(row));
  return out;
}

export interface StructureView {
  entity: LegalEntity;
  classes: ReturnType<typeof classRow>[];
  plans: {
    id: string;
    code: string;
    name: string;
    shareClassId: string;
    effectiveOn: string;
    reserved: string;
    used: string;
    returned: string;
    available: string;
    recycleForfeited: boolean;
    recycleExpired: boolean;
    recycleRepurchased: boolean;
    reserveChanges: { id: string; effectiveOn: string; shareDelta: string }[];
  }[];
  rounds: {
    id: string;
    name: string;
    shareClassId: string;
    closedOn: string;
    pricePerShare: string;
    preMoneyValuation: string;
    currency: string;
    raised: string;
    sharesIssued: string;
    /** Why the pre-money valuation is stated on another basis than the price times the pre-round fully diluted shares. */
    preMoneyBasisReason: string | null;
    /** Fully diluted shares before the round on its closing date, and the pre-money valuation they imply at the round price. */
    fullyDilutedBefore: string;
    impliedPreMoney: string;
    /**
     * The pre-money valuation no longer agrees with the price times the fully
     * diluted shares before the round as the book now reads, and no basis is
     * recorded: corrected by a governed amendment of the valuation or its basis.
     */
    preMoneyDrift: { fullyDilutedBefore: string; impliedPreMoney: string } | null;
    /**
     * Conversions into the round whose recorded price differs from the price
     * the round now gives the converting terms, for the same reason: the
     * conversions stand as recorded.
     */
    conversionDrift: (ConversionDrift & {
      securityNumber: string;
      resultingSecurityNumber: string | null;
    })[];
    /** Live securities issued in the round or converted into it: while any stand, its price and date cannot change and it cannot be voided. */
    liveSecurities: { id: string; securityNumber: string }[];
    amendments: RoundAmendmentRecord[];
  }[];
  /** Rounds recorded in error and voided: kept for history, out of every figure. */
  voidedRounds: {
    id: string;
    name: string;
    closedOn: string;
    pricePerShare: string;
    preMoneyValuation: string;
    currency: string;
    voidedOn: string;
    reason: string;
  }[];
}

function classRow(book: EquityBook, shareClass: EquityBook["classes"][number], asOf: string) {
  const price = conversionPrice(book, shareClass, asOf);
  return {
    ...shareClass,
    initialAuthorizedShares: shareClass.initialAuthorizedShares.toString(),
    authorized: authorizedShares(book, shareClass, asOf).toString(),
    /** The common class the class converts into on the date, and its conversion price then. */
    conversionClassId: conversionClassOf(book, shareClass, asOf),
    currentConversionPrice: price ? formatPrice(price) : null,
    amendments: book.amendments
      .filter((row) => row.shareClassId === shareClass.id)
      .map((row) => ({ ...row, authorizedShares: row.authorizedShares?.toString() ?? null })),
    splits: book.splits
      .filter((row) => row.shareClassId === shareClass.id)
      .map((row) => ({
        id: row.id,
        effectiveOn: row.effectiveOn,
        ratio: `${row.ratioNumerator}:${row.ratioDenominator}`,
      })),
  };
}

/** Share classes, plans and rounds of a legal entity as of a date. */
export async function loadStructure(
  input: ReadInput & { subsidiaryId: string; asOf: string },
): Promise<StructureView> {
  return snapshot(input.orgId, async () => {
    const { entity, book } = await entityBook(input);
    const amendments = await loadRoundAmendments(db, input.orgId, input.subsidiaryId);
    const numberOf = new Map(book.securities.map((row) => [row.id, row.securityNumber]));
    const pricing = new Map<string, RoundPricing>();
    const originalRounds = (
      await db.execute<{
        id: string;
        name: string;
        share_class_id: string;
        closed_on: string;
        price_per_share: string;
        pre_money_valuation: string;
        currency: string;
        pre_money_basis_reason: string | null;
      }>(
        sql`
      select id, name, share_class_id, closed_on::text as closed_on, price_per_share::text as price_per_share, pre_money_valuation::text as pre_money_valuation,
             currency, pre_money_basis_reason
        from equity_financing_rounds where org_id = ${input.orgId} and subsidiary_id = ${input.subsidiaryId} order by closed_on, created_at, id`,
        "objects",
      )
    ).map((row) => ({
      id: row.id,
      name: row.name,
      shareClassId: row.share_class_id,
      closedOn: row.closed_on,
      pricePerShare: row.price_per_share,
      preMoneyValuation: row.pre_money_valuation,
      currency: row.currency,
      preMoneyBasisReason: row.pre_money_basis_reason,
    }));
    const voided = voidedSecurities(book, input.asOf);
    const voidedLatest = voidedSecurities(book, "9999-12-31");
    return {
      entity,
      classes: book.classes.map((row) => classRow(book, row, input.asOf)),
      plans: book.plans.map((plan) => {
        const pool = plan.effectiveOn <= input.asOf ? planPool(book, plan, input.asOf) : null;
        return {
          id: plan.id,
          code: plan.code,
          name: plan.name,
          shareClassId: plan.shareClassId,
          effectiveOn: plan.effectiveOn,
          reserved: (pool?.reserved ?? 0n).toString(),
          used: (pool?.used ?? 0n).toString(),
          returned: (pool?.returned ?? 0n).toString(),
          available: (pool?.available ?? 0n).toString(),
          recycleForfeited: plan.recycleForfeited,
          recycleExpired: plan.recycleExpired,
          recycleRepurchased: plan.recycleRepurchased,
          reserveChanges: book.reserveChanges
            .filter((row) => row.planId === plan.id)
            .map((row) => ({
              id: row.id,
              effectiveOn: row.effectiveOn,
              shareDelta: row.shareDelta.toString(),
            })),
        };
      }),
      rounds: await mapInOrder(book.rounds, async (round) => {
        const issued = book.securities.filter(
          (row) =>
            row.roundId === round.id &&
            row.kind === "share" &&
            row.issueDate <= input.asOf &&
            !row.sourceSecurityId &&
            !voided.has(row.id),
        );
        // Fundraising totals honor the selected date and exclude conversions.
        // Amendment dependencies include every certificate that still stands.
        const liveSecurities = book.securities.filter(
          (row) => row.roundId === round.id && row.kind === "share" && !voidedLatest.has(row.id),
        );
        let raised = 0n;
        let shares = 0n;
        for (const security of issued) {
          if (security.considerationAmount) raised += toUnits(security.considerationAmount);
          shares += security.quantity ?? 0n;
        }
        const fullyDilutedBefore = BigInt(
          buildCapTable(bookBeforeRound(book, round.id), round.closedOn).totals.fullyDiluted,
        );
        return {
          ...round,
          raised: formatLedger(raised),
          sharesIssued: shares.toString(),
          fullyDilutedBefore: fullyDilutedBefore.toString(),
          impliedPreMoney: formatMoney(
            multiplyRational(
              parsePrice(round.pricePerShare, "roundPrice"),
              rational(fullyDilutedBefore),
            ),
          ),
          preMoneyDrift: roundPreMoneyDrift(book, round),
          conversionDrift: (
            await roundConversionDrift(
              db,
              input.orgId,
              book,
              round.id,
              input.asOf,
              entity.currency,
              pricing,
            )
          ).map((drift) => ({
            ...drift,
            securityNumber: numberOf.get(drift.securityId) ?? "",
            resultingSecurityNumber: drift.resultingSecurityId
              ? (numberOf.get(drift.resultingSecurityId) ?? null)
              : null,
          })),
          liveSecurities: liveSecurities.map((row) => ({
            id: row.id,
            securityNumber: row.securityNumber,
          })),
          amendments: amendments.filter((row) => row.roundId === round.id),
        };
      }),
      voidedRounds: applyRoundAmendments(originalRounds, amendments).voided.map(
        ({ round, voidedOn, reason }) => ({
          id: round.id,
          name: round.name,
          closedOn: round.closedOn,
          pricePerShare: round.pricePerShare,
          preMoneyValuation: round.preMoneyValuation,
          currency: round.currency,
          voidedOn,
          reason,
        }),
      ),
    };
  });
}

/** Holders on the cap table, with their directory details. */
export async function listStakeholders(
  input: ReadInput & { subsidiaryId: string; asOf: string },
): Promise<{
  entity: LegalEntity;
  table: CapTable;
  parties: Record<string, { name: string; kind: string; email: string | null }>;
}> {
  return snapshot(input.orgId, async () => {
    const { entity, book } = await entityBook(input);
    const table = buildCapTable(book, input.asOf);
    const ids = [...new Set([...book.securities.map((row) => row.holderPartyId)])].filter(isUuid);
    const rows =
      ids.length === 0
        ? []
        : await db.execute<{
            id: string;
            display_name: string;
            kind: string;
            email: string | null;
          }>(
            sql`
      select id, display_name, kind, email from parties where org_id = ${input.orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])`,
            "objects",
          );
    return {
      entity,
      table,
      parties: Object.fromEntries(
        rows.map((row) => [row.id, { name: row.display_name, kind: row.kind, email: row.email }]),
      ),
    };
  });
}

/** Rates of every outstanding instrument currency into the functional currency on the model date; a missing rate refuses. */
async function modelRates(
  orgId: string,
  entity: LegalEntity,
  book: EquityBook,
  asOf: string,
): Promise<ModelRates> {
  const rates = new Map<string, string>([[entity.currency, "1"]]);
  for (const currency of modelCurrencies(book, asOf)) {
    if (!rates.has(currency))
      rates.set(
        currency,
        await spotRate(db, orgId, currency, entity.currency, asOf, entity.currency),
      );
  }
  return rates;
}

/** A pro-forma round against the legal entity's cap table. */
export async function modelEntityRound(
  input: ReadInput & { subsidiaryId: string } & Omit<RoundScenario, "currency">,
): Promise<{ entity: LegalEntity; result: RoundModelResult; parties: Record<string, string> }> {
  return snapshot(input.orgId, async () => {
    const { entity, book } = await entityBook(input);
    const result = modelRoundFromBook(
      book,
      { ...input, currency: entity.currency },
      await modelRates(input.orgId, entity, book, input.asOf),
    );
    return {
      entity,
      result,
      parties: await partyNames(
        input.orgId,
        result.dilution.filter((row) => row.kind === "holder").map((row) => row.key),
      ),
    };
  });
}

/** The exit waterfall against the legal entity's cap table. */
export async function runEntityWaterfall(
  input: ReadInput & { subsidiaryId: string } & Omit<ExitScenario, "minorUnitScale" | "currency">,
): Promise<{
  entity: LegalEntity;
  result: WaterfallResult;
  parties: Record<string, string>;
  classes: Record<string, string>;
}> {
  return snapshot(input.orgId, async () => {
    const { entity, book } = await entityBook(input);
    const minorUnitScale = await currencyExponent(db, entity.currency);
    const result = waterfallFromBook(
      book,
      { ...input, currency: entity.currency, minorUnitScale },
      await modelRates(input.orgId, entity, book, input.asOf),
    );
    return {
      entity,
      result,
      parties: await partyNames(
        input.orgId,
        result.holders.map((row) => row.holderPartyId),
      ),
      classes: Object.fromEntries(book.classes.map((row) => [row.id, row.code])),
    };
  });
}

/** Exit values the scenario curve samples, from zero to twice the scenario's exit value. */
const CURVE_POINTS = 17;
const CURVE_SPAN = rational(2n);

export interface WaterfallScenario {
  entity: LegalEntity;
  /** The exit value before fees, and the fees taken from it; `result.exitValue` is what holders share. */
  grossExitValue: string;
  transactionFees: string;
  result: WaterfallResult;
  /** The distribution at evenly spaced exit values from zero to twice the scenario's, the same fees taken from each. */
  curve: { exitValue: string; result: WaterfallResult }[];
  parties: Record<string, string>;
  classes: Record<string, string>;
}

/** The exit waterfall with its curve across exit values, in one snapshot of the legal entity's cap table. */
export async function runEntityWaterfallScenario(
  input: ReadInput & { subsidiaryId: string } & Omit<ExitScenario, "minorUnitScale" | "currency">,
): Promise<WaterfallScenario> {
  return snapshot(input.orgId, async () => {
    const { entity, book } = await entityBook(input);
    const minorUnitScale = await currencyExponent(db, entity.currency);
    const rates = await modelRates(input.orgId, entity, book, input.asOf);
    const scenario = { ...input, currency: entity.currency, minorUnitScale };
    const result = waterfallFromBook(book, scenario, rates);
    const curve = waterfallCurveFromBook(book, scenario, rates, CURVE_POINTS, CURVE_SPAN);
    const gross = formatMoney(parseMoney(input.exitValue, "exitValue"));
    return {
      entity,
      grossExitValue: gross,
      transactionFees: input.transactionFees
        ? formatMoney(parseMoney(input.transactionFees, "transactionFees"))
        : "0.0000",
      result,
      curve,
      parties: await partyNames(
        input.orgId,
        result.holders.map((row) => row.holderPartyId),
      ),
      classes: Object.fromEntries(book.classes.map((row) => [row.id, row.code])),
    };
  });
}

export interface CompensationRunRow {
  id: string;
  throughDate: string;
  total: string;
  currency: string;
  journalEntryId: string | null;
  entryNumber: string | null;
  /** Early-exercise deposits the run released to equity as restricted shares vested, and the entry that posted them. */
  releaseTotal: string;
  releaseJournalEntryId: string | null;
  releaseEntryNumber: string | null;
  createdAt: string;
}

/** Posted stock compensation runs of a legal entity, latest first. */
export async function listCompensationRuns(
  input: ReadInput & { subsidiaryId: string },
): Promise<CompensationRunRow[]> {
  return snapshot(input.orgId, async () => {
    await requireEquityReader(db, input.orgId, input.actorId, input.subsidiaryId);
    const rows = await db.execute<{
      id: string;
      through_date: string;
      total_amount: string;
      currency: string;
      journal_entry_id: string | null;
      entry_number: string | null;
      release_amount: string;
      release_journal_entry_id: string | null;
      release_entry_number: string | null;
      created_at: string;
    }>(
      sql`
      select r.id, r.through_date::text as through_date, r.total_amount::text as total_amount, r.currency, r.journal_entry_id,
             je.entry_number, r.release_amount::text as release_amount, r.release_journal_entry_id, rje.entry_number as release_entry_number,
             r.created_at::text as created_at
        from equity_compensation_runs r
        left join journal_entries je on je.org_id = r.org_id and je.id = r.journal_entry_id
        left join journal_entries rje on rje.org_id = r.org_id and rje.id = r.release_journal_entry_id
       where r.org_id = ${input.orgId} and r.subsidiary_id = ${input.subsidiaryId}
       order by r.through_date desc`,
      "objects",
    );
    return rows.map((row) => ({
      id: row.id,
      throughDate: row.through_date,
      total: row.total_amount,
      currency: row.currency,
      journalEntryId: row.journal_entry_id,
      entryNumber: row.entry_number,
      releaseTotal: row.release_amount,
      releaseJournalEntryId: row.release_journal_entry_id,
      releaseEntryNumber: row.release_entry_number,
      createdAt: row.created_at,
    }));
  });
}
