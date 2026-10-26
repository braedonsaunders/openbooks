import { PostingError } from "../journal/posting-contracts.ts";
import {
  postingPreconditionHooks,
  type PostingPreconditions,
} from "../journal/posting-preconditions.ts";
import { assertWithholdingDepositCurrent } from "./deposits.ts";
import { assertWithholdingRemittanceCurrent, ContractorWithholdingError } from "./service.ts";

const preconditions: PostingPreconditions["contractor-withholding"] = {
  async assertSourcesCurrent(runner, orgId, documentId, source) {
    try {
      await assertWithholdingRemittanceCurrent(runner, orgId, documentId, source);
      await assertWithholdingDepositCurrent(runner, orgId, documentId, source);
    } catch (error) {
      if (error instanceof ContractorWithholdingError)
        throw new PostingError(error.remedy ? `${error.message} ${error.remedy}` : error.message);
      throw error;
    }
  },
};

/** Contractor withholding: remittance and deposit bills reconcile to their captured source. */
export function registerContractorWithholdingPostingContributors(): void {
  postingPreconditionHooks.register("contractor-withholding", preconditions);
}
