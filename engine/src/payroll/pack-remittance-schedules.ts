/** Statutory remittance declarations and schedules. Split from packs.ts (ARCH-FILE-SPLIT; pure moves only). */
import { type PayrollCountryPack, type PayrollRemittanceFrequencyBand, type PayrollRemittanceSchedule, type StatutoryRemittanceDeclaration } from "./pack-types"
import { PAYROLL_COUNTRY_PACKS, payrollPack } from "./pack-registry"
import { declaredJurisdictions, payrollJurisdictionDeclared } from "./pack-jurisdictions"
import { cmp } from "../money/money.ts"
import { PayrollPackError } from "./payroll-error.ts"

// ---------------------------------------------------------------------------
// Destination remittance schedules — the pack declarations due dates compute from
// ---------------------------------------------------------------------------

export function statutoryRemittanceDeclaration(country: string): StatutoryRemittanceDeclaration {
  const pack = payrollPack(country);
  const internal = new Set<string>();
  const remitted = new Set<string>();
  const vendorKey = new Map<string, string | null>();
  const regionalVendorKey = new Map<string, Readonly<Record<string, string>>>();
  const legacyKey = new Map<string, string>();
  for (const slot of pack.statutorySlots) {
    for (const component of slot.components) {
      (component.remittance === "internal_accrual" ? internal : remitted)
        .add(component.systemKey);
      if (component.remittance === "tax_authority") {
        // The vendor is the pack's single remittanceVendorSettingsKey, so one
        // pack cannot map one system key to two vendors — the type is the
        // guard, and there is no cross-pack comparison left to make.
        vendorKey.set(component.systemKey, pack.remittanceVendorSettingsKey);
      }
      if (component.regionalRemittanceVendorSettingsKeys) {
        const declared = component.regionalRemittanceVendorSettingsKeys;
        const existing = regionalVendorKey.get(component.systemKey);
        if (existing) {
          for (const [region, key] of Object.entries(declared)) {
            if (region in existing && existing[region] !== key) {
              throw new PayrollPackError(
                `the ${country} payroll pack declares different ${region} remittance vendors for ${component.systemKey}`,
              );
            }
          }
          regionalVendorKey.set(component.systemKey, { ...existing, ...declared });
        } else {
          regionalVendorKey.set(component.systemKey, declared);
        }
      }
      if (slot.legacySettingsKey) {
        const existing = legacyKey.get(component.systemKey);
        if (existing !== undefined && existing !== slot.legacySettingsKey) {
          throw new PayrollPackError(
            `the ${country} payroll pack declares different legacy accounts for ${component.systemKey}`,
          );
        }
        legacyKey.set(component.systemKey, slot.legacySettingsKey);
      }
    }
  }
  for (const systemKey of internal) {
    if (remitted.has(systemKey)) {
      throw new PayrollPackError(
        `the ${country} payroll pack declares ${systemKey} both internal_accrual and remittable`,
      );
    }
  }
  return {
    internalAccrualSystemKeys: [...internal],
    vendorSettingsKeyBySystemKey: vendorKey,
    regionalVendorSettingsKeyBySystemKey: regionalVendorKey,
    legacyLiabilitySettingsKeyBySystemKey: legacyKey,
  };
}

/**
 * Every pack's destination remittance schedules, validated at collection so
 * a bad declaration stops the process that reads it rather than dating a
 * bill from it. A schedule whose `defaultFrequency` names no band, whose
 * band has its floor at or above its ceiling, or whose calendar no pack
 * declares is refused by name — the same fail-fast posture as the component
 * declarations above.
 */
