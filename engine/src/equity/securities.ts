/**
 * Issuing securities: share certificates, options, RSUs, warrants, SAFEs and
 * convertible notes.
 *
 * An issuance is validated against the legal entity's history under its
 * equity lock: the holder is an active party, the class and plan belong to
 * the entity, the class stays within its authorized shares and the plan
 * within its pool on every later date, the vesting schedule is coherent and
 * compensatory awards carry their grant-date valuation (Black-Scholes for
 * options, the grant-date share price for RSUs). Anything that brings in
 * cash posts through the journal kernel before the retained row is written,
 * so the security records the entry it posted:
 *   shares for cash   Dr consideration / Cr share capital at par / Cr APIC
 *   warrants for cash Dr consideration / Cr APIC
 *   SAFEs and notes   Dr consideration / Cr convertible instruments
 * Options and RSUs post nothing at grant; their cost posts through the
 * stock compensation run.
 *
 * A security may be stated in a currency other than the legal entity's
 * functional currency (shares sold in a round take the round's currency).
 * It is measured at the spot rate of its issue date, which it records: cash
 * and convertible legs carry the foreign amount and that rate, share capital
 * and paid-in capital the functional amount, and an award's grant-date fair
 * value is expensed at that rate. A missing rate refuses.
 */
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { blackScholesCall } from "./black-scholes.ts";
import { EquityError } from "./errors.ts";
import { functionalUnits, spotRate } from "./fx.ts";
import { currencyExponent, writeEquityAudit } from "./internal.ts";
import { postEquityEntry, requireConsiderationAccount, resolveAccountPolicy, type EquityLeg } from "./posting.ts";
import {
  compareRational,
  ledgerUnits,
  multiplyRational,
  parseDecimal,
  parseMoney,
  parsePercent,
  parsePrice,
  parseShares,
  PERCENT_SCALE,
  rational,
} from "./quantities.ts";
import { restatePrice } from "./splits.ts";
import { assertPoolsCovered, assertWithinAuthorized, inEquityCommand, requireDate, type EquityCommand } from "./structure.ts";
import { DAY_COUNTS, INTEREST_BASES } from "./types.ts";
import type {
  Acceleration,
  DayCount,
  EquityBook,
  ExpenseAttribution,
  InterestBasis,
  RepurchaseBasis,
  SafeType,
  SecurityKind,
  SecurityRecord,
  ShareClassRecord,
  VestingFrequency,
  VestingTranche,
} from "./types.ts";
import { validateVestingTerms } from "./vesting.ts";

export interface VestingInput {
  vestingStart?: string | null;
  vestingMonths?: number | null;
  cliffMonths?: number | null;
  vestingFrequency?: VestingFrequency | null;
  vestingTranches?: { date: string; quantity: string }[] | null;
  acceleration?: Acceleration;
  accelerationPercent?: string | null;
}

export interface ValuationInput {
  sharePrice: string;
  volatilityPercent?: string | null;
  riskFreeRatePercent?: string | null;
  expectedTermYears?: string | null;
  dividendYieldPercent?: string | null;
  attribution: ExpenseAttribution;
}

export interface IssueSecurityInput extends EquityCommand, VestingInput {
  subsidiaryId: string;
  kind: SecurityKind;
  holderPartyId: string;
  securityNumber?: string | null;
  issueDate: string;
  shareClassId?: string | null;
  planId?: string | null;
  roundId?: string | null;
  quantity?: string | null;
  /** Purchase price per share for shares; exercise price for options and warrants. */
  pricePerShare?: string | null;
  considerationAmount?: string | null;
  considerationAccountId?: string | null;
  expirationDate?: string | null;
  optionType?: "iso" | "nso" | null;
  earlyExercise?: boolean;
  /** The price unvested early-exercised shares are repurchased at. */
  unvestedRepurchaseBasis?: RepurchaseBasis | null;
  safeType?: SafeType | null;
  /** A SAFE whose holder may adopt the better terms of a later instrument. */
  mfn?: boolean;
  valuationCap?: string | null;
  discountPercent?: string | null;
  interestRatePercent?: string | null;
  interestBasis?: InterestBasis | null;
  interestDayCount?: DayCount | null;
  maturityDate?: string | null;
  valuation?: ValuationInput | null;
  /** The currency the security is stated in (default: the round's, else the legal entity's functional currency). */
  currency?: string | null;
  memo?: string | null;
  idempotencyKey?: string | null;
}

