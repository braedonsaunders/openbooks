import { releaseResourceRequest } from "./requests.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ReleaseArgs = {
  subjectId: string;
  outcome: "approved" | "rejected";
  comment?: string | null;
  ctx: {
    orgId: string;
    userId?: string | null;
    allowedSubsidiaryIds?: ReadonlySet<string> | null;
  };
};

/** Engine-owned release for the resource request subject. */
export async function releaseResourcingRequestApproval(args: ReleaseArgs): Promise<void> {
  const { subjectId, outcome, ctx } = args;
  if (!UUID_RE.test(subjectId)) {
    throw new Error(`unknown resource request ${subjectId}`);
  }
  if (outcome !== "approved" && outcome !== "rejected") {
    throw new Error(`unknown resource request decision ${outcome}`);
  }
  await releaseResourceRequest({
    orgId: ctx.orgId,
    actorId: ctx.userId ?? null,
    allowedSubsidiaryIds: ctx.allowedSubsidiaryIds ?? null,
    requestId: subjectId,
    outcome,
    comment: args.comment ?? null,
  });
}
