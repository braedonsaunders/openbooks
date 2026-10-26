import type { FiscalPeriodRef } from "@openbooks/reports";
import { periodDisplayLabel } from "@openbooks/engine/periods/period-policy";

/**
 * A declared accounting-period window labelled like every period list,
 * from its fiscal position and its own bounds: `P05 FY2026 · May 2026`.
 */
export function fiscalPeriodLabel(period: FiscalPeriodRef, locale: string): string {
  return periodDisplayLabel(
    {
      fiscalYear: period.fiscalYear,
      periodNumber: period.periodNumber,
      adjustment: false,
      startsOn: period.from,
      endsOn: period.to,
    },
    locale,
  );
}
