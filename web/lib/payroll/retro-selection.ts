import { sum } from "@openbooks/engine/money/money";

interface RetroSelectionPeriod {
  candidate: {
    employeePartyId: string;
    sourcePayRunDocumentId: string;
  };
  difference: { delta: string } | null;
}

export function summarizeRetroSelection<T extends RetroSelectionPeriod>(
  payablePeriods: readonly T[],
  excludedSourcePayRunDocumentIds: readonly string[],
) {
  const excluded = new Set(excludedSourcePayRunDocumentIds);
  const selected = payablePeriods.filter(
    (period) => !excluded.has(period.candidate.sourcePayRunDocumentId),
  );
  const deltas = selected.map((period) => {
    if (!period.difference) {
      throw new Error("payable retro period is missing its calculated difference");
    }
    return period.difference.delta;
  });

  return {
    selected,
    owed: sum(deltas),
    employeeCount: new Set(selected.map((period) => period.candidate.employeePartyId)).size,
  };
}
