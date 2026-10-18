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
  eventCeiling,
  holdingState,
  planPool,
  reversedEvents,
  vestingTermsOf,
  type CapTable,
  type HoldingState,
} from "./cap-table.ts";
import { cumulativeCompensation, isCompensatory, totalCompensation } from "./compensation.ts";
import { EquityError } from "./errors.ts";
import { assertEquityReadable, currencyExponent, loadLegalEntity, requireEquityReader, type LegalEntity } from "./internal.ts";
import { spotRate } from "./fx.ts";
import { mfnCandidates, type MfnCandidate } from "./mfn.ts";
import { modelCurrencies, modelRoundFromBook, waterfallCurveFromBook, waterfallFromBook, type ExitScenario, type ModelRates, type RoundScenario } from "./models.ts";
import { instrumentBalance } from "./posting.ts";
import { floorShares, formatMoney, formatPrice, ledgerUnits, parseMoney, parsePrice, rational } from "./quantities.ts";
import { earlyExerciseSource, election83bStatus, releasedUnits, restrictedPortion, type Election83b } from "./restricted-stock.ts";
import { accruedToDate } from "./settlement.ts";
import { toUnits } from "../money/money.ts";
import type { RoundModelResult } from "./round-model.ts";
import { formatLedger } from "./securities.ts";
import { restatePrice } from "./splits.ts";
import { EVENT_COLUMNS, loadEquityBook, SECURITY_COLUMNS, securityFromRow } from "./store.ts";
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
  const rows = (await db.execute<{ id: string; display_name: string }>(sql`
    select id, display_name from parties where org_id = ${orgId} and id = any(${`{${list.join(",")}}`}::uuid[])`)).rows;
  return Object.fromEntries(rows.map((row) => [row.id, row.display_name]));
}

/** Legal entities the actor can read equity for. */
export async function listEquityEntities(input: ReadInput): Promise<LegalEntity[]> {
  return snapshot(input.orgId, async () => {
    await requireEquityReader(db, input.orgId, input.actorId, null);
    const allowed = await actorAllowedSubsidiaryIds(db, input.orgId, input.actorId);
    const rows = (await db.execute<{ id: string; name: string; currency: string | null }>(sql`
      select id, name, nullif(trim(base_currency), '') as currency from subsidiaries
       where org_id = ${input.orgId} and is_active and not is_elimination
       order by name, id`)).rows;
    return rows.filter((row) => row.currency && (allowed === null || allowed.has(row.id))).map((row) => ({ id: row.id, name: row.name, currency: row.currency! }));
  });
}

