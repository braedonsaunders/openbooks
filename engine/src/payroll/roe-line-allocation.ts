import { add, cmp } from "../money/money.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { PayrollError } from "./error.ts";
import type { RoeWindowStub } from "./roe-reporting-window.ts";

export type RoeRetainedLine = {
  lineId: string;
  stubId: string;
  amount: string;
  hours: string | null;
  evidenceId: string | null;
  snapshotMatches: boolean | null;
  isInsurable: boolean | null;
  insurableHours: string | null;
  reportPeriodStart: string | null;
  reportPeriodEnd: string | null;
  earnedFrom: string | null;
  earnedTo: string | null;
  reportingBasis?: "service" | "separation_payment";
  separationEventId?: string | null;
  separationBasisMatches?: boolean | null;
};
/** Allocate only fully qualified line sets, preserving the committed insurable base exactly. */
export function roeQualifiedLineAllocations(
  stub: RoeWindowStub,
  lines: readonly RoeRetainedLine[],
): RoeWindowStub[] {
  if (!lines.some((line) => line.evidenceId !== null)) return [stub];
  if (
    lines.some(
      (line) =>
        line.stubId !== stub.id ||
        !line.evidenceId ||
        line.snapshotMatches !== true ||
        typeof line.isInsurable !== "boolean" ||
        line.insurableHours === null ||
        !line.reportPeriodStart ||
        !line.reportPeriodEnd ||
        (line.reportingBasis === "separation_payment"
          ? !line.separationEventId ||
            line.separationBasisMatches !== true ||
            !line.isInsurable ||
            cmp(line.insurableHours, "0") !== 0
          : !line.earnedFrom || !line.earnedTo),
    )
  )
    throw new PayrollError(
      "ROE line attribution is incomplete or no longer matches retained payroll — qualify every material earning line before filing",
    );
  if (
    new Set(lines.map((line) => line.lineId)).size !== lines.length ||
    lines.some((line) => line.isInsurable === false && cmp(line.insurableHours!, "0") !== 0)
  )
    throw new PayrollError("ROE line evidence has duplicate earning identities or uninsured hours");
  const insured = lines.reduce(
    (total, line) => (line.isInsurable ? add(total, line.amount) : total),
    "0",
  );
  if (cmp(insured, stub.insurableEarnings) !== 0)
    throw new PayrollError(
      "Qualified ROE line classifications do not reproduce the committed insurable-earnings base — review the original insurance treatment",
    );
  const allocations = new Map<string, RoeWindowStub>();
  for (const line of lines) {
    if (!line.isInsurable) continue;
    const start = line.reportPeriodStart!,
      end = line.reportPeriodEnd!,
      from = line.earnedFrom,
      to = line.earnedTo;
    const separation = line.reportingBasis === "separation_payment";
    if (
      ![start, end].every(isIsoCalendarDate) ||
      start > end ||
      (!separation && (!from || !to || ![from, to].every(isIsoCalendarDate) || from > to)) ||
      (separation &&
        (cmp(line.amount, "0") <= 0 || (line.hours !== null && cmp(line.hours, "0") !== 0))) ||
      cmp(line.insurableHours!, "0") < 0 ||
      (line.hours !== null && cmp(line.hours, line.insurableHours!) !== 0)
    )
      throw new PayrollError(
        "ROE line evidence has invalid allocation dates or conflicts with retained paid hours",
      );
    const key = start + ":" + end + (separation ? ":separation:" + line.separationEventId : ""),
      prior = allocations.get(key);
    if (prior) {
      prior.insurableEarnings = add(prior.insurableEarnings, line.amount);
      prior.insurableHours = add(prior.insurableHours, line.insurableHours!);
      if (from !== null && (prior.earnedFrom === null || from < prior.earnedFrom))
        prior.earnedFrom = from;
      if (to !== null && (prior.earnedTo === null || to > prior.earnedTo)) prior.earnedTo = to;
    } else
      allocations.set(key, {
        ...stub,
        allocationKey: key,
        reportPeriodStart: start,
        reportPeriodEnd: end,
        insurableEarnings: line.amount,
        insurableHours: line.insurableHours!,
        hoursBasisQualified: true,
        earnedDatesComplete: from !== null && to !== null,
        earnedFrom: from,
        earnedTo: to,
        ...(separation ? { separationEventId: line.separationEventId! } : {}),
        reportingEvidenceIds: lines.map((line) => line.evidenceId!),
      });
  }
  // A fully classified uninsured stub still establishes actual no-insured-pay
  // scope in its native period; it contributes no earnings or hours.
  if (!allocations.size)
    return [
      {
        ...stub,
        insurableEarnings: "0",
        insurableHours: "0",
        hoursBasisQualified: true,
        reportingEvidenceIds: lines.map((line) => line.evidenceId!),
      },
    ];
  return [...allocations.values()];
}
