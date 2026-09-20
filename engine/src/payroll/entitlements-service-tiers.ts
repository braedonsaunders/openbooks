const at = (value: string) => new Date(`${value}T00:00:00Z`);
const lastDayOfMonth = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();

/**
 * Completed months of continuous service between two ISO dates.
 *
 * The anniversary day matters: hired 2025-01-15, asked on 2026-01-14 is 11
 * months (not yet eligible); on 2026-01-15 it is exactly 12. A hire date past
 * the end of the asked month clamps to that month's last day, so someone hired
 * 31 January reaches one month on 28 February — the same convention every
 * handbook uses and the one anniversary arithmetic would otherwise get wrong.
 *
 * The result is signed: a date before the hire date returns a negative count,
 * so no tier (afterMonths ≥ 0) can match a period the employee had not started.
 */
export function monthsOfService(hiredOn: string, onDate: string): number {
  const hired = at(hiredOn);
  const asked = at(onDate);
  let months = (asked.getUTCFullYear() - hired.getUTCFullYear()) * 12
    + (asked.getUTCMonth() - hired.getUTCMonth());
  const anniversaryDay = Math.min(hired.getUTCDate(), lastDayOfMonth(asked));
  if (asked.getUTCDate() < anniversaryDay) months -= 1;
  return months;
}

export interface ServiceTierRow {
  id: string;
  planId: string | null;
  componentId: string | null;
  afterMonths: number;
  accrualValue: string | null;
  eligible: boolean | null;
  isActive: boolean;
}

/**
 * The rung reached on one target's ladder: the highest afterMonths ≤ service.
 * Pure. Returns null when the employee has not reached the first rung.
 */
export function pickServiceTier(
  rows: readonly ServiceTierRow[],
  months: number,
): ServiceTierRow | null {
  let best: ServiceTierRow | null = null;
  for (const row of rows) {
    if (!row.isActive) continue;
    if (row.afterMonths > months) continue;
    if (best === null || row.afterMonths > best.afterMonths) best = row;
  }
  return best;
}

/** Everything service tiers decide for one employee on one date. */
export interface ResolvedServiceTiers {
  hiredOn: string | null;
  /** Completed months of continuous service; null when no hire date is on file. */
  months: number | null;
  /** planId → accrual value the reached rung raises the plan to. */
  planAccrualValues: Map<string, string>;
  /** componentId → whether service has made the component eligible. */
  componentEligibility: Map<string, boolean>;
}

/** Group tier rows by target and resolve each ladder. Pure. */
export function resolveServiceTiersFrom(
  rows: readonly ServiceTierRow[],
  months: number | null,
  hiredOn: string | null,
): ResolvedServiceTiers {
  const planAccrualValues = new Map<string, string>();
  const componentEligibility = new Map<string, boolean>();
  if (months === null) return { hiredOn, months, planAccrualValues, componentEligibility };

  const byPlan = new Map<string, ServiceTierRow[]>();
  const byComponent = new Map<string, ServiceTierRow[]>();
  for (const row of rows) {
    if (row.planId) {
      const list = byPlan.get(row.planId) ?? [];
      list.push(row);
      byPlan.set(row.planId, list);
    } else if (row.componentId) {
      const list = byComponent.get(row.componentId) ?? [];
      list.push(row);
      byComponent.set(row.componentId, list);
    }
  }
  for (const [planId, list] of byPlan) {
    const tier = pickServiceTier(list, months);
    if (tier?.accrualValue != null) planAccrualValues.set(planId, tier.accrualValue);
  }
  for (const [componentId, list] of byComponent) {
    const tier = pickServiceTier(list, months);
    if (tier?.eligible != null) componentEligibility.set(componentId, tier.eligible);
  }
  return { hiredOn, months, planAccrualValues, componentEligibility };
}
