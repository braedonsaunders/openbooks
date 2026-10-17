/** Read one legal entity's stored equity records into the shape the cap-table math reads. */
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import type {
  ClassAmendmentRecord,
  EquityBook,
  FinancingRoundRecord,
  PlanRecord,
  ReserveChangeRecord,
  SecurityEventRecord,
  SecurityRecord,
  ShareClassRecord,
  SplitRecord,
} from "./types.ts";
import { parseVestingTranches } from "./vesting.ts";

const big = (value: string | number | null): bigint | null => (value === null ? null : BigInt(value));

type Row = Record<string, unknown>;
const str = (row: Row, key: string): string => String(row[key]);
const opt = (row: Row, key: string): string | null => (row[key] === null || row[key] === undefined ? null : String(row[key]));
const num = (row: Row, key: string): number | null => (row[key] === null || row[key] === undefined ? null : Number(row[key]));

export function shareClassFromRow(row: Row): ShareClassRecord {
  return {
    id: str(row, "id"), code: str(row, "code"), name: str(row, "name"), kind: str(row, "kind") as ShareClassRecord["kind"],
    effectiveOn: str(row, "effective_on"), initialAuthorizedShares: BigInt(str(row, "initial_authorized_shares")),
    parValue: str(row, "par_value"), originalIssuePrice: opt(row, "original_issue_price"), initialConversionPrice: opt(row, "initial_conversion_price"),
    liquidationMultiple: opt(row, "liquidation_multiple"), participation: str(row, "participation") as ShareClassRecord["participation"],
    participationCapMultiple: opt(row, "participation_cap_multiple"), seniority: Number(row.seniority), antiDilution: str(row, "anti_dilution") as ShareClassRecord["antiDilution"],
  };
}

export function securityFromRow(row: Row): SecurityRecord {
  return {
    id: str(row, "id"), securityNumber: str(row, "security_number"), kind: str(row, "kind") as SecurityRecord["kind"],
    holderPartyId: str(row, "holder_party_id"), shareClassId: opt(row, "share_class_id"), planId: opt(row, "plan_id"), roundId: opt(row, "round_id"),
    sourceSecurityId: opt(row, "source_security_id"), issueDate: str(row, "issue_date"), quantity: big(opt(row, "quantity")),
    pricePerShare: opt(row, "price_per_share"), considerationAmount: opt(row, "consideration_amount"), currency: str(row, "currency"),
    vestingStart: opt(row, "vesting_start"), vestingMonths: num(row, "vesting_months"), cliffMonths: num(row, "cliff_months"),
    vestingFrequency: opt(row, "vesting_frequency") as SecurityRecord["vestingFrequency"], vestingTranches: parseVestingTranches(row.vesting_tranches ?? null),
    acceleration: str(row, "acceleration") as SecurityRecord["acceleration"], accelerationPercent: opt(row, "acceleration_percent"),
    expirationDate: opt(row, "expiration_date"), optionType: opt(row, "option_type") as SecurityRecord["optionType"], earlyExercise: row.early_exercise === true,
    safeType: opt(row, "safe_type") as SecurityRecord["safeType"], valuationCap: opt(row, "valuation_cap"), discountPercent: opt(row, "discount_percent"),
    interestRatePercent: opt(row, "interest_rate_percent"), interestBasis: opt(row, "interest_basis") as SecurityRecord["interestBasis"],
    maturityDate: opt(row, "maturity_date"), fairValuePerUnit: opt(row, "fair_value_per_unit"),
    expenseAttribution: opt(row, "expense_attribution") as SecurityRecord["expenseAttribution"],
  };
}

export function eventFromRow(row: Row): SecurityEventRecord {
  return {
    id: str(row, "id"), securityId: str(row, "security_id"), kind: str(row, "kind") as SecurityEventRecord["kind"], effectiveOn: str(row, "effective_on"),
    quantity: big(opt(row, "quantity")), pricePerShare: opt(row, "price_per_share"), amount: opt(row, "amount"),
    resultingSecurityId: opt(row, "resulting_security_id"), roundId: opt(row, "round_id"),
  };
}

export const SECURITY_COLUMNS = sql`id, security_number, kind, holder_party_id, share_class_id, plan_id, round_id, source_security_id,
  issue_date::text as issue_date, quantity::text as quantity, price_per_share::text as price_per_share,
  consideration_amount::text as consideration_amount, currency, consideration_account_id, vesting_start::text as vesting_start,
  vesting_months, cliff_months, vesting_frequency, vesting_tranches, acceleration, acceleration_percent::text as acceleration_percent,
  expiration_date::text as expiration_date, option_type, early_exercise, safe_type, valuation_cap::text as valuation_cap,
  discount_percent::text as discount_percent, interest_rate_percent::text as interest_rate_percent, interest_basis,
  maturity_date::text as maturity_date, valuation_method, valuation_share_price::text as valuation_share_price,
  volatility_percent::text as volatility_percent, risk_free_rate_percent::text as risk_free_rate_percent,
  expected_term_years::text as expected_term_years, dividend_yield_percent::text as dividend_yield_percent,
  fair_value_per_unit::text as fair_value_per_unit, expense_attribution, memo, journal_entry_id, created_at, created_by, subsidiary_id`;

