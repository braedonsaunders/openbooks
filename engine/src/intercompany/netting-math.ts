/**
 * Pure intercompany netting arithmetic. No database: the netting service
 * loads open items, due-to/due-from positions and rates, then hands them here
 * for a deterministic allocation, and posts exactly what this returns.
 *
 * Signs are from each entity's own point of view: a positive transaction
 * amount is owed TO the entity (a receivable or a debit due-from balance), a
 * negative one is owed BY it. For each pair and currency:
 *
 * 1. Netting: inside one entity, what it is owed by the counterparty is
 *    offset against what it owes the counterparty, oldest first, up to the
 *    smaller of the two. Each entity nets only its own books, so a netting
 *    run never asserts a balance the other entity has not recorded.
 * 2. Cash: when cash settlement is requested, the remaining net amount moves
 *    between the entities' bank accounts. It is the smaller of what the
 *    receiving entity is owed and what the paying entity owes, so neither
 *    entity settles more than its own books show.
 * 3. Any difference between the two entities' views is reported as
 *    unreconciled and stays open.
 *
 * Every settled amount carries its realized exchange difference in the
 * entity's functional currency: the spot translation at the settlement rate
 * against the carrying amount it clears.
 */
import { fromUnits, mulRate, mulRatio, roundDiv, toUnits } from "../money/money.ts";

export type NettingComponentKind = "open_item" | "due_position";

export interface NettingComponent {
  /** Stable identity: the open-item journal line id or a due-position key. */
  key: string;
  pairId: string;
  subsidiaryId: string;
  counterpartySubsidiaryId: string;
  currency: string;
  functionalCurrency: string;
  component: NettingComponentKind;
  accountId: string;
  journalLineId: string | null;
  documentId: string | null;
  partyId: string | null;
  /** Signed open transaction-currency amount, owed-to-entity positive. */
  openTransaction: string;
  /** Signed open functional carrying amount. */
  openCarrying: string;
  /** Oldest-first ordering key (due date, then posting date, then identity). */
  sortKey: string;
}

export interface NettingAllocation extends NettingComponent {
  /** Signed transaction amount cleared by netting inside the entity. */
  netted: string;
  /** Signed transaction amount cleared by cash. */
  cash: string;
  /** Rate from the transaction currency to the entity's functional currency. */
  rate: string;
  /** Signed carrying amount the cleared total releases. */
  carryingCleared: string;
  /** Signed spot translation of the cleared total. */
  spotCleared: string;
  /** Realized exchange difference in functional currency; positive is a gain. */
  realizedFx: string;
}

export interface NettingPairResult {
  pairId: string;
  currency: string;
  fromSubsidiaryId: string;
  toSubsidiaryId: string;
  /** Each entity's own net position before the run (owed-to positive). */
  fromNet: string;
  toNet: string;
  /** fromNet + toNet: zero when the two entities agree. */
  unreconciled: string;
  /** Netted inside each entity. */
  fromNetted: string;
  toNetted: string;
  /** Cash moving between the entities; positive flows to the from-side entity. */
  cashToFrom: string;
  allocations: NettingAllocation[];
}

export class NettingMathError extends Error {
  override readonly name = "NettingMathError";
}

const abs = (units: bigint): bigint => (units < 0n ? -units : units);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

