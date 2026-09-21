/**
 * HR-20 multi-stage approval chains.
 *
 * time_approval_stages holds the declared chain per (org, subject):
 * timesheet_week (adapter already exists) and crew_time_batch (adapter
 * registered here). A stage is a Flows gate; the service advances the
 * subject status as gates release. When the multi-stage feature is off
 * — or no chain is declared — the existing single approval stands and
 * this module is inert.
 */

import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { FieldTimeError, refuse } from "./errors.ts";
import { FIELD_TIME_MULTI_STAGE_APPROVAL_FEATURE } from "./settings.ts";
import { validateStages, type ApprovalStage } from "./pure.ts";

export const TIMESHEET_WEEK_CHAIN = "timesheet_week" as const;
export const CREW_BATCH_CHAIN = "crew_time_batch" as const;

export type ChainSubject = typeof TIMESHEET_WEEK_CHAIN | typeof CREW_BATCH_CHAIN;

export async function multiStageOn(orgId: string): Promise<boolean> {
  return lockAndCheckOrgFeature(db, orgId, FIELD_TIME_MULTI_STAGE_APPROVAL_FEATURE);
}

/** The declared chain, or null when the single approval stands. */
export async function loadChain(orgId: string, subject: ChainSubject): Promise<ApprovalStage[] | null> {
  if (!(await multiStageOn(orgId))) return null;
  const row = (await db.execute<{ stages: unknown }>(sql`
    select stages from time_approval_stages
     where org_id = ${orgId} and subject_kind = ${subject}`)).rows[0];
  if (!row) return null;
  return validateStages(row.stages);
}

export async function saveChain(input: {
  orgId: string;
  actorUserId: string;
  subject: ChainSubject;
  stages: unknown;
}): Promise<ApprovalStage[]> {
  if (!(await multiStageOn(input.orgId))) {
    refuse(
      "multi_stage_off",
      "Multi-stage approval is turned off — turn on fieldTimeMultiStageApproval in Company Settings → Features before declaring a chain",
    );
  }
  const stages = validateStages(input.stages);
  await db.execute(sql`
    insert into time_approval_stages (org_id, subject_kind, stages, created_by, updated_by)
    values (${input.orgId}, ${input.subject}, ${JSON.stringify(stages)}::jsonb,
            ${input.actorUserId}, ${input.actorUserId})
    on conflict (org_id, subject_kind) do update
       set stages = excluded.stages, updated_at = now(), updated_by = excluded.updated_by`);
  return stages;
}

/**
 * Whether a subject status has cleared its chain. Single approval (no
 * chain) completes at approved_stage_2; a declared chain of length n
 * completes at approved_stage_n.
 */
export function chainComplete(status: string, chain: ApprovalStage[] | null): boolean {
  if (!chain) return status === "approved_stage_2";
  return status === `approved_stage_${chain.length}`;
}

/** The status a stage approval stamps. Stage orders run 1..n. */
export function statusForStage(order: number): string {
  if (order < 1 || order > 5 || !Number.isInteger(order)) {
    refuse("invalid_stage", `Stage ${order} is outside the declared chain — approve through the current stage`);
  }
  return `approved_stage_${order}`;
}

/** The next stage awaiting decision for a status, or null when complete. */
export function nextStage(status: string, chain: ApprovalStage[] | null): ApprovalStage | null {
  if (chainComplete(status, chain)) return null;
  const m = /^approved_stage_(\d)$/.exec(status);
  const done = m ? Number(m[1]) : 0;
  if (!chain) {
    return { order: 2, approverKind: "supervisor" };
  }
  const next = chain.find((s) => s.order === done + 1);
  if (!next) {
    throw new FieldTimeError(
      "chain_stalled",
      `Status ${status} matches no stage of the declared chain — fix the chain in Timesheets setup before approving`,
    );
  }
  return next;
}
