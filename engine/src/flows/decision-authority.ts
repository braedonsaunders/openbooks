import { db } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { getFlowAdapter } from "./registry.ts";
import { resolveSubjectSubsidiaries } from "./subject-scope.ts";
import { verifyUser } from "./targets.ts";

/** Assignment never grants native permission or access to another legal entity. */
export async function hasFlowDecisionAuthority(input: {
  orgId: string;
  subjectKind: string;
  subjectId: string;
  userId: string;
}): Promise<boolean> {
  const { orgId, subjectKind, subjectId, userId } = input;
  if (!(await verifyUser(orgId, userId))) return false;
  const adapter = getFlowAdapter(subjectKind);
  const permission = adapter?.decisionPermission
    ? await adapter.decisionPermission(subjectId, userId)
    : adapter?.permissions?.approve;
  if (!adapter || !permission || !(await actorHasPermission(db, orgId, userId, permission)))
    return false;
  const scope = await actorAllowedSubsidiaryIds(db, orgId, userId);
  if (scope === null) return true;
  const owners = await resolveSubjectSubsidiaries(
    orgId,
    subjectKind,
    adapter.scope,
    [subjectId],
    scope,
  );
  const owner = owners.get(subjectId);
  return typeof owner === "string" && scope.has(owner);
}
