import {
  postingEffectHooks,
  type PostingEffectContributors,
} from "../journal/posting-effect-contributors.ts";
import {
  voidRemedyHooks,
  type VoidRemedyContributors,
} from "../journal/void-remedy-contributors.ts";
import { emitDocumentPosted, emitDocumentVoided, emitPaymentReceived } from "./emit.ts";

const effects: PostingEffectContributors["webhooks"] = {
  documentPosted: emitDocumentPosted,
  paymentReceived: emitPaymentReceived,
};

const remedies: VoidRemedyContributors["webhooks"] = { documentVoided: emitDocumentVoided };

/** Domain events for posted and voided documents. */
export function registerWebhooksPostingContributors(): void {
  postingEffectHooks.register("webhooks", effects);
  voidRemedyHooks.register("webhooks", remedies);
}
