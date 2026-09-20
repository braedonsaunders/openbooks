import { add, mulRatio, neg } from "./money.ts";
/** A frozen service interval: start inclusive, end inclusive. Money is exact;
 * dates count service days, never approximate financial amounts. */
export interface DatedDepreciation {
  startsOn: string;
  date: string;
  amount: string;
}
const day = (date: string) =>
  BigInt(Date.parse(date + "T00:00:00Z") / 86400000);
export function accruedDepreciation(
  line: DatedDepreciation,
  before: string,
): string {
  const start = day(line.startsOn),
    end = day(line.date) + 1n,
    cutoff = day(before);
  if (end <= start)
    throw new Error("depreciation interval must contain service days");
  if (cutoff <= start) return "0.0000";
  return mulRatio(
    line.amount,
    cutoff >= end ? end - start : cutoff - start,
    end - start,
  );
}
export function splitDepreciationPlan(
  plan: DatedDepreciation[],
  before: string,
) {
  let accrued = "0.0000";
  const remaining: DatedDepreciation[] = [];
  for (const line of plan) {
    const used = accruedDepreciation(line, before);
    accrued = add(accrued, used);
    if (line.date >= before)
      remaining.push({
        ...line,
        startsOn: line.startsOn < before ? before : line.startsOn,
        amount: add(line.amount, neg(used)),
      });
  }
  return { accrued, remaining };
}
export function nextCalendarDay(date: string) {
  return new Date(Date.parse(date + "T00:00:00Z") + 86400000)
    .toISOString()
    .slice(0, 10);
}
