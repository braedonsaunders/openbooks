/**
 * Installed/effective tax classification. Pool-run and workpaper GET/POST
 * share this so a category key used by several builtins (tax_pool_class)
 * cannot invent a regime whose class table does not contain that code.
 */
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import {
  TAX_DEPRECIATION_REGIMES,
  type PoolClassDef,
} from "./depreciation-pool.ts";
import {
  TAX_BASIS_REGIME_LABELS,
  TAX_BASIS_REGIMES,
  type TaxBasisRegime,
} from "./asset-basis-policy.ts";

export type ClassifiedRegime = { code: TaxBasisRegime; name: string; classCode: string };

export type RegimeClassSpec = {
  code: TaxBasisRegime;
  name: string;
  classAttribute: string;
  validClasses: ReadonlySet<string>;
};

export async function loadRegimeClassificationContext(
  tx: SqlExecutor,
  orgId: string,
): Promise<RegimeClassSpec[]> {
  const available = await availableTaxRegimes(tx, orgId);
  const specs: RegimeClassSpec[] = [];
  for (const regime of available) {
    if (!(TAX_BASIS_REGIMES as readonly string[]).includes(regime.code)) continue;
    const code = regime.code as TaxBasisRegime;
    const classes = await effectiveClasses(tx, orgId, code);
    specs.push({
      code,
      name: TAX_BASIS_REGIME_LABELS[code] ?? regime.name,
      classAttribute: regime.classAttribute,
      validClasses: new Set(classes.keys()),
    });
  }
  return specs;
}

export function classifyAssetFromContext(
  custom: unknown,
  taxAttributes: unknown,
  context: readonly RegimeClassSpec[],
): ClassifiedRegime[] {
  const root =
    custom && typeof custom === "object" && !Array.isArray(custom)
      ? (custom as Record<string, unknown>).taxDepreciation
      : null;
  const tax =
    taxAttributes && typeof taxAttributes === "object" && !Array.isArray(taxAttributes)
      ? (taxAttributes as Record<string, unknown>)
      : {};
  const classified: ClassifiedRegime[] = [];
  for (const spec of context) {
    const override =
      root && typeof root === "object" && !Array.isArray(root)
        ? (root as Record<string, unknown>)[spec.code]
        : null;
    const classCode = String(
      (override && typeof override === "object" && !Array.isArray(override)
        ? (override as Record<string, unknown>).classCode
        : "") ||
        tax[spec.classAttribute] ||
        "",
    ).trim();
    if (!classCode || !spec.validClasses.has(classCode)) continue;
    classified.push({ code: spec.code, name: spec.name, classCode });
  }
  return classified;
}

export async function classifyAssetRegimes(
  tx: SqlExecutor,
  orgId: string,
  custom: unknown,
  taxAttributes: unknown,
): Promise<ClassifiedRegime[]> {
  return classifyAssetFromContext(custom, taxAttributes, await loadRegimeClassificationContext(tx, orgId));
}

export async function regimeClassAttribute(tx: SqlExecutor, orgId: string, regime: string): Promise<string> {
  const row = (
    await tx.execute<{ class_attribute: string }>(sql`
      select class_attribute from tax_regimes
       where org_id = ${orgId} and code = ${regime} and is_active
       limit 1`)
  ).rows[0];
  return row?.class_attribute ?? TAX_DEPRECIATION_REGIMES[regime]?.classAttribute ?? "tax_pool_class";
}

export async function effectiveClasses(
  tx: SqlExecutor,
  orgId: string,
  regime: string,
): Promise<Map<string, PoolClassDef>> {
  const map = new Map<string, PoolClassDef>();
  for (const [code, def] of Object.entries(TAX_DEPRECIATION_REGIMES[regime]?.classes ?? {})) {
    map.set(code, def);
  }
  const rows = (
    await tx.execute<{
      class_code: string;
      name: string;
      rate: string;
      method: "declining" | "straight_line";
      fyf: string;
      allow_recapture: boolean;
      allow_terminal_loss: boolean;
      cost_cap: string | null;
      depreciation_system: "gds" | "ads" | null;
      macrs_method: "200_db" | "150_db" | "straight_line" | null;
      recovery_period_years: string | null;
      convention: "half_year" | "mid_quarter" | "mid_month" | null;
    }>(sql`
      select class_code, name, rate::text as rate, method, first_year_fraction::text as fyf,
             allow_recapture, allow_terminal_loss, cost_cap::text as cost_cap,
             depreciation_system, macrs_method, recovery_period_years::text as recovery_period_years, convention
        from tax_pool_classes where org_id = ${orgId} and regime = ${regime} and is_active`)
  ).rows;
  for (const row of rows) {
    map.set(row.class_code, {
      code: row.class_code,
      rate: row.rate,
      method: row.method,
      firstYearFraction: row.fyf,
      allowRecapture: row.allow_recapture,
      allowTerminalLoss: row.allow_terminal_loss,
      costCap: row.cost_cap ?? undefined,
      name: row.name,
      depreciationSystem: row.depreciation_system ?? undefined,
      macrsMethod: row.macrs_method ?? undefined,
      recoveryPeriodYears: row.recovery_period_years ?? undefined,
      convention: row.convention ?? undefined,
    });
  }
  return map;
}

async function availableTaxRegimes(
  tx: SqlExecutor,
  orgId: string,
): Promise<{ code: string; name: string; classAttribute: string }[]> {
  const org = (await tx.execute<{ country: string }>(sql`select upper(country) as country from orgs where id = ${orgId}`)).rows[0];
  const country = org?.country ?? "";
  const byCode = new Map<string, { code: string; name: string; classAttribute: string; active: boolean }>();
  for (const regime of Object.values(TAX_DEPRECIATION_REGIMES)) {
    if (regime.countryCode === country) {
      byCode.set(regime.code, {
        code: regime.code,
        name: regime.name,
        classAttribute: regime.classAttribute,
        active: true,
      });
    }
  }
  const rows = (
    await tx.execute<{
      code: string;
      name: string;
      class_attribute: string;
      is_active: boolean;
    }>(sql`
      select code, name, class_attribute, is_active
        from tax_regimes where org_id = ${orgId}`)
  ).rows;
  for (const row of rows) {
    if (!row.is_active) {
      byCode.delete(row.code);
      continue;
    }
    byCode.set(row.code, {
      code: row.code,
      name: row.name,
      classAttribute: row.class_attribute,
      active: true,
    });
  }
  return [...byCode.values()].map(({ code, name, classAttribute }) => ({ code, name, classAttribute }));
}

/** Used by pool-run's regime picker so availability stays one function. */
export async function listAvailableTaxRegimes(orgId: string) {
  return availableTaxRegimes(db, orgId);
}
