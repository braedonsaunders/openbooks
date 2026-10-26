import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { getFlowAdapter } from "./registry.ts";
import { lockSubjectScope } from "./subject-scope.ts";

export interface ApprovalRequestDetail {
  subjectKind: string;
  subjectId: string;
  fields: Array<{
    key: string;
    label: string;
    type: string;
    value: string | number | boolean | null;
  }>;
  submittedAt: string | null;
  changed: boolean;
}

/** Retained approval terms are readable only through the subject's current authority and entity scope. */
export async function loadApprovalRequestDetail(input: {
  orgId: string;
  actorId: string;
  subjectKind: string;
  subjectId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<ApprovalRequestDetail | null> {
  const adapter = getFlowAdapter(input.subjectKind);
  if (!adapter || adapter.scope.via === "document") return null;
  return withOrgTransaction(input.orgId, async () => {
    try {
      const permission = adapter.readPermission
        ? await adapter.readPermission(input.subjectId, input.actorId)
        : adapter.permissions?.read;
      if (!permission) return null;
      const currentScope = await lockActorCommandAuthority(
        db,
        input.orgId,
        input.actorId,
        null,
        permission,
      );
      const allowed =
        currentScope === null
          ? input.allowedSubsidiaryIds
          : input.allowedSubsidiaryIds === null
            ? currentScope
            : new Set([...currentScope].filter((id) => input.allowedSubsidiaryIds!.has(id)));
      await lockSubjectScope(
        input.orgId,
        input.subjectKind,
        adapter.scope,
        input.subjectId,
        allowed,
      );
      const current = await adapter.loadContext(input.subjectId);
      if (!current) return null;
      const receipt = (
        await db.execute<{
          context: Record<string, unknown>;
          createdAt: Date | string;
          active: boolean;
        }>(
          sql`
        select context, created_at as "createdAt", exists (
          select 1 from flow_gates g where g.org_id=flow_submissions.org_id
            and g.subject_kind=flow_submissions.subject_kind and g.subject_id=flow_submissions.subject_id
            and g.status in ('pending','escalated')) as active from flow_submissions
         where org_id=${input.orgId} and subject_kind=${input.subjectKind} and subject_id=${input.subjectId}
         order by created_at desc,id desc limit 1`,
          "objects",
        )
      )[0];
      const values = receipt?.context ?? current.values;
      const fields = adapter.profile.fields.flatMap((field) => {
        const value = values[field.key];
        // User identities are already resolved by the shared approval history.
        // Internal references and object payloads are not record display fields.
        if (
          field.type === "user" ||
          field.key === "id" ||
          /Id$/.test(field.key) ||
          field.key === "event_source" ||
          value === undefined ||
          (value !== null && !["string", "number", "boolean"].includes(typeof value))
        )
          return [];
        return [
          {
            key: field.key,
            label: field.label,
            type: field.type,
            value: value as string | number | boolean | null,
          },
        ];
      });
      const command = values.command;
      if (
        command &&
        typeof command === "object" &&
        "reason" in command &&
        typeof command.reason === "string"
      ) {
        fields.push({ key: "commandReason", label: "Reason", type: "text", value: command.reason });
      }
      const submittedFingerprint = values.approvalFingerprint;
      return {
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        fields,
        submittedAt: receipt ? new Date(receipt.createdAt).toISOString() : null,
        changed:
          receipt?.active === true &&
          typeof submittedFingerprint === "string" &&
          typeof current.values.approvalFingerprint === "string" &&
          submittedFingerprint !== current.values.approvalFingerprint,
      } satisfies ApprovalRequestDetail;
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return null;
      throw error;
    }
  });
}