/** The full row written for a security, whether issued directly or produced by an event. */
export interface SecurityInsert {
  id: string;
  orgId: string;
  subsidiaryId: string;
  securityNumber: string;
  kind: SecurityKind;
  holderPartyId: string;
  shareClassId: string | null;
  planId: string | null;
  roundId: string | null;
  sourceSecurityId: string | null;
  issueDate: string;
  quantity: bigint | null;
  pricePerShare: string | null;
  considerationAmount: string | null;
  currency: string;
  considerationAccountId: string | null;
  vestingStart: string | null;
  vestingMonths: number | null;
  cliffMonths: number | null;
  vestingFrequency: VestingFrequency | null;
  vestingTranches: readonly VestingTranche[] | null;
  acceleration: Acceleration;
  accelerationPercent: string | null;
  expirationDate: string | null;
  optionType: "iso" | "nso" | null;
  earlyExercise: boolean;
  safeType: SafeType | null;
  valuationCap: string | null;
  discountPercent: string | null;
  interestRatePercent: string | null;
  interestBasis: InterestBasis | null;
  interestDayCount: DayCount | null;
  maturityDate: string | null;
  mfn: boolean;
  unvestedRepurchaseBasis: RepurchaseBasis | null;
  fxRate: string;
  valuationMethod: "black_scholes" | "share_price" | null;
  valuationSharePrice: string | null;
  volatilityPercent: string | null;
  riskFreeRatePercent: string | null;
  expectedTermYears: string | null;
  dividendYieldPercent: string | null;
  fairValuePerUnit: string | null;
  expenseAttribution: ExpenseAttribution | null;
  memo: string | null;
  journalEntryId: string | null;
  idempotencyKey: string | null;
  actorId: string;
}

