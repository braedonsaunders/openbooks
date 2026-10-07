import { canonicalDecimal } from "../../money/exact-decimal.ts";
import { apportion, fromUnits, roundDiv, toUnits } from "../../money/money.ts";
import { fromQuantityUnits, QUANTITY_SCALE, toQuantityUnits } from "../../money/quantity.ts";
import { InvalidCivilDateError, parseCivilDate } from "../temporal.ts";
import { BenefitsError } from "./errors.ts";

/** Company-defined transaction valuation; source selection and authority belong to the loader. */
export interface TransactionIncentivePolicy {
  readonly currency: string;
  readonly minorUnits: number;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly valuation: "percent_of_amount" | "amount_per_unit";
  /** Plain percent for amount valuation, currency amount for unit valuation. */
  readonly rate: string;
  /** Explicit recipient positions, independent of company titles or vendor fields. */
  readonly recipientShares: readonly { readonly key: string; readonly weight: string }[];
}

export interface IncentiveTransactionFact {
  /** Native document-line identity; the loader records its document revision separately. */
  readonly sourceId: string;
  /** An explicitly selected aggregation dimension, such as a project or department. */
  readonly groupId: string;
  readonly occurredOn: string;
  readonly currency: string;
  readonly amount: string;
  readonly quantity: string;
  /** Dated native responsibility and membership resolution, never a name match. */
  readonly recipients: readonly { readonly shareKey: string; readonly employmentId: string }[];
}

export type TransactionIncentiveLimit =
  | { readonly kind: "none" }
  | { readonly kind: "amount"; readonly amount: string; readonly previouslyAwarded: string }
  | { readonly kind: "percent_of_base"; readonly base: string; readonly rate: string; readonly previouslyAwarded: string };

export interface TransactionIncentiveGroup {
  readonly groupId: string;
  /** Historical consumption comes from settled award evidence, not an assumed payout. */
  readonly limit: TransactionIncentiveLimit;
}

export interface TransactionIncentiveResult {
  readonly currency: string;
  readonly totalAwarded: string;
  readonly recipients: readonly { readonly employmentId: string; readonly value: string }[];
  readonly groups: readonly {
    readonly groupId: string;
    readonly sourceIds: readonly string[];
    readonly measuredValue: string;
    readonly potentialAward: string;
    readonly availableLimit: string | null;
    readonly awarded: string;
    readonly recipients: readonly { readonly employmentId: string; readonly value: string }[];
  }[];
  readonly excluded: readonly { readonly sourceId: string; readonly reason: string }[];
}

function refuse(message: string): never {
  throw new BenefitsError("REFUSED", message);
}

function units(value: string, label: string): bigint {
  const canonical = canonicalDecimal(value, 4);
  if (canonical === null) {
    throw new BenefitsError("INVALID_INPUT", `${label} is not an exact decimal with at most four fraction digits — review the recorded amount before valuing transactions`);
  }
  return toUnits(canonical);
}

function key(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BenefitsError("INVALID_INPUT", `${label} is missing — select an explicit native source, grouping and recipient position`);
  }
  return value;
}

function day(value: string, label: string): string {
  try { return parseCivilDate(value); }
  catch (error) {
    if (!(error instanceof InvalidCivilDateError)) throw error;
    throw new BenefitsError("INVALID_INPUT", `${label} is not a real YYYY-MM-DD date — correct the recorded period or transaction date`);
  }
}

/**
 * Each group rounds its pool once to the currency quantum, then uses the
 * shared largest-remainder allocator. Transaction/position products remain
 * integer weights until that split; a small transaction never loses its
 * share through an intermediate rounded employee payout. Groups and native
 * recipient identities sort before residual allocation, making replay
 * independent of query order. Limits floor to the currency quantum so a
 * payable unit cannot exceed the configured ceiling.
 *
 * This function does not authorize settlement or create awards. The caller
 * must resolve dated responsibilities, lock the native sources and historical
 * cap consumption, and persist the accepted policy/source snapshot through
 * the existing award lifecycle.
 */
