import { lockApprovalSubject } from "../platform/approval-routing.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { requestNativeCommandApproval } from "../platform/approval-routing.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { loadApplicableRequirement, ComplianceError } from "./compliance.ts";

/** Submit a bounded compliance exception through the tenant's native Flow policy. */
export async function submitComplianceWaiver(input: {
  orgId: string;
  actorId: string;
  id: string;
  approvalRunId?: string;
}) {
  return withOrgTransaction(input.orgId, async () => {
    await lockApprovalSubject(input.orgId, "compliance_waiver", input.id);
    if (!(await lockAndCheckOrgFeature(db, input.orgId, "subcontractorCompliance")))
      throw new ScopeNotFoundError();
    const row = (
      await db.execute<{
        party_id: string;
        requirement_id: string;
        project_id: string | null;
        approved_at: unknown;
        revoked_at: unknown;
        subsidiary_id: string | null;
      }>(
        sql`
   select w.party_id,w.requirement_id,w.project_id,w.approved_at,w.revoked_at,p.subsidiary_id
   from compliance_waivers w join parties p on p.org_id=w.org_id and p.id=w.party_id
   where w.org_id=${input.orgId} and w.id=${input.id} for update of w for share of p`,
        "objects",
      )
    )[0];
    if (!row) throw new ScopeNotFoundError();
    const scope = await lockActorCommandAuthority(
      db,
      input.orgId,
      input.actorId,
      row.subsidiary_id,
      "compliance.waive",
    );
    if (scope !== null && row.subsidiary_id === null && !row.project_id)
      throw new ScopeNotFoundError();
    if (row.project_id) {
      const project = (
        await db.execute<{ subsidiary_id: string | null }>(
          sql`select subsidiary_id from projects where org_id=${input.orgId} and id=${row.project_id} for share`,
          "objects",
        )
      )[0];
      if (!project || !subsidiaryScopeAllows(scope, project.subsidiary_id))
        throw new ScopeNotFoundError();
    }
    if (row.revoked_at)
      throw new ComplianceError(
        "A revoked exception cannot be submitted. File a new bounded exception with its reason.",
      );
    if (row.approved_at) return { id: input.id, status: "approved" as const };
    if (!(await loadApplicableRequirement(input.orgId, row.party_id, row.requirement_id)))
      throw new ComplianceError(
        "This requirement no longer applies to the vendor. Review its compliance class before submitting another exception.",
      );
    if (
      await requestNativeCommandApproval({
        ...input,
        subjectKind: "compliance_waiver",
        subjectId: input.id,
        command: {},
      })
    )
      return { id: input.id, status: "pending_approval" as const };
    const saved = await db.execute(
      sql`update compliance_waivers set approved_by=${input.actorId},approved_at=now(),updated_by=${input.actorId},updated_at=now()
   where org_id=${input.orgId} and id=${input.id} and approved_at is null and revoked_at is null returning id`,
      "objects",
    );
    if (saved.length !== 1)
      throw new ComplianceError(
        "The exception changed before release. Reload its current Flow state.",
      );
    await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values
   (${input.orgId},'compliance_waivers',${input.id},'update',${JSON.stringify({ event: "released", mode: input.approvalRunId ? "gated" : "ungated", approvalRunId: input.approvalRunId ?? null })}::jsonb,${input.actorId})`);
    return { id: input.id, status: "approved" as const };
  });
}
