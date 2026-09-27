import { FUND_RELEASE_SUBJECT_KIND } from "../flows/fund-releases-adapter.ts";
import type { FlowApprovalReleaseArgs } from "../flows/approval-release-hook.ts";
import { NonprofitError } from "./errors.ts";
import { releaseFundReleaseApproval } from "./releases.ts";

export async function releaseFundReleaseFlowApproval(
  args: FlowApprovalReleaseArgs,
): Promise<void> {
  if (args.subjectKind !== FUND_RELEASE_SUBJECT_KIND) {
    throw new NonprofitError({
      message: `The flow release handler cannot process subject kind "${args.subjectKind}".`,
      status: 409,
      code: "fund_release_subject_kind_invalid",
      remedy: "Route fund release decisions through the fund release approval subject.",
    });
  }
  await releaseFundReleaseApproval({
    subjectId: args.subjectId,
    outcome: args.outcome,
    comment: args.comment,
    ctx: args.ctx,
  });
}
