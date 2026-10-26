import assert from "node:assert/strict";
import test from "node:test";
import { canMergeProposalScopes, proposalMergeScopeIssue } from "./asset-proposal-merge.ts";

test("proposal merges require known currency and one subsidiary", () => {
  const first = { currency: "CAD", subsidiaryId: "north" };
  assert.equal(canMergeProposalScopes([]), false);
  assert.equal(canMergeProposalScopes([first]), false);
  assert.equal(canMergeProposalScopes([first, { ...first }]), true);
  assert.equal(proposalMergeScopeIssue([first, { ...first, currency: "EUR" }]), "currency");
  assert.equal(proposalMergeScopeIssue([first, { ...first, subsidiaryId: "south" }]), "subsidiary");
  assert.equal(proposalMergeScopeIssue([first, { ...first, currency: "" }]), "missing_scope");
});
