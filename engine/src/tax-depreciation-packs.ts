import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { TAX_DEPRECIATION_REGIMES } from "./tax-depreciation-pool.ts";

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
    const insertedRegime = (await tx.execute(sql`
      insert into tax_regimes
        (org_id, code, name, country_code, calculation_model, class_attribute, is_active, created_by, updated_by)
      values (${orgId}, ${regime.code}, ${regime.name}, ${regime.countryCode}, ${regime.calculationModel},
              ${regime.classAttribute}, true, ${actorId}, ${actorId})
      on conflict (org_id, code) do nothing returning id`)) as unknown as { rows: { id: string }[] };

    let classesCreated = 0;
    for (const classDef of Object.values(regime.classes)) {
      const inserted = (await tx.execute(sql`
        insert into tax_pool_classes
          (org_id, regime, class_code, name, rate, method, first_year_fraction,
           allow_recapture, allow_terminal_loss, cost_cap, depreciation_system,
           macrs_method, recovery_period_years, convention, is_active, created_by, updated_by)
        values (${orgId}, ${regime.code}, ${classDef.code}, ${classDef.name}, ${classDef.rate}, ${classDef.method},
                ${classDef.firstYearFraction}, ${classDef.allowRecapture}, ${classDef.allowTerminalLoss},
                ${classDef.costCap ?? null}, ${classDef.depreciationSystem ?? null}, ${classDef.macrsMethod ?? null},
                ${classDef.recoveryPeriodYears ?? null}, ${classDef.convention ?? null}, true, ${actorId}, ${actorId})
        on conflict (org_id, regime, class_code) do nothing returning id`)) as unknown as { rows: { id: string }[] };
      classesCreated += inserted.rows.length;
    }
    return { regimesCreated: insertedRegime.rows.length, classesCreated };
  });
}
