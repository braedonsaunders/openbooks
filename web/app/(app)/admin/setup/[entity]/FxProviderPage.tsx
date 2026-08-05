import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { readFxProviderConfigView } from '@openbooks/engine/src/fx-providers.ts'
import { FxProviderForm } from './FxProviderForm'

export async function FxProviderPage({ orgId }: { orgId: string }) {
  const [config, currencies, recommended, lastRun] = await Promise.all([
    readFxProviderConfigView(orgId),
    db.execute(sql`select code, name from currencies order by code`) as any,
    db.execute(sql`
      select code from (
        select base_currency as code, 0 as priority from orgs where id = ${orgId}
        union all
        select base_currency as code, case when parent_id is null then 1 else 2 end as priority
          from subsidiaries where org_id = ${orgId} and is_active
      ) configured group by code order by min(priority), code
    `) as any,
    db.execute(sql`
      select id, trigger, status, observations_received as "observationsReceived",
             rates_inserted as "ratesInserted", rates_updated as "ratesUpdated",
             manual_overrides_preserved as "manualOverridesPreserved",
             error_message as "errorMessage", started_at as "startedAt", finished_at as "finishedAt"
        from fx_provider_runs where org_id = ${orgId} order by started_at desc limit 1
    `) as any,
  ])
  return (
    <FxProviderForm
      initial={config ? JSON.parse(JSON.stringify(config)) : null}
      currencies={currencies.rows}
      recommendedCurrencies={recommended.rows.map((row: any) => row.code)}
      lastRun={lastRun.rows[0] ? JSON.parse(JSON.stringify(lastRun.rows[0])) : null}
    />
  )
}
