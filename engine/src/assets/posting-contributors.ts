import {
  postingEffectHooks,
  type PostingEffectContributors,
} from "../journal/posting-effect-contributors.ts";
import { proposeAssetsForPostedEntry } from "./asset-proposals.ts";

const effects: PostingEffectContributors["assets"] = {
  proposeForPostedEntry: proposeAssetsForPostedEntry,
};

/** Capitalization: posted purchase lines become asset proposals. */
export function registerAssetsPostingContributors(): void {
  postingEffectHooks.register("assets", effects);
}