/** A database-generated, time-ordered identifier, so records keep their recording order. */
export async function newEquityId(runner: SqlExecutor): Promise<string> {
  const row = (await runner.execute<{ id: string }>(sql`select public.uuid_generate_v7() as id`)).rows[0];
  if (!row) throw new EquityError("No identifier was generated.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
  return row.id;
}

export async function insertSecurity(runner: SqlExecutor, row: SecurityInsert): Promise<void> {
  const tranches = row.vestingTranches ? JSON.stringify(row.vestingTranches.map((tranche) => ({ date: tranche.date, quantity: tranche.quantity.toString() }))) : null;
  const inserted = (await runner.execute<{ id: string }>(sql`
    insert into equity_securities (id, org_id, subsidiary_id, security_number, kind, holder_party_id, share_class_id, plan_id, round_id,
      source_security_id, issue_date, quantity, price_per_share, consideration_amount, currency, consideration_account_id,
      vesting_start, vesting_months, cliff_months, vesting_frequency, vesting_tranches, acceleration, acceleration_percent,
      expiration_date, option_type, early_exercise, safe_type, valuation_cap, discount_percent, interest_rate_percent, interest_basis,
      maturity_date, valuation_method, valuation_share_price, volatility_percent, risk_free_rate_percent, expected_term_years,
      dividend_yield_percent, fair_value_per_unit, expense_attribution, memo, journal_entry_id, idempotency_key, created_by,
      interest_day_count, mfn, unvested_repurchase_basis, fx_rate)
    values (${row.id}, ${row.orgId}, ${row.subsidiaryId}, ${row.securityNumber}, ${row.kind}, ${row.holderPartyId}, ${row.shareClassId},
      ${row.planId}, ${row.roundId}, ${row.sourceSecurityId}, ${row.issueDate}::date, ${row.quantity?.toString() ?? null}::bigint,
      ${row.pricePerShare}::numeric, ${row.considerationAmount}::numeric, ${row.currency}, ${row.considerationAccountId},
      ${row.vestingStart}::date, ${row.vestingMonths}, ${row.cliffMonths}, ${row.vestingFrequency}, ${tranches}::jsonb,
      ${row.acceleration}, ${row.accelerationPercent}::numeric, ${row.expirationDate}::date, ${row.optionType}, ${row.earlyExercise},
      ${row.safeType}, ${row.valuationCap}::numeric, ${row.discountPercent}::numeric, ${row.interestRatePercent}::numeric,
      ${row.interestBasis}, ${row.maturityDate}::date, ${row.valuationMethod}, ${row.valuationSharePrice}::numeric,
      ${row.volatilityPercent}::numeric, ${row.riskFreeRatePercent}::numeric, ${row.expectedTermYears}::numeric,
      ${row.dividendYieldPercent}::numeric, ${row.fairValuePerUnit}::numeric, ${row.expenseAttribution}, ${row.memo},
      ${row.journalEntryId}, ${row.idempotencyKey}, ${row.actorId},
      ${row.interestDayCount}, ${row.mfn}, ${row.unvestedRepurchaseBasis}, ${row.fxRate}::numeric)
    returning id`)).rows;
  if (inserted.length !== 1) throw new EquityError("The security was not saved.", { status: 409, code: "equity_write_failed", remedy: "Try again." });
}

/** The security as the cap-table math reads it. */
export function securityRecordOf(row: SecurityInsert): SecurityRecord {
  return {
    id: row.id, securityNumber: row.securityNumber, kind: row.kind, holderPartyId: row.holderPartyId, shareClassId: row.shareClassId,
    planId: row.planId, roundId: row.roundId, sourceSecurityId: row.sourceSecurityId, issueDate: row.issueDate, quantity: row.quantity,
    pricePerShare: row.pricePerShare, considerationAmount: row.considerationAmount, currency: row.currency, vestingStart: row.vestingStart,
    vestingMonths: row.vestingMonths, cliffMonths: row.cliffMonths, vestingFrequency: row.vestingFrequency, vestingTranches: row.vestingTranches,
    acceleration: row.acceleration, accelerationPercent: row.accelerationPercent, expirationDate: row.expirationDate, optionType: row.optionType,
    earlyExercise: row.earlyExercise, safeType: row.safeType, valuationCap: row.valuationCap, discountPercent: row.discountPercent,
    interestRatePercent: row.interestRatePercent, interestBasis: row.interestBasis, interestDayCount: row.interestDayCount,
    maturityDate: row.maturityDate, fairValuePerUnit: row.fairValuePerUnit, expenseAttribution: row.expenseAttribution,
    mfn: row.mfn, unvestedRepurchaseBasis: row.unvestedRepurchaseBasis, fxRate: row.fxRate,
  };
}

const NUMBER_PREFIX: Record<SecurityKind, string> = { share: "", option: "OPT", rsu: "RSU", warrant: "WAR", safe: "SAFE", note: "NOTE" };

/** Next security number for a kind (share certificates number within their class code). */
export function nextSecurityNumber(book: EquityBook, kind: SecurityKind, shareClass: ShareClassRecord | null): string {
  const prefix = kind === "share" ? (shareClass?.code ?? "CS") : NUMBER_PREFIX[kind];
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`);
  let highest = 0;
  for (const security of book.securities) {
    const match = pattern.exec(security.securityNumber);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}-${String(highest + 1).padStart(4, "0")}`;
}

/** An active party of the organization; anything else refuses. */
export async function requireHolder(runner: SqlExecutor, orgId: string, partyId: string, field = "holderPartyId"): Promise<string> {
  if (!isUuid(partyId)) throw new EquityError("Choose a valid holder.", { code: "equity_holder_unknown", status: 404, remedy: "Choose a person or company from the directory.", field });
  const row = (await runner.execute<{ display_name: string; is_active: boolean }>(sql`
    select display_name, is_active from parties where org_id = ${orgId} and id = ${partyId}`)).rows[0];
  if (!row || !row.is_active) throw new EquityError("The holder must be an active person or company of this organization.", { code: "equity_holder_unknown", status: 404, remedy: "Choose an active person or company, or reactivate it in the directory.", field });
  return row.display_name;
}

function blankToNull(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? null : text;
}

function refuse(message: string, field: string, remedy: string, code = "equity_security_invalid"): never {
  throw new EquityError(message, { code, remedy, field });
}

/** Par value of `quantity` shares of a class on a date, as ledger units in the currency's minor unit. */
export function parUnits(book: EquityBook, shareClass: ShareClassRecord, quantity: bigint, on: string, exponent: number): bigint {
  const par = restatePrice(book.splits, shareClass.id, parsePrice(shareClass.parValue, "the par value"), shareClass.effectiveOn, on);
  return ledgerUnits(multiplyRational(par, rational(quantity)), exponent);
}

/** Issue a security (equity.manage). Returns the security and the entry it posted, if any. */
export async function issueSecurity(input: IssueSecurityInput): Promise<{ id: string; securityNumber: string; journalEntryId: string | null; replayed: boolean }> {
  const issueDate = requireDate(input.issueDate, "issueDate", "The issue date");
  const kind = input.kind;
  if (!["share", "option", "rsu", "warrant", "safe", "note"].includes(kind)) refuse("Choose what kind of security to issue.", "kind", "Choose share, option, RSU, warrant, SAFE or note.");
  const memo = blankToNull(input.memo);
  if (memo && memo.length > 2000) refuse("The memo is longer than 2000 characters.", "memo", "Shorten the memo.");
  const idempotencyKey = blankToNull(input.idempotencyKey);
  return inEquityCommand(input, "equity.manage", async ({ book, currency: functional }) => {
    if (idempotencyKey) {
      const existing = (await db.execute<{ id: string; security_number: string; journal_entry_id: string | null; kind: string; holder_party_id: string; subsidiary_id: string }>(sql`
        select id, security_number, journal_entry_id, kind, holder_party_id, subsidiary_id from equity_securities
         where org_id = ${input.orgId} and idempotency_key = ${idempotencyKey}`)).rows[0];
      if (existing) {
        if (existing.kind !== kind || existing.holder_party_id !== input.holderPartyId || existing.subsidiary_id !== input.subsidiaryId) {
          throw new EquityError("This request key was already used for a different issuance.", { status: 409, code: "equity_idempotency_conflict", remedy: "Retry with a new request key." });
        }
        return { id: existing.id, securityNumber: existing.security_number, journalEntryId: existing.journal_entry_id, replayed: true };
      }
    }
    const holderName = await requireHolder(db, input.orgId, input.holderPartyId);
    const shareBased = kind === "share" || kind === "option" || kind === "rsu" || kind === "warrant";
    const shareClass = shareBased ? book.classes.find((row) => row.id === input.shareClassId) ?? null : null;
    if (shareBased && !shareClass) refuse("Choose the share class of this legal entity the security is in.", "shareClassId", "Choose a share class.", "equity_class_unknown");
    if (shareClass && issueDate < shareClass.effectiveOn) refuse(`Class ${shareClass.code} is not effective until ${shareClass.effectiveOn}.`, "issueDate", `Date the issuance on or after ${shareClass.effectiveOn}.`);
    const plan = input.planId ? book.plans.find((row) => row.id === input.planId) ?? null : null;
    if (input.planId && !plan) refuse("The plan does not exist for this legal entity.", "planId", "Choose a plan of the legal entity.", "equity_plan_unknown");
    if (plan && kind !== "option" && kind !== "rsu") refuse("Only options and RSUs are granted from a plan.", "planId", "Clear the plan.");
    if (plan && shareClass && plan.shareClassId !== shareClass.id) refuse(`Plan ${plan.code} grants awards over its own class.`, "shareClassId", "Choose the plan's share class.");
    if (plan && issueDate < plan.effectiveOn) refuse(`Plan ${plan.code} is not effective until ${plan.effectiveOn}.`, "issueDate", `Date the grant on or after ${plan.effectiveOn}.`);
    const round = input.roundId ? book.rounds.find((row) => row.id === input.roundId) ?? null : null;
    if (input.roundId && !round) refuse("The round does not exist for this legal entity.", "roundId", "Choose a round of the legal entity.", "equity_round_unknown");
    if (round && kind !== "share" && kind !== "warrant") refuse("Only shares and warrants are issued in a round.", "roundId", "Clear the round.");
    if (round && shareClass && kind === "share" && round.shareClassId !== shareClass.id) refuse(`The round sells class ${book.classes.find((row) => row.id === round.shareClassId)?.code ?? ""}.`, "shareClassId", "Choose the round's share class.");
    const quantity = shareBased ? parseShares(input.quantity ?? "", "the quantity") : null;
    if (quantity !== null && quantity <= 0n) refuse("Issue at least one share.", "quantity", "Enter the quantity.");
    if (!shareBased && blankToNull(input.quantity)) refuse("SAFEs and notes are measured in money, not shares.", "quantity", "Clear the quantity and enter the principal.");
    const requestedCurrency = blankToNull(input.currency)?.toUpperCase() ?? null;
    if (round && requestedCurrency && requestedCurrency !== round.currency) refuse(`The round is priced in ${round.currency}.`, "currency", `Issue the round's securities in ${round.currency}.`);
    const currency = requestedCurrency ?? round?.currency ?? functional;
    if (!/^[A-Z]{3}$/.test(currency)) refuse("Choose the currency the security is stated in.", "currency", "Enter a three-letter ISO currency code.");
    const exponent = await currencyExponent(db, currency);
    const fxRate = currency === functional ? "1" : await spotRate(db, input.orgId, currency, functional, issueDate, functional);
    const functionalExponent = currency === functional ? exponent : await currencyExponent(db, functional);

    // Prices and consideration.
    let pricePerShare = blankToNull(input.pricePerShare);
    if (kind === "share" && !pricePerShare && round) pricePerShare = round.pricePerShare;
    if ((kind === "option" || kind === "warrant") && !pricePerShare) refuse("Enter the exercise price per share.", "pricePerShare", "Enter the exercise price.");
    if (pricePerShare && parsePrice(pricePerShare, "the price per share").numerator < 0n) refuse("The price cannot be negative.", "pricePerShare", "Enter a price of zero or more.");
    if ((kind === "safe" || kind === "note") && pricePerShare) refuse("A SAFE or note has no price per share.", "pricePerShare", "Clear the price.");
    if (kind === "rsu" && pricePerShare) refuse("An RSU has no purchase or exercise price.", "pricePerShare", "Clear the price.");
    let consideration = blankToNull(input.considerationAmount);
    if (kind === "share" && !consideration && pricePerShare && quantity !== null) {
      consideration = (() => {
        const units = ledgerUnits(multiplyRational(parsePrice(pricePerShare!, "the price per share"), rational(quantity)), exponent);
        return units === 0n ? null : formatLedger(units);
      })();
    }
    const considerationUnits = consideration ? ledgerUnits(parseMoney(consideration, "the consideration"), exponent) : 0n;
    if (consideration && considerationUnits < 0n) refuse("The consideration cannot be negative.", "considerationAmount", "Enter the cash received.");
    if ((kind === "safe" || kind === "note") && considerationUnits <= 0n) refuse("Enter the principal the investor paid.", "considerationAmount", "Enter the purchase amount or note principal.");
    if (kind === "option" || kind === "rsu") {
      if (consideration && considerationUnits !== 0n) refuse("Awards are granted without consideration; the exercise price is paid on exercise.", "considerationAmount", "Clear the consideration.");
      consideration = null;
    }
    const considerationAccountId = considerationUnits > 0n ? await requireConsiderationAccount(db, input.orgId, input.considerationAccountId) : null;

    // Vesting.
    const vestable = kind === "share" || kind === "option" || kind === "rsu";
    const tranches: VestingTranche[] | null = input.vestingTranches && input.vestingTranches.length > 0
      ? input.vestingTranches.map((tranche) => ({ date: requireDate(tranche.date, "vestingTranches", "A tranche date"), quantity: parseShares(tranche.quantity, "a tranche quantity") }))
      : null;
    const vestingMonths = input.vestingMonths ?? null;
    if (!vestable && (tranches || vestingMonths !== null)) refuse("Only shares, options and RSUs vest.", "vesting", "Clear the vesting terms.");
    const vestingStart = vestingMonths !== null ? requireDate(input.vestingStart ?? issueDate, "vestingStart", "The vesting start") : null;
    if (vestable && quantity !== null) {
      validateVestingTerms({
        issueDate, quantity, vestingStart, vestingMonths, cliffMonths: vestingMonths !== null ? input.cliffMonths ?? 0 : null,
        vestingFrequency: vestingMonths !== null ? input.vestingFrequency ?? "monthly" : null, vestingTranches: tranches,
      });
    }
    const acceleration: Acceleration = input.acceleration ?? "none";
    if (!["none", "single", "double"].includes(acceleration)) refuse("Choose the acceleration terms.", "acceleration", "Choose none, single trigger or double trigger.");
    const accelerationPercent = acceleration === "none" ? null : blankToNull(input.accelerationPercent) ?? "100";
    if (accelerationPercent) {
      const percent = parseDecimal(accelerationPercent, "the acceleration percentage", PERCENT_SCALE);
      if (percent.numerator <= 0n || compareRational(percent, rational(100n)) > 0) refuse("Acceleration must be above 0% and at most 100%.", "accelerationPercent", "Enter the share of unvested units that accelerates.");
    }
    if (acceleration !== "none" && !vestable) refuse("Only vesting securities accelerate.", "acceleration", "Clear the acceleration.");

    // Option, convertible and valuation terms.
    const expirationDate = input.expirationDate ? requireDate(input.expirationDate, "expirationDate", "The expiration date") : null;
    if (expirationDate && expirationDate <= issueDate) refuse("The expiration date must follow the issue date.", "expirationDate", "Correct the expiration date.");
    if (expirationDate && kind !== "option" && kind !== "warrant") refuse("Only options and warrants expire.", "expirationDate", "Clear the expiration date.");
    const optionType = kind === "option" ? input.optionType ?? null : null;
    if (kind === "option" && optionType !== "iso" && optionType !== "nso") refuse("Choose whether the option is an incentive or non-qualified option.", "optionType", "Choose ISO or NSO.");
    const earlyExercise = kind === "option" ? input.earlyExercise === true : false;
    if (input.earlyExercise === true && kind !== "option") refuse("Only options admit early exercise.", "earlyExercise", "Clear early exercise.");
    const unvestedRepurchaseBasis = earlyExercise ? input.unvestedRepurchaseBasis ?? null : null;
    if (earlyExercise && unvestedRepurchaseBasis !== "cost" && unvestedRepurchaseBasis !== "lower_of_cost_or_fmv") {
      refuse("Choose the price at which the company repurchases unvested early-exercised shares.", "unvestedRepurchaseBasis", "Choose cost, or the lower of cost and fair market value.");
    }
    if (!earlyExercise && input.unvestedRepurchaseBasis) refuse("Only an early-exercisable option carries an unvested repurchase price.", "unvestedRepurchaseBasis", "Clear the repurchase basis or allow early exercise.");
    const safeType = kind === "safe" ? input.safeType ?? null : null;
    if (kind === "safe" && safeType !== "pre_money" && safeType !== "post_money") refuse("Choose a pre-money or post-money SAFE.", "safeType", "Choose the SAFE type.");
    const mfn = kind === "safe" ? input.mfn === true : false;
    if (input.mfn === true && kind !== "safe") refuse("Only a SAFE carries a most-favored-nation term.", "mfn", "Clear the MFN term.");
    const convertible = kind === "safe" || kind === "note";
    const valuationCap = convertible ? blankToNull(input.valuationCap) : null;
    const discountPercent = convertible ? blankToNull(input.discountPercent) : null;
    if (!convertible && (blankToNull(input.valuationCap) || blankToNull(input.discountPercent))) refuse("Only SAFEs and notes carry a cap or discount.", "valuationCap", "Clear the cap and discount.");
    if (valuationCap && parseMoney(valuationCap, "the valuation cap").numerator <= 0n) refuse("The valuation cap must be greater than zero.", "valuationCap", "Enter the cap or clear it.");
    // A stated 0% discount is a term as written (it converts at the round price); blank records no discount.
    if (discountPercent) {
      const discount = parsePercent(discountPercent, "the discount");
      if (discount.numerator < 0n || compareRational(discount, rational(1n)) >= 0) refuse("The discount must be at least 0% and below 100%.", "discountPercent", "Enter a discount from 0% up to, but not including, 100%, or leave it blank for none.");
    }
    const interestRatePercent = kind === "note" ? blankToNull(input.interestRatePercent) : null;
    const interestBasis = kind === "note" ? input.interestBasis ?? null : null;
    const interestDayCount = kind === "note" ? input.interestDayCount ?? null : null;
    const maturityDate = kind === "note" && input.maturityDate ? requireDate(input.maturityDate, "maturityDate", "The maturity date") : null;
    if (kind === "note") {
      if (!interestRatePercent || parseDecimal(interestRatePercent, "the interest rate", PERCENT_SCALE).numerator < 0n) refuse("Enter the note's annual interest rate.", "interestRatePercent", "Enter the interest rate (zero for none).");
      if (!interestBasis || !INTEREST_BASES.includes(interestBasis)) refuse("Choose how the note's interest accrues.", "interestBasis", "Choose simple interest, or compounding annually, semiannually, quarterly or monthly.");
      if (!interestDayCount || !DAY_COUNTS.includes(interestDayCount)) refuse("Choose the note's day-count convention.", "interestDayCount", "Choose Actual/365, Actual/360, 30/360 or Actual/Actual.");
      if (maturityDate && maturityDate <= issueDate) refuse("The maturity date must follow the issue date.", "maturityDate", "Correct the maturity date.");
    } else if (input.interestDayCount) {
      refuse("Only a note carries a day-count convention.", "interestDayCount", "Clear the day count.");
    }
    let valuationMethod: SecurityInsert["valuationMethod"] = null;
    let fairValuePerUnit: string | null = null;
    const valuation = input.valuation ?? null;
    if (kind === "option" || kind === "rsu") {
      if (!valuation) refuse("Awards need their grant-date valuation.", "valuation", "Enter the grant-date share price and valuation assumptions.");
      if (valuation!.attribution !== "straight_line" && valuation!.attribution !== "graded") refuse("Choose how the award's cost is attributed.", "valuation", "Choose straight-line or graded attribution.");
      if (parsePrice(valuation!.sharePrice, "the grant-date share price").numerator <= 0n) refuse("The grant-date share price must be greater than zero.", "valuation", "Enter the fair value of a share on the grant date.");
      if (kind === "option") {
        valuationMethod = "black_scholes";
        fairValuePerUnit = blackScholesCall({
          sharePrice: valuation!.sharePrice,
          exercisePrice: pricePerShare!,
          volatilityPercent: valuation!.volatilityPercent ?? "",
          riskFreeRatePercent: valuation!.riskFreeRatePercent ?? "",
          expectedTermYears: valuation!.expectedTermYears ?? "",
          dividendYieldPercent: valuation!.dividendYieldPercent ?? "",
        }).fairValue;
      } else {
        valuationMethod = "share_price";
        fairValuePerUnit = valuation!.sharePrice.trim();
      }
    } else if (valuation) {
      refuse("Only options and RSUs carry a share-based payment valuation.", "valuation", "Clear the valuation.");
    }

    const id = await newEquityId(db);
    const securityNumber = blankToNull(input.securityNumber) ?? nextSecurityNumber(book, kind, shareClass);
    if (securityNumber.length > 40) refuse("The security number is longer than 40 characters.", "securityNumber", "Shorten the security number.");
    if (book.securities.some((row) => row.securityNumber.toLowerCase() === securityNumber.toLowerCase())) {
      throw new EquityError(`Security number ${securityNumber} is already used by this legal entity.`, { status: 409, code: "equity_security_number_taken", remedy: "Choose a different number, or leave it blank to number it automatically.", field: "securityNumber" });
    }
    const row: SecurityInsert = {
      id, orgId: input.orgId, subsidiaryId: input.subsidiaryId, securityNumber, kind, holderPartyId: input.holderPartyId,
      shareClassId: shareClass?.id ?? null, planId: plan?.id ?? null, roundId: round?.id ?? null, sourceSecurityId: null, issueDate, quantity,
      pricePerShare, considerationAmount: consideration ? formatLedger(considerationUnits) : null, currency, considerationAccountId,
      vestingStart, vestingMonths, cliffMonths: vestingMonths !== null ? input.cliffMonths ?? 0 : null,
      vestingFrequency: vestingMonths !== null ? input.vestingFrequency ?? "monthly" : null, vestingTranches: tranches,
      acceleration, accelerationPercent, expirationDate, optionType, earlyExercise, safeType, valuationCap, discountPercent,
      interestRatePercent, interestBasis, interestDayCount, maturityDate, mfn, unvestedRepurchaseBasis, fxRate, valuationMethod,
      valuationSharePrice: valuation ? valuation.sharePrice.trim() : null,
      volatilityPercent: kind === "option" ? blankToNull(valuation?.volatilityPercent) : null,
      riskFreeRatePercent: kind === "option" ? blankToNull(valuation?.riskFreeRatePercent) : null,
      expectedTermYears: kind === "option" ? blankToNull(valuation?.expectedTermYears) : null,
      dividendYieldPercent: kind === "option" ? blankToNull(valuation?.dividendYieldPercent) : null,
      fairValuePerUnit, expenseAttribution: valuation?.attribution ?? null, memo, journalEntryId: null, idempotencyKey, actorId: input.actorId,
    };
    const pending: EquityBook = { ...book, securities: [...book.securities, securityRecordOf(row)] };
    if (shareClass) assertWithinAuthorized(pending, shareClass.id, issueDate);
    if (plan) assertPoolsCovered(pending, plan.id, issueDate);

    // Journal entry for any cash received.
    let legs: EquityLeg[] = [];
    if (considerationUnits > 0n) {
      const policy = await resolveAccountPolicy(db, input.orgId, input.subsidiaryId, issueDate);
      const cashFunctional = functionalUnits(considerationUnits, fxRate);
      const foreign = (txnUnits: bigint) => (currency === functional ? undefined : { currency, txnUnits, fxRate });
      const cash: EquityLeg = { accountId: considerationAccountId!, units: cashFunctional, foreign: foreign(considerationUnits) };
      if (kind === "share") {
        const par = parUnits(book, shareClass!, quantity!, issueDate, functionalExponent);
        if (cashFunctional < par) refuse("The consideration is below the shares' par value.", "considerationAmount", "Shares cannot be issued below par; enter the full consideration received.");
        legs = [
          cash,
          { accountId: shareClass!.kind === "preferred" ? policy.preferredStockAccountId : policy.commonStockAccountId, units: -par },
          { accountId: policy.apicAccountId, units: -(cashFunctional - par) },
        ];
      } else if (kind === "warrant") {
        legs = [cash, { accountId: policy.apicAccountId, units: -cashFunctional }];
      } else {
        legs = [cash, { accountId: policy.convertibleInstrumentsAccountId, units: -cashFunctional, foreign: foreign(-considerationUnits) }];
      }
    } else if (kind === "share" && parUnits(book, shareClass!, quantity!, issueDate, functionalExponent) > 0n) {
      refuse("Shares carry par value, so their issuance needs consideration.", "considerationAmount", "Enter the cash received for the shares and the account that received it.");
    }
    if (legs.length > 0) {
      row.journalEntryId = await postEquityEntry(db, {
        orgId: input.orgId, subsidiaryId: input.subsidiaryId, currency: functional, postingDate: issueDate,
        entryNumberBase: `EQ-${securityNumber}`, memo: `Issuance of ${securityNumber} to ${holderName}`,
        idempotencyKey: `equity:security:${id}:issue`, actorId: input.actorId, auditAction: "equity.issue",
        auditChanges: { securityId: id, securityNumber }, legs,
      });
    }
    await insertSecurity(db, row);
    await writeEquityAudit(db, {
      orgId: input.orgId, table: "equity_securities", rowId: id, action: "equity.security.issue", actorId: input.actorId,
      changes: {
        before: null,
        after: {
          securityNumber, kind, holderPartyId: input.holderPartyId, shareClassId: row.shareClassId, planId: row.planId, roundId: row.roundId, issueDate,
          quantity, pricePerShare, considerationAmount: row.considerationAmount, currency, fxRate, fairValuePerUnit, mfn, interestDayCount,
          unvestedRepurchaseBasis, journalEntryId: row.journalEntryId,
        },
      },
    });
    return { id, securityNumber, journalEntryId: row.journalEntryId, replayed: false };
  });
}

/** Ledger units as the four-place decimal string the money columns store. */
export function formatLedger(units: bigint): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(5, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

