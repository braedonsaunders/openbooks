import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";

/**
 * Shared "scheduled automation in non-production" rule (B2-SCH-2).
 *
 * The scheduled-script scanner only fires for production organizations, so
 * activating a schedule anywhere else silently never runs — the operator
 * believes the automation is live. This matches the SFTP precedent (the
 * import scan excludes non-production orgs, and the schedule route refuses
 * manual runs there by name): activation outside production is refused by
 * name, naming the remedy. Use Run now to exercise the script in place —
 * that route stays available in every environment — or activate the
 * schedule in a production organization.
 */

/** Refusal code the admin script routes answer with (HTTP 409). */
export const SCHEDULED_SCRIPT_NON_PRODUCTION_CODE = "SCHEDULED_SCRIPT_NON_PRODUCTION";

/**
 * Rejected because the organization is not a production one: an active
 * schedule there would never fire. Nothing was written.
 */
export class ScheduledScriptNonProductionError extends Error {
  readonly code = SCHEDULED_SCRIPT_NON_PRODUCTION_CODE;
  readonly envKind: string;
  constructor(envKind: string) {
    super(
      `scheduled scripts run only in production organizations — this organization is '${envKind}', ` +
        "so an active schedule would never fire. Use Run now to exercise the script here, " +
        "or activate the schedule in a production organization.",
    );
    this.name = "ScheduledScriptNonProductionError";
    this.envKind = envKind;
  }
}

/**
 * Refuse activating a scheduled script outside production. A missing org
 * row refuses nothing here — the write fails on its own scope check.
 */
export async function assertProductionEnvForScheduledScript(orgId: string): Promise<void> {
  const row = (await db.execute<{ envKind: string | null }>(sql`
    select env_kind as "envKind" from orgs where id = ${orgId}
  `)).rows[0];
  const envKind = row?.envKind ?? "production";
  if (envKind !== "production") throw new ScheduledScriptNonProductionError(envKind);
}
