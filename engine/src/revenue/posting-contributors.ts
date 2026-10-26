import {
  postingEffectHooks,
  type PostingEffectContributors,
} from "../journal/posting-effect-contributors.ts";
import { createObligationsFromInvoice } from "./recognition.ts";

const effects: PostingEffectContributors["revenue"] = { createObligationsFromInvoice };

/** Revenue recognition: a posted invoice's deferred lines become performance obligations. */
export function registerRevenuePostingContributors(): void {
  postingEffectHooks.register("revenue", effects);
}
