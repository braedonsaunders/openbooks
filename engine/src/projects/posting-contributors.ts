import { PostingError } from "../journal/posting-contracts.ts";
import {
  postingPreconditionHooks,
  type PostingPreconditions,
} from "../journal/posting-preconditions.ts";
import {
  assertGeneratedBillingPostable,
  BillingSourceIntegrityError,
} from "./billing-source-integrity.ts";

const preconditions: PostingPreconditions["projects"] = {
  async assertGeneratedBillingPostable(runner, orgId, documentId, source, lock) {
    try {
      await assertGeneratedBillingPostable(runner, orgId, documentId, source, lock);
    } catch (error) {
      if (error instanceof BillingSourceIntegrityError) throw new PostingError(error.message);
      throw error;
    }
  },
};

/** Projects: generated billing keeps the economics of its project billing source. */
export function registerProjectsPostingContributors(): void {
  postingPreconditionHooks.register("projects", preconditions);
}