function ordered(components: NettingComponent[]): NettingComponent[] {
  // Open items settle before the running due-to/due-from position, each
  // oldest first; identity breaks ties so the allocation is deterministic.
  return [...components].sort((a, b) => {
    if (a.component !== b.component) return a.component === "open_item" ? -1 : 1;
    if (a.sortKey !== b.sortKey) return a.sortKey < b.sortKey ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** Clear up to `amount` (positive units) across components in order; returns units cleared per key. */
function clearInOrder(
  components: NettingComponent[],
  remaining: Map<string, bigint>,
  amount: bigint,
): Map<string, bigint> {
  const cleared = new Map<string, bigint>();
  let left = amount;
  for (const component of components) {
    if (left === 0n) break;
    const open = remaining.get(component.key) ?? 0n;
    const take = min(abs(open), left);
    if (take === 0n) continue;
    cleared.set(component.key, take);
    remaining.set(component.key, open > 0n ? open - take : open + take);
    left -= take;
  }
  if (left !== 0n)
    throw new NettingMathError("netting allocation exceeded the open amounts it was computed from");
  return cleared;
}

/**
 * The carrying amount a partial settlement releases, proportional to the
 * transaction amount settled; settling the whole open amount releases the
 * whole carrying amount, so no rounding tail is left behind.
 */
export function carryingForSettlement(
  openCarrying: string,
  openTransaction: string,
  settled: string,
): string {
  const openT = abs(toUnits(openTransaction));
  const settledT = abs(toUnits(settled));
  if (settledT === 0n) return "0.0000";
  if (settledT > openT) throw new NettingMathError("a settlement cannot exceed the open amount");
  const carrying = toUnits(openCarrying);
  const magnitude =
    settledT === openT
      ? abs(carrying)
      : toUnits(mulRatio(fromUnits(abs(carrying)), settledT, openT));
  const signed = toUnits(settled) < 0n ? -magnitude : magnitude;
  return fromUnits(signed);
}

/** Spot translation of a signed amount at a positive rate, symmetric in sign. */
export function spotTranslation(amount: string, rate: string): string {
  const units = toUnits(amount);
  const magnitude = toUnits(mulRate(fromUnits(abs(units)), rate));
  return fromUnits(units < 0n ? -magnitude : magnitude);
}

/**
 * Allocate netting and cash settlement for one pair and currency.
 * `rateFor(subsidiaryId)` returns the settlement rate from the currency to
 * that entity's functional currency ("1" when they match).
 */
export function allocatePairNetting(input: {
  pairId: string;
  currency: string;
  fromSubsidiaryId: string;
  toSubsidiaryId: string;
  components: NettingComponent[];
  settleCash: boolean;
  rateFor: (subsidiaryId: string) => string;
}): NettingPairResult {
  if (input.fromSubsidiaryId === input.toSubsidiaryId) {
    throw new NettingMathError("a netting pair must contain two different entities");
  }
  const remaining = new Map<string, bigint>();
  for (const component of input.components) {
    if (remaining.has(component.key)) {
      throw new NettingMathError("a netting component identity must occur only once");
    }
    if (component.pairId !== input.pairId || component.currency !== input.currency) {
      throw new NettingMathError(
        "a netting component does not belong to the pair and currency being allocated",
      );
    }
    if (
      component.subsidiaryId !== input.fromSubsidiaryId &&
      component.subsidiaryId !== input.toSubsidiaryId
    ) {
      throw new NettingMathError("a netting component belongs to neither entity of the pair");
    }
    const counterparty =
      component.subsidiaryId === input.fromSubsidiaryId
        ? input.toSubsidiaryId
        : input.fromSubsidiaryId;
    if (component.counterpartySubsidiaryId !== counterparty) {
      throw new NettingMathError("a netting component must identify the other entity of its pair");
    }
    const open = toUnits(component.openTransaction);
    const carrying = toUnits(component.openCarrying);
    if (open !== 0n && carrying !== 0n && open < 0n !== carrying < 0n) {
      throw new NettingMathError(
        `${component.component === "open_item" ? "open item" : "intercompany position"} ${component.key} carries a functional amount of the opposite sign to its transaction amount`,
      );
    }
    remaining.set(component.key, open);
  }
  const sideOf = (subsidiaryId: string) =>
    ordered(
      input.components.filter(
        (component) =>
          component.subsidiaryId === subsidiaryId && toUnits(component.openTransaction) !== 0n,
      ),
    );
  const nettedBy = new Map<string, bigint>();
  const cashBy = new Map<string, bigint>();
  const nets = new Map<string, bigint>();
  const nettedTotals = new Map<string, bigint>();

  for (const subsidiaryId of [input.fromSubsidiaryId, input.toSubsidiaryId]) {
    const components = sideOf(subsidiaryId);
    const owedTo = components.filter((c) => toUnits(c.openTransaction) > 0n);
    const owedBy = components.filter((c) => toUnits(c.openTransaction) < 0n);
    const totalOwedTo = owedTo.reduce((acc, c) => acc + toUnits(c.openTransaction), 0n);
    const totalOwedBy = owedBy.reduce((acc, c) => acc + abs(toUnits(c.openTransaction)), 0n);
    nets.set(subsidiaryId, totalOwedTo - totalOwedBy);
    const nettable = min(totalOwedTo, totalOwedBy);
    nettedTotals.set(subsidiaryId, nettable);
    for (const [key, units] of clearInOrder(owedTo, remaining, nettable)) nettedBy.set(key, units);
    for (const [key, units] of clearInOrder(owedBy, remaining, nettable)) nettedBy.set(key, -units);
  }

  const fromNet = nets.get(input.fromSubsidiaryId) ?? 0n;
  const toNet = nets.get(input.toSubsidiaryId) ?? 0n;
  let cashToFrom = 0n;
  if (input.settleCash) {
    if (fromNet > 0n && toNet < 0n) cashToFrom = min(fromNet, -toNet);
    else if (fromNet < 0n && toNet > 0n) cashToFrom = -min(-fromNet, toNet);
  }
  if (cashToFrom !== 0n) {
    const receiver = cashToFrom > 0n ? input.fromSubsidiaryId : input.toSubsidiaryId;
    const payer = cashToFrom > 0n ? input.toSubsidiaryId : input.fromSubsidiaryId;
    const amount = abs(cashToFrom);
    const receiverOpen = sideOf(receiver).filter((c) => (remaining.get(c.key) ?? 0n) > 0n);
    const payerOpen = sideOf(payer).filter((c) => (remaining.get(c.key) ?? 0n) < 0n);
    for (const [key, units] of clearInOrder(receiverOpen, remaining, amount))
      cashBy.set(key, units);
    for (const [key, units] of clearInOrder(payerOpen, remaining, amount)) cashBy.set(key, -units);
  }

  const allocations: NettingAllocation[] = [];
  for (const component of ordered(input.components)) {
    const netted = nettedBy.get(component.key) ?? 0n;
    const cash = cashBy.get(component.key) ?? 0n;
    const cleared = netted + cash;
    const rate = input.rateFor(component.subsidiaryId);
    const clearedText = fromUnits(cleared);
    const carryingCleared =
      cleared === 0n
        ? "0.0000"
        : carryingForSettlement(component.openCarrying, component.openTransaction, clearedText);
    const spotCleared = spotTranslation(clearedText, rate);
    allocations.push({
      ...component,
      netted: fromUnits(netted),
      cash: fromUnits(cash),
      rate,
      carryingCleared,
      spotCleared,
      realizedFx: fromUnits(toUnits(spotCleared) - toUnits(carryingCleared)),
    });
  }

  return {
    pairId: input.pairId,
    currency: input.currency,
    fromSubsidiaryId: input.fromSubsidiaryId,
    toSubsidiaryId: input.toSubsidiaryId,
    fromNet: fromUnits(fromNet),
    toNet: fromUnits(toNet),
    unreconciled: fromUnits(fromNet + toNet),
    fromNetted: fromUnits(nettedTotals.get(input.fromSubsidiaryId) ?? 0n),
    toNetted: fromUnits(nettedTotals.get(input.toSubsidiaryId) ?? 0n),
    cashToFrom: fromUnits(cashToFrom),
    allocations,
  };
}

const RATE_SCALE = 10_000_000_000n;
const ONE = 10_000n;

function rateText(units: bigint): string {
  const whole = units / RATE_SCALE;
  if (whole.toString().length > 9) {
    throw new NettingMathError(
      "a carrying-rate translation exceeds the ledger's exchange-rate range",
    );
  }
  return `${whole}.${(units % RATE_SCALE).toString().padStart(10, "0")}`;
}

export interface TranslatedLine {
  /** Signed transaction-currency amount. */
  txnAmount: string;
  /** Positive rate with at most ten decimals. */
  fxRate: string;
  /** Signed functional amount; exactly round(txnAmount × fxRate, 4). */
  amount: string;
}

/**
 * Express a signed transaction amount and the signed functional amount it
 * must carry as ledger lines whose stored functional amount is EXACTLY the
 * rounded product of transaction amount and rate. One line suffices when its
 * ten-decimal rate reproduces the amount; otherwise the amount splits into a
 * body at the carrying rate and a one-unit balancing line whose rate is the
 * remaining functional amount, so a released carrying value is cleared to the
 * last ledger unit at any magnitude.
 */
export function carryingRateLines(txnAmount: string, functionalAmount: string): TranslatedLine[] {
  const t = toUnits(txnAmount);
  const f = toUnits(functionalAmount);
  if (t === 0n) throw new NettingMathError("a translated line needs a non-zero transaction amount");
  if (f === 0n || t < 0n !== f < 0n) {
    throw new NettingMathError(
      "a carrying amount must be non-zero and share the sign of its transaction amount",
    );
  }
  const sign = t < 0n ? -1n : 1n;
  const tAbs = abs(t);
  const fAbs = abs(f);
  const translate = (units: bigint, rateUnits: bigint) => roundDiv(units * rateUnits, RATE_SCALE);
  const single = roundDiv(fAbs * RATE_SCALE, tAbs);
  if (single > 0n && translate(tAbs, single) === fAbs) {
    return [
      {
        txnAmount: fromUnits(sign * tAbs),
        fxRate: rateText(single),
        amount: fromUnits(sign * fAbs),
      },
    ];
  }
  if (tAbs <= ONE)
    throw new NettingMathError("a carrying amount cannot be represented at ledger precision");
  const bodyTxn = tAbs - ONE;
  const bodyAmount = translate(bodyTxn, single);
  const tailAmount = fAbs - bodyAmount;
  if (single <= 0n || tailAmount <= 0n) {
    throw new NettingMathError("a carrying amount cannot be represented at ledger precision");
  }
  // One transaction unit at a rate equal to the remaining functional amount
  // reproduces that amount exactly (the rate has at most four decimals).
  const tailRate = tailAmount * (RATE_SCALE / ONE);
  return [
    {
      txnAmount: fromUnits(sign * bodyTxn),
      fxRate: rateText(single),
      amount: fromUnits(sign * bodyAmount),
    },
    {
      txnAmount: fromUnits(sign * ONE),
      fxRate: rateText(tailRate),
      amount: fromUnits(sign * tailAmount),
    },
  ];
}