export function allRemittanceSchedules(
  packs: Record<string, PayrollCountryPack> = PAYROLL_COUNTRY_PACKS,
): PayrollRemittanceSchedule[] {
  const schedules = Object.entries(packs).flatMap(([country, pack]) =>
    (pack.remittanceSchedules ?? []).map((schedule) => ({ country, schedule })),
  );
  for (const { country, schedule } of schedules) {
    const where = `the ${country} payroll pack's remittance schedule for ${schedule.vendorSettingsKey || "(no vendor key)"}`;
    if (!schedule.vendorSettingsKey) throw new PayrollPackError(`${where} names no vendor settings key`);
    if (!schedule.authority?.trim()) throw new PayrollPackError(`${where} names no receiving authority`);
    if (schedule.sources.length === 0) throw new PayrollPackError(`${where} cites no published source`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(schedule.effectiveFrom)) {
      throw new PayrollPackError(`${where} has no effective-from date`);
    }
    if (schedule.effectiveTo !== undefined
      && (!/^\d{4}-\d{2}-\d{2}$/.test(schedule.effectiveTo) || schedule.effectiveTo <= schedule.effectiveFrom)) {
      throw new PayrollPackError(`${where} has an effective range that ends before it opens`);
    }
    if (!schedule.calendar) throw new PayrollPackError(`${where} names no due-date calendar`);
    if (!payrollJurisdictionDeclared(schedule.calendar)) {
      throw new PayrollPackError(
        `${where} moves deadlines against "${schedule.calendar}", which no payroll pack declares — ` +
        `declare it in engine/src/payroll/packs.ts (declared: ${
          declaredJurisdictions().map((j) => j.key).join(", ")})`,
      );
    }
    if (!schedule.frequencySettingsKey) throw new PayrollPackError(`${where} names no frequency settings key`);
    if (schedule.frequencies.length === 0) throw new PayrollPackError(`${where} declares no frequencies`);
    const names = new Set(schedule.frequencies.map((band) => band.frequency));
    if (names.size !== schedule.frequencies.length) {
      throw new PayrollPackError(`${where} declares a frequency twice`);
    }
    if (!names.has(schedule.defaultFrequency)) {
      throw new PayrollPackError(
        `${where} defaults to "${schedule.defaultFrequency}", which is not one of its declared frequencies`,
      );
    }
    for (const band of schedule.frequencies) {
      switch (band.due.kind) {
        case "month_day":
        case "quarter_day":
        case "split_month":
          break;
        case "quarter_month_working_days":
          if (!Number.isInteger(band.due.workingDays) || band.due.workingDays < 1) {
            throw new PayrollPackError(
              `${where} counts no positive working days for its ${band.frequency} frequency`,
            );
          }
          break;
        default:
          throw new PayrollPackError(
            `${where} declares an unknown due-date rule kind for its ${band.frequency} frequency`,
          );
      }
      if (!band.rule?.trim()) {
        throw new PayrollPackError(`${where} states no due-date rule for its ${band.frequency} frequency`);
      }
      if (band.due.kind === "split_month" && !band.ruleSecondHalf?.trim()) {
        throw new PayrollPackError(
          `${where} states no second-half due-date rule for its ${band.frequency} frequency`,
        );
      }
      if (band.averageMonthlyMin !== undefined && band.averageMonthlyMaxExclusive !== undefined
        && cmp(band.averageMonthlyMin, band.averageMonthlyMaxExclusive) >= 0) {
        throw new PayrollPackError(`${where} has an empty average-monthly band for its ${band.frequency} frequency`);
      }
    }
  }
  for (let i = 0; i < schedules.length; i += 1) {
    for (let j = i + 1; j < schedules.length; j += 1) {
      const a = schedules[i]!;
      const b = schedules[j]!;
      if (a.schedule.vendorSettingsKey !== b.schedule.vendorSettingsKey) continue;
      const aTo = a.schedule.effectiveTo ?? "9999-12-31";
      const bTo = b.schedule.effectiveTo ?? "9999-12-31";
      if (a.schedule.effectiveFrom < bTo && b.schedule.effectiveFrom < aTo) {
        throw new PayrollPackError(
          `two payroll packs declare overlapping remittance schedules for ${a.schedule.vendorSettingsKey}`,
        );
      }
    }
  }
  return schedules.map(({ schedule }) => schedule);
}

/**
 * The schedule version governing one destination on one period-end date, or
 * null when no pack declares the destination — which keeps the legacy
 * CRA-function behaviour for undeclared destinations. Pure over an explicit
 * list, so the effective-dating is verifiable without a database.
 */
export function remittanceScheduleInForce(
  vendorSettingsKey: string,
  date: string,
  schedules: readonly PayrollRemittanceSchedule[] = allRemittanceSchedules(),
): PayrollRemittanceSchedule | null {
  const covering = schedules
    .filter((schedule) => schedule.vendorSettingsKey === vendorSettingsKey
      && schedule.effectiveFrom <= date
      && (schedule.effectiveTo === undefined || date < schedule.effectiveTo));
  covering.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  return covering[0] ?? null;
}

/** The declared frequency band, or null when the frequency names nothing. */
export function remittanceFrequencyBand(
  schedule: PayrollRemittanceSchedule,
  frequency: string,
): PayrollRemittanceFrequencyBand | null {
  return schedule.frequencies.find((band) => band.frequency === frequency) ?? null;
}

/**
 * The frequency band an average monthly remittance falls in, or null when no
 * band covers it — which is a declaration gap, never a default. The bands'
 * bounds are decimal strings compared exactly; a value on a shared boundary
 * belongs to the higher band (each ceiling is exclusive, each floor inclusive).
 */
