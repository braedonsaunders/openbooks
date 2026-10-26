import { PostingError } from "../journal/posting-contracts.ts";
import {
  postingEffectHooks,
  type PostingEffectContributors,
} from "../journal/posting-effect-contributors.ts";
import {
  postingPreconditionHooks,
  type PostingPreconditions,
} from "../journal/posting-preconditions.ts";
import { finalizePaymentAcceptanceForDocument } from "./acceptance-effect.ts";
import { PaymentError } from "./payment-errors.ts";
import { assertProviderReturnPosting } from "./provider-return-posting.ts";
import { assertReceiptFundingPosting } from "./receipt-funding.ts";

function asPostingRefusal(error: unknown): unknown {
  return error instanceof PaymentError ? new PostingError(error.message) : error;
}

const preconditions: PostingPreconditions["payments-core"] = {
  assertProviderReturnPosting(document) {
    try {
      assertProviderReturnPosting(document);
    } catch (error) {
      throw asPostingRefusal(error);
    }
  },
  async assertReceiptFundingPosting(executor, document, actorId, actualAccountIds) {
    try {
      await assertReceiptFundingPosting(executor, document, actorId, actualAccountIds);
    } catch (error) {
      throw asPostingRefusal(error);
    }
  },
};

const effects: PostingEffectContributors["payments-core"] = {
  finalizeAcceptance: finalizePaymentAcceptanceForDocument,
};

/** Payments: provider-return and funding refusals, and acceptance completion for posted payments. */
export function registerPaymentsCorePostingContributors(): void {
  postingPreconditionHooks.register("payments-core", preconditions);
  postingEffectHooks.register("payments-core", effects);
}
