import { PostingError } from "../journal/posting-contracts.ts";
import {
  postingPreconditionHooks,
  type PostingPreconditions,
} from "../journal/posting-preconditions.ts";
import { assertBillPostingAllowed, ComplianceError } from "./compliance.ts";

const preconditions: PostingPreconditions["compliance"] = {
  async assertBillPostingAllowed(input) {
    try {
      await assertBillPostingAllowed(input);
    } catch (error) {
      if (error instanceof ComplianceError) throw new PostingError(error.message);
      throw error;
    }
  },
};

/** Subcontractor compliance: block_bill requirements refuse the bill's posting. */
export function registerCompliancePostingContributors(): void {
  postingPreconditionHooks.register("compliance", preconditions);
}