async function entityBook(input: ReadInput & { subsidiaryId: string }): Promise<{ entity: LegalEntity; book: EquityBook }> {
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
export async function loadCapTableView(input: ReadInput & { subsidiaryId: string; asOf: string }): Promise<CapTableView> {
  return snapshot(input.orgId, async () => {
    const { entity, book } = await entityBook(input);
    const table = buildCapTable(book, input.asOf);
    const policy = (await db.execute<{ id: string }>(sql`
      select id from equity_account_policies where org_id = ${input.orgId} and subsidiary_id = ${input.subsidiaryId}
         and effective_from <= ${input.asOf}::date limit 1`)).rows[0];
    return {
      entity,
      table,
      parties: await partyNames(input.orgId, [...table.holders.map((row) => row.holderPartyId), ...table.convertibles.map((row) => row.holderPartyId)]),
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
  currency: string;
  /** Restricted stock's 83(b) election standing (null when none is called for). */
  election83b: Election83b | null;
}

/** Securities of a legal entity with their state as of a date. */
export async function listSecurities(input: ReadInput & { subsidiaryId: string; asOf: string; kind?: SecurityKind | null; holderPartyId?: string | null }): Promise<{ entity: LegalEntity; rows: SecurityRow[] }> {
  return snapshot(input.orgId, async () => {
    const { entity, book } = await entityBook(input);
    const table = buildCapTable(book, input.asOf);
    const holdings = new Map(table.holdings.map((row) => [row.securityId, row]));
    const convertibles = new Map(table.convertibles.map((row) => [row.securityId, row]));
    const classes = new Map(book.classes.map((row) => [row.id, row.code]));
    const plans = new Map(book.plans.map((row) => [row.id, row.code]));
    const securities = book.securities.filter((row) => (!input.kind || row.kind === input.kind) && (!input.holderPartyId || row.holderPartyId === input.holderPartyId));
    const names = await partyNames(input.orgId, securities.map((row) => row.holderPartyId));
    const rows = securities.map((security): SecurityRow => {
      const holding = holdings.get(security.id);
      const convertible = convertibles.get(security.id);
      return {
        id: security.id,
        securityNumber: security.securityNumber,
        kind: security.kind,
        holderPartyId: security.holderPartyId,
        holderName: names[security.holderPartyId] ?? "",
        shareClassCode: security.shareClassId ? classes.get(security.shareClassId) ?? null : null,
        planCode: security.planId ? plans.get(security.planId) ?? null : null,
        issueDate: security.issueDate,
        status: holding?.status ?? convertible?.status ?? "not_issued",
        quantity: security.quantity?.toString() ?? null,
        outstanding: holding?.outstanding ?? null,
        vested: holding?.vested ?? null,
        price: holding?.exercisePrice ?? security.pricePerShare,
        principal: convertible?.principal ?? null,
        currency: security.currency,
        election83b: election83bStatus(book, security, input.asOf),
      };
    }).sort((a, b) => (a.issueDate < b.issueDate ? 1 : a.issueDate > b.issueDate ? -1 : a.securityNumber < b.securityNumber ? -1 : 1));
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
  state: { status: HoldingState["status"]; outstanding: string; vestedAvailable: string; unvested: string; consumed: Record<string, string> } | null;
  convertible: {
    status: string; principal: string; accruedInterest: string; convertingAmount: string; endedOn: string | null; convertedOn: string | null;
    resultingSecurityId: string | null; valuationCap: string | null; discountPercent: string | null; safeType: string | null; electionId: string | null;
  } | null;
  vesting: { date: string; quantity: string; cumulative: string }[];
  compensation: { total: string; recognized: string; posted: string } | null;
  events: Record<string, unknown>[];
  source: { id: string; securityNumber: string } | null;
  resulting: { id: string; securityNumber: string; holderName: string }[];
  exercisePrice: string | null;
  /** An MFN SAFE: later instruments whose better terms the holder may adopt, and the elections recorded. */
  mfn: {
    candidates: MfnCandidate[];
    elections: { id: string; effectiveOn: string; sourceSecurityId: string; sourceSecurityNumber: string; valuationCap: string | null; discountPercent: string | null; safeType: string }[];
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
    depositHeld: string;
  } | null;
  election83b: Election83b | null;
}

/** One security with its state, schedule, cost and history. */
export async function loadSecurityDetail(input: ReadInput & { securityId: string; asOf: string }): Promise<SecurityDetail> {
  if (!isUuid(input.securityId)) throw new EquityError("The security does not exist.", { status: 404, code: "equity_security_unknown", remedy: "Choose a security." });
  return snapshot(input.orgId, async () => {
    const raw = (await db.execute<Record<string, unknown>>(sql`
      select ${SECURITY_COLUMNS} from equity_securities where org_id = ${input.orgId} and id = ${input.securityId}`)).rows[0];
    if (!raw) throw new EquityError("The security does not exist.", { status: 404, code: "equity_security_unknown", remedy: "Choose a security." });
    const subsidiaryId = String(raw.subsidiary_id);
    const { entity, book } = await entityBook({ ...input, subsidiaryId });
    const security = securityFromRow(raw);
    const exponent = await currencyExponent(db, entity.currency);
    const shareClass = security.shareClassId ? book.classes.find((row) => row.id === security.shareClassId) ?? null : null;
    const plan = security.planId ? book.plans.find((row) => row.id === security.planId) ?? null : null;
    const round = security.roundId ? book.rounds.find((row) => row.id === security.roundId) ?? null : null;
    const state = security.quantity !== null ? holdingState(book, security, input.asOf) : null;
    const convertible = security.kind === "safe" || security.kind === "note" ? convertibleState(book, security, input.asOf) : null;
    const reversed = reversedEvents(book, "9999-12-31");
    const reversalOf = new Map(book.events.filter((event) => event.kind === "reverse" && event.reversesEventId).map((event) => [event.reversesEventId!, event.id]));
    const numberOf = new Map(book.securities.map((row) => [row.id, row.securityNumber]));
    const source83b = earlyExerciseSource(book, security);
    let restricted: SecurityDetail["restricted"] = null;
    if (source83b) {
      const portion = restrictedPortion(security);
      const held = await instrumentBalance(db, input.orgId, subsidiaryId, security.id, "deposit");
      restricted = {
        sourceSecurityId: source83b.id,
        sourceSecurityNumber: source83b.securityNumber,
        repurchaseBasis: source83b.unvestedRepurchaseBasis,
        vestedOnIssue: portion.vestedOnIssue.toString(),
        restrictedShares: portion.restricted.toString(),
        releasedShares: floorShares(releasedUnits(book, security, input.asOf)).toString(),
        depositHeld: formatLedger(-held.reduce((sum, group) => sum + group.units, 0n)),
      };
    }
    const eventRows = (await db.execute<Record<string, unknown>>(sql`
      select ${EVENT_COLUMNS} from equity_security_events where org_id = ${input.orgId} and security_id = ${input.securityId}
       order by effective_on, created_at, id`)).rows;
    const entryIds = [...eventRows.flatMap((row) => [row.journal_entry_id, row.reversal_entry_id, row.interest_accrual_entry_id]), raw.journal_entry_id].filter((id): id is string => typeof id === "string");
    const entries = entryIds.length === 0 ? [] : (await db.execute<{ id: string; entry_number: string; status: string }>(sql`
      select id, entry_number, status from journal_entries where org_id = ${input.orgId} and id = any(${`{${entryIds.join(",")}}`}::uuid[])`)).rows;
    const entryNumbers = new Map(entries.map((row) => [row.id, row.entry_number]));
    const resulting = book.securities.filter((row) => row.sourceSecurityId === security.id);
    const names = await partyNames(input.orgId, [security.holderPartyId, ...resulting.map((row) => row.holderPartyId)]);
    const source = security.sourceSecurityId ? book.securities.find((row) => row.id === security.sourceSecurityId) ?? null : null;
    let compensation: SecurityDetail["compensation"] = null;
    if (isCompensatory(security)) {
      const posted = (await db.execute<{ cumulative_amount: string }>(sql`
        select l.cumulative_amount::text as cumulative_amount from equity_compensation_run_lines l
          join equity_compensation_runs r on r.org_id = l.org_id and r.id = l.run_id
         where l.org_id = ${input.orgId} and l.security_id = ${security.id}
         order by r.through_date desc limit 1`)).rows[0];
      compensation = {
        total: formatLedger(ledgerUnits(totalCompensation(book, security, input.asOf), exponent)),
        recognized: formatLedger(ledgerUnits(cumulativeCompensation(book, security, input.asOf), exponent)),
        posted: posted?.cumulative_amount ?? "0.0000",
      };
    }
    return {
      entity,
      asOf: input.asOf,
      security: { ...raw, quantity: security.quantity?.toString() ?? null, vesting_tranches: security.vestingTranches?.map((tranche) => ({ date: tranche.date, quantity: tranche.quantity.toString() })) ?? null },
      holderName: names[security.holderPartyId] ?? "",
      shareClass: shareClass ? { id: shareClass.id, code: shareClass.code, name: shareClass.name, kind: shareClass.kind } : null,
      plan: plan ? { id: plan.id, code: plan.code, name: plan.name } : null,
      round: round ? { id: round.id, name: round.name } : null,
      state: state ? {
        status: state.status, outstanding: state.outstanding.toString(), vestedAvailable: state.vestedAvailable.toString(), unvested: state.unvested.toString(),
        consumed: Object.fromEntries(Object.entries(state.consumed).map(([key, value]) => [key, value.toString()])),
      } : null,
      convertible: convertible ? {
        status: convertible.status, principal: convertible.principal, accruedInterest: convertible.accruedInterest, convertingAmount: convertible.convertingAmount,
        endedOn: convertible.endedOn, convertedOn: convertible.convertedOn, resultingSecurityId: convertible.resultingSecurityId,
        valuationCap: convertible.terms.valuationCap, discountPercent: convertible.terms.discountPercent, safeType: convertible.terms.safeType, electionId: convertible.electionId,
      } : null,
      vesting: security.quantity !== null ? vestingInstallments(vestingTermsOf(security)).map((row) => ({ date: row.date, quantity: row.quantity.toString(), cumulative: row.cumulative.toString() })) : [],
      compensation,
      events: eventRows.map((row) => ({
        ...row,
        journal_entry_number: typeof row.journal_entry_id === "string" ? entryNumbers.get(row.journal_entry_id) ?? null : null,
        reversal_entry_number: typeof row.reversal_entry_id === "string" ? entryNumbers.get(row.reversal_entry_id) ?? null : null,
        reversed_by_event_id: reversalOf.get(String(row.id)) ?? null,
        reversible: (REVERSIBLE_EVENT_KINDS as readonly string[]).includes(String(row.kind)) && !reversed.has(String(row.id)),
      })),
      source: source ? { id: source.id, securityNumber: source.securityNumber } : null,
      resulting: resulting.map((row) => ({ id: row.id, securityNumber: row.securityNumber, holderName: names[row.holderPartyId] ?? "" })),
      exercisePrice: (security.kind === "option" || security.kind === "warrant") && security.pricePerShare && shareClass
        ? formatPrice(restatePrice(book.splits, shareClass.id, parsePrice(security.pricePerShare, "the exercise price"), security.issueDate, input.asOf))
        : null,
      mfn: security.kind === "safe" && security.mfn ? {
        candidates: mfnCandidates(book, security, input.asOf),
        elections: book.securityAmendments.filter((row) => row.securityId === security.id).map((row) => ({
          id: row.id, effectiveOn: row.effectiveOn, sourceSecurityId: row.sourceSecurityId, sourceSecurityNumber: numberOf.get(row.sourceSecurityId) ?? "",
          valuationCap: row.valuationCap, discountPercent: row.discountPercent, safeType: row.safeType,
        })),
      } : null,
      interest: security.kind === "note" ? { posted: formatLedger(await accruedToDate(input.orgId, security.id)), accrued: convertible?.accruedInterest ?? "0.0000" } : null,
      earlyExercise: security.kind === "option" && security.earlyExercise && state ? {
        exercisable: eventCeiling(book, security, state.exact.outstanding, input.asOf).toString(),
        vested: state.vestedAvailable.toString(),
        repurchaseBasis: security.unvestedRepurchaseBasis,
      } : null,
      restricted,
      election83b: election83bStatus(book, security, input.asOf),
    };
  });
}

export interface StructureView {
  entity: LegalEntity;
  classes: (ReturnType<typeof classRow>)[];
  plans: { id: string; code: string; name: string; shareClassId: string; effectiveOn: string; reserved: string; used: string; returned: string; available: string; recycleForfeited: boolean; recycleExpired: boolean; recycleRepurchased: boolean; reserveChanges: { id: string; effectiveOn: string; shareDelta: string }[] }[];
  rounds: { id: string; name: string; shareClassId: string; closedOn: string; pricePerShare: string; preMoneyValuation: string; currency: string; raised: string; sharesIssued: string }[];
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
    amendments: book.amendments.filter((row) => row.shareClassId === shareClass.id).map((row) => ({ ...row, authorizedShares: row.authorizedShares?.toString() ?? null })),
    splits: book.splits.filter((row) => row.shareClassId === shareClass.id).map((row) => ({ id: row.id, effectiveOn: row.effectiveOn, ratio: `${row.ratioNumerator}:${row.ratioDenominator}` })),
  };
}

/** Share classes, plans and rounds of a legal entity as of a date. */
export async function loadStructure(input: ReadInput & { subsidiaryId: string; asOf: string }): Promise<StructureView> {
  return snapshot(input.orgId, async () => {
    const { entity, book } = await entityBook(input);
    return {
      entity,
      classes: book.classes.map((row) => classRow(book, row, input.asOf)),
      plans: book.plans.map((plan) => {
        const pool = plan.effectiveOn <= input.asOf ? planPool(book, plan, input.asOf) : null;
        return {
          id: plan.id, code: plan.code, name: plan.name, shareClassId: plan.shareClassId, effectiveOn: plan.effectiveOn,
          reserved: (pool?.reserved ?? 0n).toString(), used: (pool?.used ?? 0n).toString(), returned: (pool?.returned ?? 0n).toString(), available: (pool?.available ?? 0n).toString(),
          recycleForfeited: plan.recycleForfeited, recycleExpired: plan.recycleExpired, recycleRepurchased: plan.recycleRepurchased,
          reserveChanges: book.reserveChanges.filter((row) => row.planId === plan.id).map((row) => ({ id: row.id, effectiveOn: row.effectiveOn, shareDelta: row.shareDelta.toString() })),
        };
      }),
      rounds: book.rounds.map((round) => {
        const issued = book.securities.filter((row) => row.roundId === round.id && row.kind === "share");
        let raised = 0n;
        let shares = 0n;
        for (const security of issued) {
          if (security.considerationAmount) raised += toUnits(security.considerationAmount);
          shares += security.quantity ?? 0n;
        }
        return { ...round, raised: formatLedger(raised), sharesIssued: shares.toString() };
      }),
    };
  });
}

/** Holders on the cap table, with their directory details. */
export async function listStakeholders(input: ReadInput & { subsidiaryId: string; asOf: string }): Promise<{ entity: LegalEntity; table: CapTable; parties: Record<string, { name: string; kind: string; email: string | null }> }> {
  return snapshot(input.orgId, async () => {
    const { entity, book } = await entityBook(input);
    const table = buildCapTable(book, input.asOf);
    const ids = [...new Set([...book.securities.map((row) => row.holderPartyId)])].filter(isUuid);
    const rows = ids.length === 0 ? [] : (await db.execute<{ id: string; display_name: string; kind: string; email: string | null }>(sql`
      select id, display_name, kind, email from parties where org_id = ${input.orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])`)).rows;
    return { entity, table, parties: Object.fromEntries(rows.map((row) => [row.id, { name: row.display_name, kind: row.kind, email: row.email }])) };
  });
}

/** Rates of every outstanding instrument currency into the functional currency on the model date; a missing rate refuses. */
async function modelRates(orgId: string, entity: LegalEntity, book: EquityBook, asOf: string): Promise<ModelRates> {
  const rates = new Map<string, string>([[entity.currency, "1"]]);
  for (const currency of modelCurrencies(book, asOf)) {
    if (!rates.has(currency)) rates.set(currency, await spotRate(db, orgId, currency, entity.currency, asOf, entity.currency));
  }
  return rates;
}

/** A pro-forma round against the legal entity's cap table. */
export async function modelEntityRound(input: ReadInput & { subsidiaryId: string } & RoundScenario): Promise<{ entity: LegalEntity; result: RoundModelResult; parties: Record<string, string> }> {
  return snapshot(input.orgId, async () => {
    const { entity, book } = await entityBook(input);
    const result = modelRoundFromBook(book, input, await modelRates(input.orgId, entity, book, input.asOf));
    return { entity, result, parties: await partyNames(input.orgId, result.dilution.filter((row) => row.kind === "holder").map((row) => row.key)) };
  });
}

/** The exit waterfall against the legal entity's cap table. */
export async function runEntityWaterfall(input: ReadInput & { subsidiaryId: string } & Omit<ExitScenario, "minorUnitScale">): Promise<{ entity: LegalEntity; result: WaterfallResult; parties: Record<string, string>; classes: Record<string, string> }> {
  return snapshot(input.orgId, async () => {
    const { entity, book } = await entityBook(input);
    const minorUnitScale = await currencyExponent(db, entity.currency);
    const result = waterfallFromBook(book, { ...input, minorUnitScale }, await modelRates(input.orgId, entity, book, input.asOf));
    return {
      entity,
      result,
      parties: await partyNames(input.orgId, result.holders.map((row) => row.holderPartyId)),
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
export async function runEntityWaterfallScenario(input: ReadInput & { subsidiaryId: string } & Omit<ExitScenario, "minorUnitScale">): Promise<WaterfallScenario> {
  return snapshot(input.orgId, async () => {
    const { entity, book } = await entityBook(input);
    const minorUnitScale = await currencyExponent(db, entity.currency);
    const rates = await modelRates(input.orgId, entity, book, input.asOf);
    const scenario = { ...input, minorUnitScale };
    const result = waterfallFromBook(book, scenario, rates);
    const curve = waterfallCurveFromBook(book, scenario, rates, CURVE_POINTS, CURVE_SPAN);
    const gross = formatMoney(parseMoney(input.exitValue, "the exit value"));
    return {
      entity,
      grossExitValue: gross,
      transactionFees: input.transactionFees ? formatMoney(parseMoney(input.transactionFees, "the transaction fees")) : "0.0000",
      result,
      curve,
      parties: await partyNames(input.orgId, result.holders.map((row) => row.holderPartyId)),
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
  createdAt: string;
}

/** Posted stock compensation runs of a legal entity, latest first. */
export async function listCompensationRuns(input: ReadInput & { subsidiaryId: string }): Promise<CompensationRunRow[]> {
  return snapshot(input.orgId, async () => {
    await requireEquityReader(db, input.orgId, input.actorId, input.subsidiaryId);
    const rows = (await db.execute<{ id: string; through_date: string; total_amount: string; currency: string; journal_entry_id: string | null; entry_number: string | null; created_at: string }>(sql`
      select r.id, r.through_date::text as through_date, r.total_amount::text as total_amount, r.currency, r.journal_entry_id,
             je.entry_number, r.created_at::text as created_at
        from equity_compensation_runs r
        left join journal_entries je on je.org_id = r.org_id and je.id = r.journal_entry_id
       where r.org_id = ${input.orgId} and r.subsidiary_id = ${input.subsidiaryId}
       order by r.through_date desc`)).rows;
    return rows.map((row) => ({ id: row.id, throughDate: row.through_date, total: row.total_amount, currency: row.currency, journalEntryId: row.journal_entry_id, entryNumber: row.entry_number, createdAt: row.created_at }));
  });
}
