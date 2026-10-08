import { add } from '@openbooks/engine/money';

export interface CustomerRecognizedLeg {
  func: string | null;
  day: string;
  recognized: string | number | null;
}

/** Keep the ledger's functional/day grain before presentation-currency rounding. */
export function customerLedgerMonths(legs: readonly CustomerRecognizedLeg[], from: string) {
  const days = new Map<string, { month: string; func: string | null; day: string; recognized: string }>();
  for (const leg of legs) {
    const day = String(leg.day).slice(0, 10);
    if (day < from || leg.recognized == null) continue;
    const key = JSON.stringify([leg.func, day]);
    const current = days.get(key);
    if (current) current.recognized = add(current.recognized, String(leg.recognized));
    else days.set(key, { month: day.slice(0, 7), func: leg.func, day, recognized: String(leg.recognized) });
  }
  return [...days.values()];
}
