import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { CloseError } from "./period-policy.ts";
import { dataDependentFeatureDefault } from "../organization/feature-defaults.ts";
import { featureEnabled, type FeatureState } from "../organization/feature-registry.ts";

export type DefaultCloseFeatureContext = {
  advancedClose: boolean;
  banking: boolean;
  fixedAssets: boolean;
  revenueRecognition: boolean;
  multiCurrency: boolean;
  multiSubsidiary: boolean;
};

/**
 * The close checklist's feature context, resolved through the same machinery
 * every other gate uses — the registry's parent-chain defaults and the
 * data-dependent default's "explicit stored boolean always wins" rule —
 * never a second copy of the SQL. The previous `|| has_assets` /
 * `|| has_fx` clauses let preserved data re-enable a step the Features page
 * says is off, so the close demanded depreciation/recognition/FX artifacts
 * that the disabled feature refuses to produce: an operator dead end that
 * contradicted the switchboard.
 */
export async function defaultCloseFeatureContext(
  executor: SqlExecutor,
  orgId: string,
): Promise<DefaultCloseFeatureContext> {
  const result = (await executor.execute<{ features: FeatureState | null }>(sql`
    select coalesce(o.settings->'features', '{}'::jsonb) as features
      from orgs o where o.id=${orgId}
  `));
  const row = result.rows[0];
  if (!row) throw new CloseError("organization not found");
  const features = row.features ?? {};
  return {
    advancedClose: featureEnabled(features, "flows") && features.advancedClose === true,
    banking: featureEnabled(features, "banking"),
    fixedAssets: featureEnabled(features, "fixedAssets"),
    revenueRecognition: featureEnabled(features, "revenueRecognition"),
    multiCurrency: await dataDependentFeatureDefault(executor, orgId, "multiCurrency", features),
    multiSubsidiary: await dataDependentFeatureDefault(executor, orgId, "multiSubsidiary", features),
  };
}

export function defaultCloseStepEnabled(
  key: string,
  features: DefaultCloseFeatureContext,
): boolean {
  if (["ar-cutoff", "ap-cutoff", "variance-review", "controller-approval"].includes(key)) {
    return features.advancedClose;
  }
  if (key === "financial-review") return !features.advancedClose;
  if (key === "bank-reconciled") return features.banking;
  if (key === "depreciation-posted") return features.fixedAssets;
  if (key === "recognition-posted") return features.revenueRecognition;
  if (["fx-ready", "fx-revalued"].includes(key)) return features.multiCurrency;
  if (["intercompany-balanced", "consolidation"].includes(key)) return features.multiSubsidiary;
  return true;
}

export async function advancedCloseEnabled(orgId: string): Promise<boolean> {
  return (await defaultCloseFeatureContext(db, orgId)).advancedClose;
}
