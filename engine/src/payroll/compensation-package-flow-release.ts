import { sql } from "drizzle-orm";
import { COMPENSATION_VERSION_SUBJECT_KIND, COMPENSATION_ASSIGNMENT_SUBJECT_KIND } from "@openbooks/schema/src/payroll-compensation.ts";
import { db } from "../platform/db.ts";
import type { FlowApprovalReleaseArgs } from "../flows/approval-release-hook.ts";
import { PayrollError } from "./error.ts";
import { transitionCompensationPackageVersion, transitionCompensationPackageAssignment } from "./compensation-package-store.ts";

/** The native decision command rechecks authority and the exact submitted revision. */
export async function releaseCompensationPackageFlowApproval(args: FlowApprovalReleaseArgs): Promise<void> {
  const version = args.subjectKind === COMPENSATION_VERSION_SUBJECT_KIND;
  if (!version && args.subjectKind !== COMPENSATION_ASSIGNMENT_SUBJECT_KIND) throw new PayrollError("Choose a native compensation approval subject.");
  if (!args.ctx.userId || !args.approvalRunId) throw new PayrollError("Compensation approval requires its native human gate decision and acting user.");
  const table = version ? "payroll_compensation_versions" : "payroll_compensation_assignments";
  const row = (await db.execute<{ package_id: string; revision: number }>(sql`
    select package_id,revision from ${sql.identifier(table)} where org_id=${args.ctx.orgId} and id=${args.subjectId}
  `)).rows[0];
  if (!row) throw new PayrollError("This compensation proposal is unavailable in the acting organization.");
  const query = { orgId: args.ctx.orgId, actorId: args.ctx.userId, packageId: row.package_id,
    expectedRevision: row.revision, approvalRunId: args.approvalRunId,
    action: args.outcome === "approved" ? "approve" as const : "reject" as const,
    reason: args.comment?.trim() || `Compensation ${args.outcome} through the submitted tenant Flow` };
  if (version) await transitionCompensationPackageVersion({ ...query, versionId: args.subjectId });
  else await transitionCompensationPackageAssignment({ ...query, assignmentId: args.subjectId });
}
