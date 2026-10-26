import { add, cmp } from "../money/money.ts";
import type { CaContributionBases, T4127Input } from "../payroll/canada/t4127.ts";

/** Formula scenarios use wages subject to CPP, EI and QPIP unless a case declares an exclusion. */
export type CanadianWageScenario = Omit<T4127Input, keyof CaContributionBases> &
  Partial<CaContributionBases>;

/** Classify the stated wages before calling the statutory formula; production classifies native earning lines. */
export function assessedCanadianWages(input: CanadianWageScenario): T4127Input {
  const bonus = input.nonPeriodic ?? "0";
  const wages = add(input.income, bonus);
  const pensionable = input.pensionable ?? wages;
  const insurable = input.insurable ?? wages;
  const qpipInsurable = input.qpipInsurable ?? insurable;
  return {
    ...input,
    pensionable,
    insurable,
    qpipInsurable,
    pensionableNonPeriodic:
      input.pensionableNonPeriodic ?? (cmp(pensionable, "0") === 0 ? "0" : bonus),
    insurableNonPeriodic: input.insurableNonPeriodic ?? (cmp(insurable, "0") === 0 ? "0" : bonus),
    qpipNonPeriodic: input.qpipNonPeriodic ?? (cmp(qpipInsurable, "0") === 0 ? "0" : bonus),
  };
}