export function computeTransactionIncentive(
  policy: TransactionIncentivePolicy,
  facts: readonly IncentiveTransactionFact[],
  groups: readonly TransactionIncentiveGroup[],
): TransactionIncentiveResult {
  if (!/^[A-Z]{3}$/.test(policy.currency) || !Number.isInteger(policy.minorUnits) || policy.minorUnits < 0 || policy.minorUnits > 4) {
    throw new BenefitsError("INVALID_INPUT", "resolve an ISO currency and its registered zero-to-four minor units before valuing transaction incentives");
  }
  const from = day(policy.periodFrom, "period start"), to = day(policy.periodTo, "period end");
  if (from > to) refuse("the transaction period ends before it starts — correct the period selection");
  if (policy.valuation !== "percent_of_amount" && policy.valuation !== "amount_per_unit") {
    throw new BenefitsError("INVALID_INPUT", "select percent of amount or amount per unit before valuing transactions");
  }
  const rate = units(policy.rate, "valuation rate");
  if (rate <= 0n) refuse("the valuation rate must be positive — configure the program rate before valuing transactions");
  const shares = new Map<string, bigint>();
  for (const share of policy.recipientShares) {
    const shareKey = key(share.key, "recipient position"), weight = units(share.weight, `weight for ${shareKey}`);
    if (shares.has(shareKey)) refuse(`recipient position ${shareKey} is configured twice — keep one share per position`);
    if (weight <= 0n) refuse(`recipient position ${shareKey} has no positive share — configure its weight or remove the position`);
    shares.set(shareKey, weight);
  }
  if (shares.size === 0) refuse("no recipient shares are configured — add the positions that receive the transaction incentive");
  const limits = new Map<string, TransactionIncentiveLimit>();
  const quantum = 10n ** BigInt(4 - policy.minorUnits);
  const available = new Map<string, bigint | null>();
  for (const group of groups) {
    const groupId = key(group.groupId, "group identity");
    if (limits.has(groupId)) refuse(`group ${groupId} has overlapping limits — retain one explicit limit decision per group`);
    limits.set(groupId, group.limit);
    const limit = group.limit;
    if (limit.kind === "none") { available.set(groupId, null); continue; }
    if (limit.kind !== "amount" && limit.kind !== "percent_of_base") {
      throw new BenefitsError("INVALID_INPUT", `group ${groupId} needs an explicit limit kind — select no limit, a monetary ceiling, or a percentage of a recorded base`);
    }
    const prior = units(limit.previouslyAwarded, `prior awards for ${groupId}`);
    const base = units(limit.kind === "amount" ? limit.amount : limit.base, `limit base for ${groupId}`);
    if (prior < 0n || base < 0n) refuse(`group ${groupId} has a negative ceiling or consumption — reconcile its adjusting awards and limit evidence`);
    if (prior % quantum !== 0n) refuse(`group ${groupId} has prior awards finer than payable precision — reconcile its stored currency evidence`);
    let ceiling: bigint;
    if (limit.kind === "amount") {
      if (base % quantum !== 0n) refuse(`group ${groupId} has a ceiling finer than payable precision — configure a payable monetary ceiling`);
      ceiling = base;
    } else {
      const capRate = units(limit.rate, `limit rate for ${groupId}`);
      if (capRate < 0n) refuse(`group ${groupId} has a negative limit rate — configure a non-negative percentage`);
      ceiling = base * capRate / (1_000_000n * quantum) * quantum;
    }
    available.set(groupId, ceiling > prior ? ceiling - prior : 0n);
  }
  const sourceIds = new Set<string>();
  const byGroup = new Map<string, { base: bigint; sourceIds: string[]; weights: Map<string, bigint> }>();
  const excluded: { sourceId: string; reason: string }[] = [];
  for (const fact of [...facts].sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0)) {
    const sourceId = key(fact.sourceId, "transaction identity"), groupId = key(fact.groupId, "transaction group");
    if (sourceIds.has(sourceId)) refuse(`transaction ${sourceId} appears more than once — resolve the duplicated source before settlement`);
    sourceIds.add(sourceId);
    const occurredOn = day(fact.occurredOn, `date for ${sourceId}`);
    if (occurredOn < from || occurredOn > to) refuse(`transaction ${sourceId} is outside the selected period — reselect the source period`);
    if (fact.currency !== policy.currency) refuse(`transaction ${sourceId} uses ${fact.currency}, not ${policy.currency} — select a program in that currency; an incentive never invents an exchange rate`);
    if (!limits.has(groupId)) refuse(`group ${groupId} has no limit decision — configure its ceiling or explicitly select no limit`);
    const amount = units(fact.amount, `amount for ${sourceId}`), canonicalQuantity = canonicalDecimal(fact.quantity, 8);
    if (canonicalQuantity === null) throw new BenefitsError("INVALID_INPUT", `quantity for ${sourceId} is not an exact decimal with at most eight fraction digits — review its native transaction quantity`);
    const quantity = toQuantityUnits(canonicalQuantity);
    if (amount < 0n || quantity < 0n) refuse(`transaction ${sourceId} is a credit or reversal — review its original award and create an adjusting award; a fresh positive settlement cannot reinterpret negative sources`);
    const base = policy.valuation === "percent_of_amount" ? amount : quantity;
    if (base === 0n) { excluded.push({ sourceId, reason: "The explicitly selected valuation base is zero; no award is owed." }); continue; }
    const bindings = new Map<string, string>();
    for (const recipient of fact.recipients) {
      const shareKey = key(recipient.shareKey, "recipient position"), employmentId = key(recipient.employmentId, "recipient employment");
      if (!shares.has(shareKey) || bindings.has(shareKey)) refuse(`transaction ${sourceId} has an unknown or repeated recipient position ${shareKey} — reconcile its dated responsibility assignments`);
      bindings.set(shareKey, employmentId);
    }
    for (const shareKey of shares.keys()) {
      if (!bindings.has(shareKey)) refuse(`transaction ${sourceId} has no recipient for ${shareKey} — record its dated responsibility and program membership; an absent share is never silently redistributed`);
    }
    const group = byGroup.get(groupId) ?? { base: 0n, sourceIds: [], weights: new Map<string, bigint>() };
    group.base += base;
    group.sourceIds.push(sourceId);
    for (const [shareKey, employmentId] of bindings) {
      group.weights.set(employmentId, (group.weights.get(employmentId) ?? 0n) + base * shares.get(shareKey)!);
    }
    byGroup.set(groupId, group);
  }
  const totals = new Map<string, bigint>();
  const results: TransactionIncentiveResult["groups"][number][] = [];
  for (const [groupId, group] of [...byGroup].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const divisor = policy.valuation === "percent_of_amount" ? 1_000_000n : QUANTITY_SCALE;
    const potential = roundDiv(group.base * rate, divisor * quantum);
    const room = available.get(groupId)!;
    const payable = room === null || potential * quantum <= room ? potential : room / quantum;
    const weights = [...group.weights].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const amounts = apportion(payable, weights.map(([, weight]) => weight));
    const recipients = weights.map(([employmentId], i) => {
      const value = amounts[i]! * quantum;
      totals.set(employmentId, (totals.get(employmentId) ?? 0n) + value);
      return { employmentId, value: fromUnits(value) };
    });
    results.push({ groupId, sourceIds: group.sourceIds, measuredValue: policy.valuation === "percent_of_amount" ? fromUnits(group.base) : fromQuantityUnits(group.base), potentialAward: fromUnits(potential * quantum), availableLimit: room === null ? null : fromUnits(room), awarded: fromUnits(payable * quantum), recipients });
  }
  return {
    currency: policy.currency,
    totalAwarded: fromUnits([...totals.values()].reduce((sum, value) => sum + value, 0n)),
    recipients: [...totals].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).filter(([, value]) => value !== 0n).map(([employmentId, value]) => ({ employmentId, value: fromUnits(value) })),
    groups: results,
    excluded,
  };
}
