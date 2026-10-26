import { add, apportion, cmp, fromUnits, isZero, neg, toUnits } from "../money/money.ts";
import { refuse } from "./asset-refusal.ts";

/**
 * Pure planning for accepting asset proposals: which proposal amount lands
 * on which resulting asset, and the reclassification lines that move each
 * amount from the account the purchase debited to the asset's cost account.
 * The purchase already debited the GL once, so acceptance only ever moves
 * an amount between accounts — it never adds cost.
 */

export const ACCEPTANCE_OPERATIONS = ["asset", "split", "merge", "component", "cip"] as const;
export type AcceptanceOperation = (typeof ACCEPTANCE_OPERATIONS)[number];

export interface PlannedProposal {
  id: string;
  amount: string;
  subsidiaryId: string;
  currency: string;
  accountId: string;
  postingDate: string;
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
}

export interface PlannedTarget {
  amount: string;
  quantity?: string | null;
}

export interface PlannedAllocation {
  proposalId: string;
  targetIndex: number;
  amount: string;
}

function positive(value: string, label: string): string {
  if (cmp(value, "0") <= 0) refuse("amount_not_positive", `${label} must be greater than zero`);
  return add(value, "0");
}

/**
 * Decide the proposal → target allocation for one acceptance, refusing any
 * plan that would capitalize more or less than the proposals carry.
 */
export function planAllocations(
  operation: AcceptanceOperation,
  proposals: readonly PlannedProposal[],
  targets: readonly PlannedTarget[],
): PlannedAllocation[] {
  if (proposals.length === 0) refuse("proposals_required", "select at least one proposal");
  if (new Set(proposals.map((proposal) => proposal.id)).size !== proposals.length) {
    refuse("proposals_duplicate", "a proposal can appear only once in an acceptance");
  }
  const subsidiaries = new Set(proposals.map((proposal) => proposal.subsidiaryId));
  if (subsidiaries.size > 1) {
    refuse(
      "proposals_cross_subsidiary",
      "proposals from different legal entities cannot be accepted together",
      {
        remedy: "Accept each legal entity's proposals separately.",
      },
    );
  }
  if (new Set(proposals.map((proposal) => proposal.currency)).size > 1) {
    refuse(
      "proposals_mixed_currency",
      "proposals in different currencies cannot be accepted together",
    );
  }
  const total = proposals.reduce((sum, proposal) => add(sum, proposal.amount), "0");
  switch (operation) {
    case "asset":
    case "component": {
      if (proposals.length !== 1)
        refuse(
          "single_proposal_required",
          `${operation === "asset" ? "creating an asset" : "adding a component"} takes exactly one proposal; use merge to combine lines`,
        );
      if (targets.length !== 1)
        refuse("single_target_required", "exactly one resulting asset is required");
      const amount = positive(targets[0]!.amount, "the asset cost");
      if (cmp(amount, total) !== 0) {
        refuse(
          "amount_mismatch",
          `the asset cost ${amount} must equal the proposal amount ${total}`,
          {
            remedy: "Split the proposal to capitalize it as several assets.",
          },
        );
      }
      return [{ proposalId: proposals[0]!.id, targetIndex: 0, amount }];
    }
    case "split": {
      if (proposals.length !== 1)
        refuse("single_proposal_required", "a split takes exactly one proposal");
      if (targets.length < 2)
        refuse("split_targets_required", "a split needs at least two resulting assets");
      const amounts = targets.map((target, index) =>
        positive(target.amount, `asset ${index + 1} cost`),
      );
      const allocated = amounts.reduce((sum, amount) => add(sum, amount), "0");
      if (cmp(allocated, total) !== 0) {
        refuse(
          "amount_mismatch",
          `the split assets total ${allocated} but the proposal carries ${total}`,
        );
      }
      return amounts.map((amount, targetIndex) => ({
        proposalId: proposals[0]!.id,
        targetIndex,
        amount,
      }));
    }
    case "merge": {
      if (proposals.length < 2)
        refuse("merge_proposals_required", "a merge needs at least two proposals");
      if (targets.length !== 1)
        refuse("single_target_required", "a merge produces exactly one asset");
      const amount = positive(targets[0]!.amount, "the asset cost");
      if (cmp(amount, total) !== 0) {
        refuse(
          "amount_mismatch",
          `the merged asset cost ${amount} must equal the proposals' total ${total}`,
        );
      }
      return proposals.map((proposal) => ({
        proposalId: proposal.id,
        targetIndex: 0,
        amount: add(proposal.amount, "0"),
      }));
    }
    case "cip":
      return proposals.map((proposal) => ({
        proposalId: proposal.id,
        targetIndex: 0,
        amount: add(proposal.amount, "0"),
      }));
  }
}

export interface ReclassLine {
  accountId: string;
  amount: string;
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
  memo: string;
}

/**
 * Debit each target account and credit the account the purchase debited,
 * per allocation, carrying the source line's dimensions on both legs so
 * project and department reporting are unchanged. Allocations whose source
 * already is the target account need no movement and produce no lines.
 */
export function buildReclassLines(
  allocations: readonly {
    sourceAccountId: string;
    targetAccountId: string;
    amount: string;
    departmentId: string | null;
    projectId: string | null;
    locationId: string | null;
    memo: string;
  }[],
): ReclassLine[] {
  const lines: ReclassLine[] = [];
  for (const allocation of allocations) {
    if (allocation.sourceAccountId === allocation.targetAccountId) continue;
    if (isZero(allocation.amount)) continue;
    const dims = {
      departmentId: allocation.departmentId,
      projectId: allocation.projectId,
      locationId: allocation.locationId,
    };
    lines.push({
      accountId: allocation.targetAccountId,
      amount: add(allocation.amount, "0"),
      memo: allocation.memo,
      ...dims,
    });
    lines.push({
      accountId: allocation.sourceAccountId,
      amount: neg(allocation.amount),
      memo: allocation.memo,
      ...dims,
    });
  }
  const residual = lines.reduce((sum, line) => add(sum, line.amount), "0");
  if (!isZero(residual))
    refuse("reclass_unbalanced", `the reclassification does not balance (residual ${residual})`);
  return lines;
}

/**
 * Split an amount into `parts` equal shares to the cent, dealing leftover
 * cents to the earliest shares, so the shares always sum to the amount.
 */
export function splitEvenly(amount: string, parts: number): string[] {
  if (!Number.isInteger(parts) || parts < 2 || parts > 500)
    refuse("split_parts_invalid", "split into between 2 and 500 assets");
  const units = toUnits(amount);
  if (units <= 0n) refuse("amount_not_positive", "the amount to split must be greater than zero");
  if (units % 100n !== 0n)
    refuse("split_precision", "only an amount stated to the cent can be split evenly");
  return apportion(
    units / 100n,
    Array.from({ length: parts }, () => 1n),
  ).map((cents) => fromUnits(cents * 100n));
}
