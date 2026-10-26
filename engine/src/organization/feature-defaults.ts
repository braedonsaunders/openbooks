import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { FEATURE_BY_KEY, featureRequirements, type FeatureState } from "./feature-registry.ts";

export type DataDependentFeatureKey = "multiSubsidiary" | "multiCurrency";

/**
 * Single source of truth for the data-dependent feature defaults. An
 * explicit stored boolean always wins; otherwise the org's own data decides:
 * `multiSubsidiary` is on iff the org already runs more than one active
 * non-elimination subsidiary, `multiCurrency` iff it already touched foreign
 * currency (a non-1 fx_rate line or any configured FX rate). This keeps
 * existing multi-entity / multi-currency orgs working when the flag was
 * never explicitly set.
 *
 * The web layer (Features page, setup-entity gate, route guards) and the
 * engine re-check (org-feature-lock) MUST resolve through this helper —
 * never a second copy of the SQL — or the two layers will disagree about
 * whether a feature is on. Probes run on the caller's runner so they observe
 * the caller's transaction.
 */
export async function dataDependentFeatureDefault(
  runner: SqlExecutor,
  orgId: string,
  key: DataDependentFeatureKey,
  state: FeatureState | null | undefined,
): Promise<boolean> {
  const v = state?.[key];
  if (typeof v === "boolean") return v;
  if (key === "multiSubsidiary") {
    const r = await runner.execute<{ n: number }>(
      sql`
      select count(*)::int as n from subsidiaries
       where org_id = ${orgId} and is_active and not is_elimination`,
      "objects",
    );
    return (r[0]?.n ?? 0) > 1;
  }
  const r = await runner.execute<{ on: boolean }>(
    sql`
    select (
      exists(select 1 from journal_lines where org_id = ${orgId} and fx_rate <> 1)
      or exists(select 1 from fx_rates where org_id = ${orgId})
    ) as on`,
    "objects",
  );
  return Boolean(r[0]?.on);
}

const DATA_DEPENDENT_FEATURE_KEYS: readonly DataDependentFeatureKey[] = [
  "multiSubsidiary",
  "multiCurrency",
];

/**
 * The data-dependent features a feature's requirement chain reaches
 * (including the feature itself). A child of Multi-subsidiary resolves
 * through its parent, so the parent's data-dependent default must be known
 * before the pure registry check runs.
 */
export function dataDependentRequirementsOf(key: string): DataDependentFeatureKey[] {
  const found = new Set<string>();
  const seen = new Set<string>();
  const visit = (current: string): void => {
    if (seen.has(current)) return;
    seen.add(current);
    if ((DATA_DEPENDENT_FEATURE_KEYS as readonly string[]).includes(current)) found.add(current);
    const def = FEATURE_BY_KEY.get(current);
    if (!def) return;
    for (const required of featureRequirements(def)) visit(required);
  };
  visit(key);
  return DATA_DEPENDENT_FEATURE_KEYS.filter((candidate) => found.has(candidate));
}

/**
 * Overlay the resolved data-dependent defaults onto a stored feature state
 * for every data-dependent feature that `keys` reach (all of them when
 * omitted). A stored boolean always wins; an unset one resolves from the
 * org's own data on the caller's runner, so the pure registry check over the
 * result agrees with the Features page for children of a data-dependent
 * parent.
 */
export async function withDataDependentDefaults(
  runner: SqlExecutor,
  orgId: string,
  state: FeatureState | null | undefined,
  keys?: readonly string[],
): Promise<FeatureState> {
  const resolved: FeatureState = { ...(state ?? {}) };
  const reached =
    keys === undefined
      ? [...DATA_DEPENDENT_FEATURE_KEYS]
      : [...new Set(keys.flatMap((key) => dataDependentRequirementsOf(key)))];
  for (const key of reached) {
    if (typeof resolved[key] === "boolean") continue;
    resolved[key] = await dataDependentFeatureDefault(runner, orgId, key, state);
  }
  return resolved;
}
