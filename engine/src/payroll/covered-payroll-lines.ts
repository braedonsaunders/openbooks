import { parseMoney } from '../money/brands.ts';
import { mulRatio } from '../money/money.ts';
import { assignmentCoveredDays } from './assignment-windows.ts';
import type { Line } from './run-stub-records.ts';

/** Clip native monetary and hours facts to their inclusive coverage; each line retains its own denominator. */
export function coveredPayrollLines(lines: readonly Line[], from: string, to: string,
  periodStart: string, periodEnd: string, useConfigurationWindow = false): Line[] {
  return lines.flatMap(line => {
    const ownFrom = line.earnedFrom ?? (useConfigurationWindow && line.sourceProratedByCoverage ? line.sourceEffectiveFrom : null) ?? periodStart;
    const ownTo = line.earnedTo ?? (useConfigurationWindow && line.sourceProratedByCoverage ? line.sourceEffectiveTo : null) ?? periodEnd;
    const window = assignmentCoveredDays({ effectiveFrom: ownFrom, effectiveTo: ownTo, periodStart: from, periodEnd: to });
    if (window.coveredDays === 0) return [];
    const ownDays = assignmentCoveredDays({ effectiveFrom: from, effectiveTo: to, periodStart: ownFrom, periodEnd: ownTo });
    return [{ ...line, amount: parseMoney(mulRatio(line.amount, BigInt(ownDays.coveredDays), BigInt(ownDays.periodDays))),
      hours: line.hours === undefined ? undefined : mulRatio(line.hours, BigInt(ownDays.coveredDays), BigInt(ownDays.periodDays)) }];
  });
}
