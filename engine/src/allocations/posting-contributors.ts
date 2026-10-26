import { PostingError } from "../journal/posting-contracts.ts";
import {
  postingLineHooks,
  type PostingLineContributors,
} from "../journal/posting-line-contributors.ts";
import { planDocumentEntryAllocations } from "./document-entry-plan.ts";
import { assertContributorBalance, collectPostContributions, PostAllocationError } from "./post.ts";
import { postDriverResolver } from "./report-runner.ts";

const lines: PostingLineContributors["allocations"] = {
  planEntryAllocations: planDocumentEntryAllocations,
  async collectPostContributions(runner, document, kernelLines, options, postingDate) {
    try {
      return await collectPostContributions(
        runner,
        document,
        kernelLines,
        { ...options, driverResolver: postDriverResolver },
        { postingDate },
      );
    } catch (error) {
      if (error instanceof PostAllocationError) throw new PostingError(error.message);
      throw error;
    }
  },
  assertContributorBalance,
};

/** Allocation kernel: entry-mode line splits at save and post-mode rule contributions at posting. */
export function registerAllocationsPostingContributors(): void {
  postingLineHooks.register("allocations", lines);
}
