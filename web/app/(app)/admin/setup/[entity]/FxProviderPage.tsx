import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { readFxProviderConfigView } from "@openbooks/engine/fx/providers";
import { FxProviderForm } from "../../../../../components/viewspec/native-widgets.client";

export async function FxProviderPage({ orgId }: { orgId: string }) {
  const [config, currencies, recommended, lastRun] = await Promise.all([
    readFxProviderConfigView(orgId),
    db.execute<{ code: string; name: string }>(
      sql`select code, name from currencies order by code`,
      "objects",
    ),
    db.execute<{ code: string }>(
      sql`
      select code from (
        select base_currency as code, 0 as priority from orgs where id = ${orgId}
        union all
        select base_currency as code, case when parent_id is null then 1 else 2 end as priority
          from subsidiaries where org_id = ${orgId} and is_active
      ) configured group by code order by min(priority), code
    `,
      "objects",
    ),
    db.execute(
      sql`
      select id, trigger, status, observations_received as "observationsReceived",
             rates_inserted as "ratesInserted", rates_updated as "ratesUpdated",
             manual_overrides_preserved as "manualOverridesPreserved",
             error_message as "errorMessage", started_at as "startedAt", finished_at as "finishedAt"
        from fx_provider_runs where org_id = ${orgId} order by started_at desc limit 1
    `,
      "objects",
    ),
  ]);
  return (
    <FxProviderForm
      initial={config ? JSON.parse(JSON.stringify(config)) : null}
      currencies={currencies}
      recommendedCurrencies={recommended.map((row) => row.code)}
      lastRun={lastRun[0] ? JSON.parse(JSON.stringify(lastRun[0])) : null}
    />
  );
}
