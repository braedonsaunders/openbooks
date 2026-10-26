import { PostingError } from "../journal/posting-contracts.ts";
import {
  postingEffectHooks,
  type PostingEffectContributors,
} from "../journal/posting-effect-contributors.ts";
import {
  postingPreconditionHooks,
  type PostingPreconditions,
} from "../journal/posting-preconditions.ts";
import {
  voidRemedyHooks,
  type VoidRemedyContributors,
} from "../journal/void-remedy-contributors.ts";
import { CrossBorderTaxError } from "./cross-border-place-of-supply.ts";
import { assertCrossBorderSupplyEvidence } from "./cross-border-posting.ts";
import { assertCanadianGoodsTaxEvidence } from "./goods-selection.ts";
import { PlaceOfSupplyError } from "./place-of-supply.ts";
import {
  enqueueProviderCommitTx,
  PROVIDER_COMMIT_KINDS,
  requestProviderVoidTx,
} from "./provider-commit.ts";

const preconditions: PostingPreconditions["tax"] = {
  async assertSupplyEvidence(runner, orgId, documentId, options) {
    try {
      await assertCanadianGoodsTaxEvidence(runner, orgId, documentId);
    } catch (error) {
      if (error instanceof PlaceOfSupplyError) throw new PostingError(error.message);
      throw error;
    }
    try {
      await assertCrossBorderSupplyEvidence(runner, orgId, documentId, options);
    } catch (error) {
      if (error instanceof CrossBorderTaxError) throw new PostingError(error.message);
      throw error;
    }
  },
};

const effects: PostingEffectContributors["tax"] = {
  async trackProviderCommit(runner, input) {
    if (!PROVIDER_COMMIT_KINDS[input.kind]) return;
    await enqueueProviderCommitTx(runner, input);
  },
};

const remedies: VoidRemedyContributors["tax"] = {
  // The void transaction marks the provider rows; the tax_provider_commit
  // scan performs the provider void call.
  async requestProviderVoid(executor, input) {
    if (!PROVIDER_COMMIT_KINDS[input.kind]) return;
    await requestProviderVoidTx(executor, { orgId: input.orgId, documentId: input.documentId });
  },
};

/** Tax: supply-evidence refusals and the external provider's commit and void tracking. */
export function registerTaxPostingContributors(): void {
  postingPreconditionHooks.register("tax", preconditions);
  postingEffectHooks.register("tax", effects);
  voidRemedyHooks.register("tax", remedies);
}
