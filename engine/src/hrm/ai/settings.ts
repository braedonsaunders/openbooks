import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockActorCommandAuthority } from "../../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { AiRailsError } from "./errors.ts";

/**
 * Workforce assistance settings. The thresholds, cohort key, bias
 * terms and review cadence are org-declared (Setup owns the UI); the
 * scan reads them here so a missing row falls back to safe defaults
 * instead of refusing — defaults are conservative (z=3, retro=500).
 */

export interface AiRailsSettings {
  zThreshold: number;
  retroThreshold: number;
  cohortKey: "subsidiary" | "department" | "pay_schedule" | "job_level";
  biasTerms: string[];
  reviewMonths: number;
}

export const DEFAULT_AI_RAILS_SETTINGS: AiRailsSettings = {
  zThreshold: 3,
  retroThreshold: 500,
  cohortKey: "subsidiary",
  biasTerms: [],
  reviewMonths: 12,
};

/**
 * Ensure the org's singleton settings row exists (defaults from the table).
 * The configuration surface provisions the row before editing. `on
 * conflict do nothing` is the expected steady state (concurrent first
 * views), never a dropped write.
 */
export async function ensureAiRailsSettings(exec: SqlExecutor, orgId: string): Promise<void> {
  await exec.execute(sql`
    insert into ai_rails_settings (org_id)
    values (${orgId}::uuid)
    -- An existing organization settings row retains its operator configuration.
    on conflict (org_id) do nothing`);
}

/** Provision configuration only at its authorized Setup boundary, retaining existing values. */
export async function ensureAiRailsSettingsForOrg(orgId: string, actorId: string): Promise<void> {
  await withOrgTransaction(orgId, async () => {
    const allowed = await lockActorCommandAuthority(db, orgId, actorId, null, 'admin.setup.manage');
    if (allowed !== null) throw new AiRailsError('ai_forbidden', 'Organization workforce policy requires unrestricted subsidiary access');
    if (!await lockAndCheckOrgFeature(db, orgId, 'aiGovernanceLedger')) {
      throw new AiRailsError('ai_feature_off', 'Enable AI governance ledger in Company Settings → Features to configure workforce review policy');
    }
    await ensureAiRailsSettings(db, orgId);
  });
}

export async function loadAiRailsSettings(
  exec: SqlExecutor,
  orgId: string,
): Promise<AiRailsSettings> {
  const rows = (await exec.execute<{
    zThreshold: string;
    retroThreshold: string;
    cohortKey: string;
    biasTerms: string[] | null;
    reviewMonths: number;
  }>(sql`
    select z_threshold::text as "zThreshold",
           retro_threshold::text as "retroThreshold",
           cohort_key as "cohortKey", bias_terms as "biasTerms",
           review_months as "reviewMonths"
      from ai_rails_settings
     where org_id = ${orgId}::uuid`)).rows;
  const row = rows[0];
  if (!row) return { ...DEFAULT_AI_RAILS_SETTINGS };
  const cohort = ["subsidiary", "department", "pay_schedule", "job_level"].includes(row.cohortKey)
    ? (row.cohortKey as AiRailsSettings["cohortKey"])
    : DEFAULT_AI_RAILS_SETTINGS.cohortKey;
  return {
    zThreshold: Number(row.zThreshold) > 0 ? Number(row.zThreshold) : 3,
    retroThreshold: Number(row.retroThreshold) >= 0 ? Number(row.retroThreshold) : 500,
    cohortKey: cohort,
    biasTerms: Array.isArray(row.biasTerms) ? row.biasTerms.filter((t) => t.trim().length > 0) : [],
    reviewMonths:
      Number.isInteger(row.reviewMonths) && row.reviewMonths >= 1 && row.reviewMonths <= 36
        ? row.reviewMonths
        : 12,
  };
}
