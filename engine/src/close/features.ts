import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { CloseError } from "./period-policy.ts";

export type DefaultCloseFeatureContext = {
  advancedClose: boolean;
  banking: boolean;
  fixedAssets: boolean;
  revenueRecognition: boolean;
  multiCurrency: boolean;
  multiSubsidiary: boolean;
};

export async function defaultCloseFeatureContext(
  executor: SqlExecutor,
  orgId: string,
): Promise<DefaultCloseFeatureContext> {
  const result = (await executor.execute<{
      features: Record<string, boolean>;
      entities: number;
      has_fx: boolean;
      has_assets: boolean;
      has_recognition: boolean;
    }>(sql`
    select coalesce(o.settings->'features', '{}'::jsonb) as features,
           (select count(*)::int from subsidiaries s
             where s.org_id=o.id and s.is_active and not s.is_elimination) as entities,
           (exists(select 1 from journal_lines jl where jl.org_id=o.id and jl.fx_rate <> 1)
             or exists(select 1 from fx_rates f where f.org_id=o.id)) as has_fx,
           exists(select 1 from fixed_assets fa where fa.org_id=o.id) as has_assets,
           exists(select 1 from recognition_schedules rs where rs.org_id=o.id) as has_recognition
      from orgs o where o.id=${orgId}
  `));
  const row = result.rows[0];
  if (!row) throw new CloseError("organization not found");
  const features = row.features ?? {};
  const flows = features.flows ?? true;
  return {
    advancedClose: flows && features.advancedClose === true,
    banking: features.banking ?? true,
    fixedAssets: (features.fixedAssets ?? true) || row.has_assets,
    revenueRecognition: (features.revenueRecognition ?? true) || row.has_recognition,
    multiCurrency: features.multiCurrency === true || row.has_fx,
    multiSubsidiary: features.multiSubsidiary === true || Number(row.entities) > 1,
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
