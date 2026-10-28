import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { lockAndCheckOrgFeature } from "@openbooks/engine/organization/org-feature-lock";
import { syncProjectRevenueContractsInTransaction } from "@openbooks/engine/projects/revenue";
import { subsidiaryVisibleFilter } from "./subsidiaries";

export type ProjectPercentCompleteResult =
  | { kind: "feature_disabled" }
  | { kind: "not_found" }
  | { kind: "revision_conflict" }
  | {
      kind: "updated";
      sync: Awaited<ReturnType<typeof syncProjectRevenueContractsInTransaction>>;
    };

/** Store a project completion override and synchronize its revenue schedule atomically. */
export async function updateProjectPercentComplete(input: {
  orgId: string;
  actorId: string;
  projectId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  percentComplete: number | null;
  expectedPercentComplete: number | null;
}): Promise<ProjectPercentCompleteResult> {
  const today = await businessToday(input.orgId);
  return db.transaction(async (tx): Promise<ProjectPercentCompleteResult> => {
    if (!(await lockAndCheckOrgFeature(tx, input.orgId, "projects"))) {
      return { kind: "feature_disabled" };
    }
    const live = (
      await tx.execute<{ override: string | null }>(
        sql`
      select nullif(custom->>'percentCompleteOverride', '') as override
        from projects
       where id = ${input.projectId} and org_id = ${input.orgId}
       ${subsidiaryVisibleFilter(sql`subsidiary_id`, input.allowedSubsidiaryIds)}
       for update
    `,
        "objects",
      )
    )[0];
    if (!live) return { kind: "not_found" };
    const liveValue = live.override === null ? null : Number(live.override);
    const matches =
      (liveValue === null && input.expectedPercentComplete === null) ||
      (liveValue !== null &&
        input.expectedPercentComplete !== null &&
        Number.isFinite(liveValue) &&
        liveValue === input.expectedPercentComplete);
    if (!matches) return { kind: "revision_conflict" };

    const updated = await tx.execute<{ id: string }>(
      sql`
      update projects
         set custom = jsonb_set(coalesce(custom, '{}'::jsonb), '{percentCompleteOverride}',
                                ${input.percentComplete === null ? sql`'null'::jsonb` : sql`to_jsonb(${input.percentComplete}::numeric)`}),
             updated_by = ${input.actorId}, updated_at = now()
       where id = ${input.projectId} and org_id = ${input.orgId}
       ${subsidiaryVisibleFilter(sql`subsidiary_id`, input.allowedSubsidiaryIds)}
       returning id`,
      "objects",
    );
    if (!updated[0]) return { kind: "not_found" };
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${input.orgId}, 'projects', ${input.projectId}, 'update',
              ${JSON.stringify({
                percentCompleteOverride: { before: liveValue, after: input.percentComplete },
                source: "percent_complete_override",
              })}::jsonb, ${input.actorId})
    `);
    const sync = await syncProjectRevenueContractsInTransaction(
      tx,
      input.orgId,
      input.actorId,
      today,
      input.projectId,
    );
    return { kind: "updated", sync };
  });
}
