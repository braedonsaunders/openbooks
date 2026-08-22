import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { normalizeDecimal, normalizeMoney } from "./money.ts";
import { TAX_DEPRECIATION_REGIMES } from "./tax-depreciation-pool.ts";

/** Persist a pack JSON rate through the FX decimal helper — never as an IEEE-754 number. */
function persistPackFxRate(rate: string | number): string {
  return normalizeDecimal(rate, 10);
}

export interface TaxDepreciationPack {
  code: string;
  countryCode: string;
  name: string;
  calculationModel: "pool" | "macrs";
  classCount: number;
}

export function taxDepreciationPacks(): TaxDepreciationPack[] {
  return Object.values(TAX_DEPRECIATION_REGIMES)
    .map((regime) => ({
      code: regime.code,
      countryCode: regime.countryCode,
      name: regime.name,
      calculationModel: regime.calculationModel,
      classCount: Object.keys(regime.classes).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Seed editable tenant rows from a maintained country pack. Existing tenant
 * overrides are preserved; installing a pack never silently replaces them. */
export async function installTaxDepreciationPack(orgId: string, code: string, actorId: string | null): Promise<{ regimesCreated: number; classesCreated: number }> {
  const regime = TAX_DEPRECIATION_REGIMES[code];
  if (!regime) throw new Error(`unknown tax depreciation pack "${code}"`);

  return db.transaction(async (tx) => {
    const insertedRegime = (await tx.execute<{ id: string }>(sql`
      insert into tax_regimes
        (org_id, code, name, country_code, calculation_model, class_attribute, is_active, created_by, updated_by)
      values (${orgId}, ${regime.code}, ${regime.name}, ${regime.countryCode}, ${regime.calculationModel},
              ${regime.classAttribute}, true, ${actorId}, ${actorId})
      on conflict (org_id, code) do nothing returning id`));

    let classesCreated = 0;
    for (const classDef of Object.values(regime.classes)) {
      const inserted = (await tx.execute<{ id: string }>(sql`
        insert into tax_pool_classes
          (org_id, regime, class_code, name, rate, method, first_year_fraction,
           allow_recapture, allow_terminal_loss, cost_cap, depreciation_system,
           macrs_method, recovery_period_years, convention, is_active, created_by, updated_by)
        values (${orgId}, ${regime.code}, ${classDef.code}, ${classDef.name}, ${persistPackFxRate(classDef.rate)}, ${classDef.method},
                ${persistPackFxRate(classDef.firstYearFraction)}, ${classDef.allowRecapture}, ${classDef.allowTerminalLoss},
                ${classDef.costCap == null ? null : normalizeMoney(classDef.costCap)}, ${classDef.depreciationSystem ?? null}, ${classDef.macrsMethod ?? null},
                ${classDef.recoveryPeriodYears == null ? null : persistPackFxRate(classDef.recoveryPeriodYears)}, ${classDef.convention ?? null}, true, ${actorId}, ${actorId})
        on conflict (org_id, regime, class_code) do nothing returning id`));
      classesCreated += inserted.rows.length;
    }
    return { regimesCreated: insertedRegime.rows.length, classesCreated };
  });
}
