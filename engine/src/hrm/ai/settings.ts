import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../../platform/db.ts";

/**
 * HRM AI rails (HR-21) org settings. The thresholds, cohort key, bias
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