export const EVENT_COLUMNS = sql`id, security_id, kind, effective_on::text as effective_on, quantity::text as quantity,
  price_per_share::text as price_per_share, amount::text as amount, resulting_security_id, round_id, consideration_account_id,
  journal_entry_id, reversal_entry_id, reason, created_at, created_by`;

/** Everything recorded for one legal entity, in recording order. */
export async function loadEquityBook(runner: SqlExecutor, orgId: string, subsidiaryId: string): Promise<EquityBook> {
  const scope = sql`org_id = ${orgId} and subsidiary_id = ${subsidiaryId}`;
  const classes = (await runner.execute<Row>(sql`
    select id, code, name, kind, effective_on::text as effective_on, initial_authorized_shares::text as initial_authorized_shares,
           par_value::text as par_value, original_issue_price::text as original_issue_price,
           initial_conversion_price::text as initial_conversion_price, liquidation_multiple::text as liquidation_multiple,
           participation, participation_cap_multiple::text as participation_cap_multiple, seniority, anti_dilution
      from equity_share_classes where ${scope} order by created_at, id`)).rows.map(shareClassFromRow);
  const amendments = (await runner.execute<Row>(sql`
    select id, share_class_id, kind, effective_on::text as effective_on, authorized_shares::text as authorized_shares,
           conversion_price::text as conversion_price, reason
      from equity_class_amendments where ${scope} order by created_at, id`)).rows.map((row): ClassAmendmentRecord => ({
    id: str(row, "id"), shareClassId: str(row, "share_class_id"), kind: str(row, "kind") as ClassAmendmentRecord["kind"],
    effectiveOn: str(row, "effective_on"), authorizedShares: big(opt(row, "authorized_shares")), conversionPrice: opt(row, "conversion_price"), reason: str(row, "reason"),
  }));
  const splits = (await runner.execute<Row>(sql`
    select id, share_class_id, effective_on::text as effective_on, ratio_numerator::text as ratio_numerator, ratio_denominator::text as ratio_denominator
      from equity_splits where ${scope} order by effective_on, created_at, id`)).rows.map((row): SplitRecord => ({
    id: str(row, "id"), shareClassId: str(row, "share_class_id"), effectiveOn: str(row, "effective_on"),
    ratioNumerator: BigInt(str(row, "ratio_numerator")), ratioDenominator: BigInt(str(row, "ratio_denominator")),
  }));
  const plans = (await runner.execute<Row>(sql`
    select id, code, name, share_class_id, effective_on::text as effective_on, initial_reserved_shares::text as initial_reserved_shares,
           recycle_forfeited, recycle_expired, recycle_repurchased
      from equity_plans where ${scope} order by created_at, id`)).rows.map((row): PlanRecord => ({
    id: str(row, "id"), code: str(row, "code"), name: str(row, "name"), shareClassId: str(row, "share_class_id"), effectiveOn: str(row, "effective_on"),
    initialReservedShares: BigInt(str(row, "initial_reserved_shares")), recycleForfeited: row.recycle_forfeited === true,
    recycleExpired: row.recycle_expired === true, recycleRepurchased: row.recycle_repurchased === true,
  }));
  const reserveChanges = (await runner.execute<Row>(sql`
    select id, plan_id, effective_on::text as effective_on, share_delta::text as share_delta
      from equity_plan_reserve_changes where ${scope} order by created_at, id`)).rows.map((row): ReserveChangeRecord => ({
    id: str(row, "id"), planId: str(row, "plan_id"), effectiveOn: str(row, "effective_on"), shareDelta: BigInt(str(row, "share_delta")),
  }));
  const rounds = (await runner.execute<Row>(sql`
    select id, name, share_class_id, closed_on::text as closed_on, price_per_share::text as price_per_share,
           pre_money_valuation::text as pre_money_valuation, currency
      from equity_financing_rounds where ${scope} order by closed_on, created_at, id`)).rows.map((row): FinancingRoundRecord => ({
    id: str(row, "id"), name: str(row, "name"), shareClassId: str(row, "share_class_id"), closedOn: str(row, "closed_on"),
    pricePerShare: str(row, "price_per_share"), preMoneyValuation: str(row, "pre_money_valuation"), currency: str(row, "currency"),
  }));
  const securities = (await runner.execute<Row>(sql`
    select ${SECURITY_COLUMNS} from equity_securities where ${scope} order by created_at, id`)).rows.map(securityFromRow);
  const events = (await runner.execute<Row>(sql`
    select ${EVENT_COLUMNS} from equity_security_events where ${scope} order by created_at, id`)).rows.map(eventFromRow);
  return { classes, amendments, splits, plans, reserveChanges, rounds, securities, events };
}
