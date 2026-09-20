import { allocateByRelativeSSP } from "./recognition.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import {
  add,
  neg,
  sum,
  cmp,
  mulPercent,
  fromUnits,
  toUnits,
} from "../money/money.ts";

export type RevenueModificationTreatment =
  "separate" | "prospective" | "catch_up";
export function modificationMoney(value: unknown, label: string): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null || exact.replace(/^-/, "").split(".")[0]!.length > 15)
    throw new Error(`${label} must be an exact numeric(19,4) decimal`);
  return fromUnits(toUnits(exact));
}
/** IFRS 15.18–21 / ASC 606-10-25-10–13. Groups are the documented
 * distinctness assessment; mixed modifications compose these same treatments.
 * Each book supplies its own actual recognized balance. No posted amount is
 * restated by a prospective modification. SSPs are extended amounts. */
export function measureRevenueModificationGroup(input: {
  treatment: RevenueModificationTreatment;
  considerationChange: string;
  existing: {
    id: string;
    allocated: string;
    recognized: string;
    netCredits: string;
  }[];
  promises: { existingId?: string; ssp: string; percentComplete: string }[];
  remainingDistinct: boolean;
  additionsAtStandalonePrice: boolean;
}) {
  const delta = modificationMoney(
    input.considerationChange,
    "Consideration change",
  );
  if (!["separate", "prospective", "catch_up"].includes(input.treatment))
    throw new Error("select the modification accounting treatment");
  if (!input.promises.length)
    throw new Error("describe the promises after modification");
  const old = new Map(input.existing.map((row) => [row.id, row]));
  if (old.size !== input.existing.length)
    throw new Error("an obligation appears twice in the modification group");
  const seen = new Set<string>();
  for (const promise of input.promises) {
    modificationMoney(promise.ssp, "Standalone selling price");
    const progress = modificationMoney(promise.percentComplete, "Progress");
    if (cmp(progress, "0") < 0 || cmp(progress, "100") > 0)
      throw new Error("progress must be between 0 and 100 percent");
    if (promise.existingId) {
      if (!old.has(promise.existingId) || seen.has(promise.existingId))
        throw new Error(
          "each retained obligation must belong to this group and appear once",
        );
      seen.add(promise.existingId);
    }
  }
  const priorPrice = sum(
    input.existing.map((row) =>
      modificationMoney(row.allocated, "Allocated price"),
    ),
  );
  const priorRecognized = sum(
    input.existing.map((row) =>
      modificationMoney(row.recognized, "Recognized revenue"),
    ),
  );
  const credits = sum(
    input.existing.map((row) =>
      modificationMoney(row.netCredits, "Deferred credits"),
    ),
  );
  if (input.treatment === "separate") {
    if (
      input.existing.length ||
      input.promises.some((p) => p.existingId) ||
      !input.remainingDistinct ||
      !input.additionsAtStandalonePrice ||
      cmp(delta, "0") <= 0
    )
      throw new Error(
        "a separate contract requires only additional distinct promises at commensurate standalone prices",
      );
  } else if (input.treatment === "prospective" && !input.remainingDistinct) {
    throw new Error(
      "prospective treatment requires remaining goods or services distinct from those already transferred",
    );
  } else if (input.treatment === "catch_up") {
    if (
      input.remainingDistinct ||
      input.existing.length !== 1 ||
      input.promises.length !== 1 ||
      input.promises[0]!.existingId !== input.existing[0]!.id
    )
      throw new Error(
        "a catch-up group must retain its single partially satisfied, non-distinct performance obligation",
      );
  }
  const pool = sum([
    priorPrice,
    delta,
    neg(credits),
    ...(input.treatment === "prospective" ? [neg(priorRecognized)] : []),
  ]);
  if (cmp(pool, "0") < 0)
    throw new Error(
      "the modification leaves negative consideration for remaining performance; reassess the concession and its allocation to satisfied promises",
    );
  const allocations = allocateByRelativeSSP(
    pool,
    input.promises.map((p) => ({ ssp: p.ssp })),
  );
  const promises = input.promises.map((promise, i) => {
    const earned = promise.existingId
      ? old.get(promise.existingId)!.recognized
      : "0.0000";
    const allocated =
      input.treatment === "prospective"
        ? add(earned, allocations[i]!)
        : allocations[i]!;
    const target =
      input.treatment === "catch_up"
        ? mulPercent(allocated, promise.percentComplete, 4)
        : earned;
    return {
      allocated,
      priorRecognized: earned,
      targetRecognized: target,
      catchUp: add(target, neg(earned)),
      remaining: add(allocated, neg(target)),
    };
  });
  const retired = input.existing
    .filter((row) => !seen.has(row.id))
    .map((row) => ({ id: row.id, allocated: row.recognized }));
  return {
    priorPrice,
    priorRecognized,
    netCredits: credits,
    considerationChange: delta,
    pool,
    promises,
    retired,
    newTotal: sum([
      ...promises.map((p) => p.allocated),
      ...retired.map((r) => r.allocated),
    ]),
  };
}
