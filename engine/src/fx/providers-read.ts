import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

export async function listFxProviderRuns(orgId: string): Promise<Record<string, unknown>[]> {
  return db.execute<Record<string, unknown>>(
    sql`
    select id, trigger, status, requested_from as "requestedFrom", requested_to as "requestedTo",
           observations_received as "observationsReceived", rates_inserted as "ratesInserted",
           rates_updated as "ratesUpdated", manual_overrides_preserved as "manualOverridesPreserved",
           error_message as "errorMessage", started_at as "startedAt", finished_at as "finishedAt"
      from fx_provider_runs where org_id = ${orgId}
     order by started_at desc limit 10
  `,
    "objects",
  );
}
