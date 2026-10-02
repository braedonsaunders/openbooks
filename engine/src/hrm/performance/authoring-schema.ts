import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../../platform/db.ts";
import { HrmPerformanceError } from "./errors.ts";

export class PerformanceUpgradeRequiredError extends HrmPerformanceError {
  constructor() {
    super(
      "REFUSED",
      "Performance requires the Talent database upgrade (0481_hrm_talent_workspaces.sql). Ask your administrator to apply the upgrade before opening review templates or editing reviews.",
    );
    this.name = "PerformanceUpgradeRequiredError";
  }
}

/** Refuse before querying authoring fields when application and database versions differ. */
export async function requireReviewAuthoringSchema(exec: SqlExecutor): Promise<void> {
  const result = (
    await exec.execute<{ ready: boolean }>(sql`
    select count(*) = 12 as ready from information_schema.columns
    where table_schema = 'public' and (
      (table_name = 'hrm_review_templates' and column_name in ('draft_document','published_document','published_version','revision')) or
      (table_name = 'hrm_review_cycles' and column_name in ('require_manager_reviews','template_version','rating_scale_snapshot','template_document_snapshot','reviewer_assignments','revision')) or
      (table_name = 'hrm_reviews' and column_name in ('revision','draft_saved_at'))
    )
  `)
  ).rows[0];
  if (!result?.ready) throw new PerformanceUpgradeRequiredError();
}