export function remittanceBandForAverage(
  schedule: PayrollRemittanceSchedule,
  averageMonthly: string,
): PayrollRemittanceFrequencyBand | null {
  return schedule.frequencies.find((band) =>
    (band.averageMonthlyMin === undefined || cmp(averageMonthly, band.averageMonthlyMin) >= 0)
    && (band.averageMonthlyMaxExclusive === undefined
      || cmp(averageMonthly, band.averageMonthlyMaxExclusive) < 0),
  ) ?? null;
}

/**
 * ONE pack's destination remittance schedules (see `remittanceSchedules` on
 * the pack). Empty when the pack declares none — the US pack's federal
 * deposits ride EFTPS on no declared timetable.
 */
export function packRemittanceSchedules(country: string): readonly PayrollRemittanceSchedule[] {
  return PAYROLL_COUNTRY_PACKS[country]?.remittanceSchedules ?? [];
}

/**
 * The schedule owning a frequency settings key, or null when no pack
 * declares it. The settings route validates a new schedule's frequency the
 * moment its pack declares both halves.
 */
export function remittanceScheduleForFrequencyKey(
  frequencySettingsKey: string,
): PayrollRemittanceSchedule | null {
  return allRemittanceSchedules()
    .find((schedule) => schedule.frequencySettingsKey === frequencySettingsKey) ?? null;
}

/**
 * Every orgs.settings.payroll key any pack declares as a destination
 * remittance frequency — the same derivation pattern as the vendor keys, so
 * the settings route accepts a new schedule's frequency the moment its pack
 * declares it.
 */
export function declaredRemittanceFrequencySettingsKeys(): string[] {
  return allRemittanceSchedules().map((schedule) => schedule.frequencySettingsKey);
}

/**
 * Every orgs.settings.payroll key any pack declares as a statutory remittance
 * vendor — the pack-level keys plus the regional overrides. The settings API
 * accepts exactly this set, so a new pack's vendor field exists the moment
 * the pack declares it and the route never carries a literal list.
 */
export function declaredRemittanceVendorSettingsKeys(): string[] {
  const keys = new Set<string>();
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    for (const key of packRemittanceVendorSettingsKeys(country)) keys.add(key);
  }
  return [...keys];
}

/**
 * ONE pack's statutory remittance vendor settings keys — the pack-level key
 * plus every regional override its components declare (the CA pack yields the
 * CRA vendor and the Revenu Québec vendor). The payroll setup wizard renders
 * its vendors step from exactly this declaration, so a new pack's vendor
 * fields appear the moment the pack declares them.
 */
export function packRemittanceVendorSettingsKeys(country: string): string[] {
  const pack = PAYROLL_COUNTRY_PACKS[country];
  if (!pack) return [];
  const keys = new Set<string>();
  if (pack.remittanceVendorSettingsKey) keys.add(pack.remittanceVendorSettingsKey);
  for (const slot of pack.statutorySlots) {
    for (const component of slot.components) {
      for (const key of Object.values(component.regionalRemittanceVendorSettingsKeys ?? {})) {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

/**
 * Whether destinations `country`'s pack declares but leaves unscheduled may
 * fall back to the legacy registration timetable instead of refusing (see
 * `allowsRegistrationTimetableFallback`). Unknown countries — and packs that
 * do not declare it — refuse: an undated destination must never borrow
 * another authority's timetable.
 */
export function packAllowsRegistrationTimetableFallback(country: string): boolean {
  const pack = PAYROLL_COUNTRY_PACKS[country];
  if (!pack) return false;
  return pack.allowsRegistrationTimetableFallback ?? false;
}

/**
 * The legacy (pre-pack) liability account for a statutory system key, read
 * from the raw orgs.settings.payroll blob via the SLOT's own declaration.
 *
 * This replaces the literal map the GL projection and the remittance summary
 * each carried (`cpp2` merged into the CPP payable, `qpip` into the EI
 * payable, and no row at all for any third pack). The merges themselves were
 * correct — the CA pack DECLARES them, on the cpp and qpip slots — so behavior
 * is identical; what is gone is the generic layer knowing any of it.
 */
export function legacyStatutoryLiabilityAccount(
  systemKey: string,
  payrollSettingsBlob: Record<string, unknown>,
  country: string | null,
): string | null {
  // Country-first: the slot's declaration for the COMPONENT's pack country. A
  // row naming no country (shared baseline, user components) or a country
  // with no pack carries no pack declaration — the same null as a system key
  // no pack declares, resolved by the caller's undeclared paths.
  if (!country || !PAYROLL_COUNTRY_PACKS[country]) return null;
  const key = statutoryRemittanceDeclaration(country).legacyLiabilitySettingsKeyBySystemKey.get(systemKey);
  if (!key) return null;
  const value = payrollSettingsBlob[key];
  return typeof value === "string" && value ? value : null;
}
