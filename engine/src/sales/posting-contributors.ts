import { PostingError } from "../journal/posting-contracts.ts";
import {
  postingEffectHooks,
  type PostingEffectContributors,
} from "../journal/posting-effect-contributors.ts";
import {
  postingLineHooks,
  type PostingLineContributors,
} from "../journal/posting-line-contributors.ts";
import { CashCloseoutError, resolveCashCloseoutForPosting } from "./cash-closeout.ts";
import {
  hasStoredValueTenders,
  redeemCashSaleTenders,
  resolveCashPostingTenders,
  settleCashRefundTenders,
  TenderRefusal,
} from "./document-tenders.ts";

const lines: PostingLineContributors["sales"] = {
  async cashTenders(runner, orgId, documentId, parent, options) {
    try {
      return await resolveCashPostingTenders(runner, orgId, documentId, parent, options);
    } catch (error) {
      if (error instanceof TenderRefusal) throw new PostingError(error.message);
      throw error;
    }
  },
  async cashCloseout(runner, orgId, custom, tenders) {
    try {
      return await resolveCashCloseoutForPosting(runner, orgId, custom, tenders);
    } catch (error) {
      // PostingError carries no remedy field: the named Setup remedy rides
      // in the message so the operator sees it beside the refusal.
      if (error instanceof CashCloseoutError)
        throw new PostingError(`${error.message} ${error.remedy}`);
      throw error;
    }
  },
};

const effects: PostingEffectContributors["sales"] = {
  async redeemCashSaleTenders(orgId, documentId, options) {
    try {
      await redeemCashSaleTenders(orgId, documentId, options);
    } catch (error) {
      if (error instanceof TenderRefusal) throw new PostingError(error.message);
      throw error;
    }
  },
  hasStoredValueTenders,
  settleCashRefundTenders,
};

/** Sales: cash tenders and close-out on cash sales and refunds. */
export function registerSalesPostingContributors(): void {
  postingLineHooks.register("sales", lines);
  postingEffectHooks.register("sales", effects);
}
