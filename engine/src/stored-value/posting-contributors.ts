import {
  postingEffectHooks,
  type PostingEffectContributors,
} from "../journal/posting-effect-contributors.ts";
import {
  postingLineHooks,
  type PostingLineContributors,
} from "../journal/posting-line-contributors.ts";
import {
  voidRemedyHooks,
  type VoidRemedyContributors,
} from "../journal/void-remedy-contributors.ts";
import { issueStoreCreditForCreditMemo, issueStoredValueForInvoice } from "./invoice-effects.ts";
import {
  resolveStoreCreditLiability,
  resolveStoredValueLiabilityByLine,
} from "./posting-accounts.ts";
import { reverseStoredValueForVoidedDocument } from "./void-reversal.ts";

const lines: PostingLineContributors["stored-value"] = {
  liabilityByLine: resolveStoredValueLiabilityByLine,
  storeCreditLiability: resolveStoreCreditLiability,
};

const effects: PostingEffectContributors["stored-value"] = {
  issueForInvoice: issueStoredValueForInvoice,
  issueStoreCreditForCreditMemo,
};

const remedies: VoidRemedyContributors["stored-value"] = {
  reverseForVoidedDocument: reverseStoredValueForVoidedDocument,
};

/** Stored value: liability routing, issuance on posting, and the card subledger on void. */
export function registerStoredValuePostingContributors(): void {
  postingLineHooks.register("stored-value", lines);
  postingEffectHooks.register("stored-value", effects);
  voidRemedyHooks.register("stored-value", remedies);
}
