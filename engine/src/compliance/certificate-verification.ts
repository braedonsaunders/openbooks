import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { requestNativeCommandApproval, lockApprovalSubject } from "../platform/approval-routing.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { subsidiaryScopeAllows, ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { ComplianceError } from "./compliance.ts";

export class CertificateApprovalError extends ComplianceError {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}

/** Verification attests to an exact certificate revision through the tenant's Flow policy. */
export async function submitCertificateVerification(input: {
  orgId: string;
  actorId: string;
  id: string;
  revision: number;
  approvalRunId?: string;
}) {
  if (!Number.isSafeInteger(input.revision) || input.revision < 1)
    throw new CertificateApprovalError("Reload the certificate's current revision.");
  return withOrgTransaction(input.orgId, async () => {
    await lockApprovalSubject(input.orgId, "compliance_certificate", input.id);
    if (!(await lockAndCheckOrgFeature(db, input.orgId, "subcontractorCompliance")))
      throw new ScopeNotFoundError();
    const row = (
      await db.execute<{
        status: string;
        project_id: string | null;
        supersedes_id: string | null;
        revision: number;
        ownerSubsidiaryId: string | null;
        [column: string]: unknown;
      }>(
        sql`
   select c.*,p.subsidiary_id as "ownerSubsidiaryId" from compliance_records c
   join parties p on p.org_id=c.org_id and p.id=c.party_id
   where c.org_id=${input.orgId} and c.id=${input.id} for update of c for share of p`,
        "objects",
      )
    )[0];
    if (!row) throw new ScopeNotFoundError();
    const scope = await lockActorCommandAuthority(
      db,
      input.orgId,
      input.actorId,
      row.ownerSubsidiaryId,
      "compliance.verify",
    );
    if (scope !== null && row.ownerSubsidiaryId === null && !row.project_id)
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
    if (row.status === "superseded")
      throw new CertificateApprovalError(
        "This certificate is retained history. Verify its current replacement.",
      );
    if (row.revision !== input.revision)
      throw new CertificateApprovalError(
        "This certificate changed. Reload and submit the current revision.",
        409,
      );
    if (
      await requestNativeCommandApproval({
        ...input,
        subjectKind: "compliance_certificate",
        subjectId: input.id,
        command: { revision: input.revision },
      })
    )
      return {
        id: input.id,
        revision: row.revision,
        status: "pending_approval" as const,
      };
    const before: Record<string, unknown> = { ...row };
    delete before.ownerSubsidiaryId;
    let supersession: { supersededId: string | null; stale: boolean } = {
      supersededId: null,
      stale: false,
    };
    if (row.supersedes_id) {
      const retired = await db.execute(
        sql`update compliance_records set status='superseded',superseded_by_id=${input.id},updated_at=now(),updated_by=${input.actorId}
    where org_id=${input.orgId} and id=${row.supersedes_id} and status in ('pending_review','active') returning id`,
        "objects",
      );
      supersession = retired.length
        ? { supersededId: row.supersedes_id, stale: false }
        : { supersededId: null, stale: true };
    }
    const saved = await db.execute<Record<string, unknown>>(
      sql`update compliance_records set status='active',verified_at=now(),verified_by=${input.actorId},
   verified_revision=${input.revision},rejected_reason=null,revision=revision+1,updated_at=now(),updated_by=${input.actorId}
   where org_id=${input.orgId} and id=${input.id} and revision=${input.revision} returning *`,
      "objects",
    );
    if (saved.length !== 1)
      throw new CertificateApprovalError(
        "This certificate changed before verification. Reload its current revision.",
        409,
      );
    await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id) values
   (${input.orgId},'compliance_records',${input.id},${"verify"},${JSON.stringify({ before, after: saved[0]!, event: "verification_released", revisionBefore: row.revision, revisionAfter: row.revision + 1, mode: input.approvalRunId ? "gated" : "ungated", approvalRunId: input.approvalRunId ?? null, supersession })}::jsonb,${input.actorId})`);
    return {
      id: input.id,
      revision: row.revision + 1,
      status: "active" as const,
    };
  });
}
