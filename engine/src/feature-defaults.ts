import { sql } from "drizzle-orm";
import type { SqlExecutor } from "./db.ts";
import type { FeatureState } from "./feature-registry.ts";

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
    const r = await runner.execute<{ n: number }>(sql`
      select count(*)::int as n from subsidiaries
       where org_id = ${orgId} and is_active and not is_elimination`);
    return (r.rows[0]?.n ?? 0) > 1;
  }
  const r = await runner.execute<{ on: boolean }>(sql`
    select (
      exists(select 1 from journal_lines where org_id = ${orgId} and fx_rate <> 1)
      or exists(select 1 from fx_rates where org_id = ${orgId})
    ) as on`);
  return Boolean(r.rows[0]?.on);
}
