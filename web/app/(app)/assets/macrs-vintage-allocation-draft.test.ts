import assert from "node:assert/strict";
import test from "node:test";
import { macrsVintageKey } from "@openbooks/engine/src/tax-returns/asset-basis-policy.ts";
import {
  prepareMacrsVintageAllocations,
  type OpenMacrsVintage,
} from "./macrs-vintage-allocation-draft";

function source(transferOn: string, unadjustedBasis: string): OpenMacrsVintage {
  const identity = {
    source: "carryover" as const,
    placedInServiceOn: "2024-03-15",
    transferOn,
  };
  return {
    ...identity,
    key: macrsVintageKey(identity),
    unadjustedBasis,
    adjustedCarryover: "500.0000",
    section179: "0.0000",
    priorDepreciation: "100.0000",
  };
}
const first = source("2025-08-20", "1000.0001");
const second = source("2026-01-20", "2000.0002");
const edits = {
  [first.key]: {
    disposedUnadjustedBasis: "250.0001",
    remainingUnadjustedBasis: "750.0000",
  },
  [second.key]: {
    disposedUnadjustedBasis: "0.0000",
    remainingUnadjustedBasis: "2000.0002",
  },
};

test("allocations preserve two same-day placements with distinct transfers and exact totals", () => {
  const result = prepareMacrsVintageAllocations([first, second], edits);
  assert.equal(result.disposedUnadjustedBasis, "250.0001");
  assert.equal(result.remainingUnadjustedBasis, "2750.0002");
  assert.deepEqual(result.vintageAllocations.map(macrsVintageKey), [
    first.key,
    second.key,
  ]);
  assert.equal(result.vintageAllocations[1]!.disposedUnadjustedBasis, "0.0000");
  const reordered = prepareMacrsVintageAllocations([second, first], edits);
  assert.equal(
    reordered.disposedUnadjustedBasis,
    result.disposedUnadjustedBasis,
  );
  assert.deepEqual(reordered.vintageAllocations.map(macrsVintageKey), [
    second.key,
    first.key,
  ]);
});

test("an unanswered row never silently disposes or retains the whole vintage", () => {
  assert.throws(
    () =>
      prepareMacrsVintageAllocations([first, second], {
        [first.key]: edits[first.key]!,
      }),
    /enter disposed unadjusted tax basis; enter 0/,
  );
  assert.throws(
    () =>
      prepareMacrsVintageAllocations([first], {
        [first.key]: {
          disposedUnadjustedBasis: "",
          remainingUnadjustedBasis: "1000.0001",
        },
      }),
    /enter disposed/,
  );
});

test("each vintage must reconcile even when aggregate totals reconcile", () => {
  assert.throws(
    () =>
      prepareMacrsVintageAllocations([first, second], {
        [first.key]: {
          disposedUnadjustedBasis: "1250.0001",
          remainingUnadjustedBasis: "0",
        },
        [second.key]: {
          disposedUnadjustedBasis: "0",
          remainingUnadjustedBasis: "1750.0002",
        },
      }),
    /must add to the open unadjusted tax basis 1000.0001/,
  );
});

test("locale decimals are refused with the shared remedy without changing the allocation", () => {
  const values = {
    disposedUnadjustedBasis: "12,34",
    remainingUnadjustedBasis: "987.6601",
  };
  assert.throws(
    () => prepareMacrsVintageAllocations([first], { [first.key]: values }),
    /write "12,34" as "12.34"/,
  );
  assert.equal(values.disposedUnadjustedBasis, "12,34");
  assert.throws(
    () =>
      prepareMacrsVintageAllocations([first], {
        [first.key]: {
          disposedUnadjustedBasis: "1,234",
          remainingUnadjustedBasis: "0",
        },
      }),
    /could mean 1234.*1.234/,
  );
});

test("negative, rounded and stale allocations cannot be submitted", () => {
  assert.throws(
    () =>
      prepareMacrsVintageAllocations([first], {
        [first.key]: {
          disposedUnadjustedBasis: "-1",
          remainingUnadjustedBasis: "1001.0001",
        },
      }),
    /cannot be negative/,
  );
  assert.throws(
    () =>
      prepareMacrsVintageAllocations([first], {
        [first.key]: {
          disposedUnadjustedBasis: "0.00001",
          remainingUnadjustedBasis: "1000.00009",
        },
      }),
    /at most 4 decimal places/,
  );
  assert.throws(
    () => prepareMacrsVintageAllocations([second], edits),
    /no longer match/,
  );
  assert.throws(
    () => prepareMacrsVintageAllocations([first, first], edits),
    /no longer match/,
  );
  assert.throws(
    () => prepareMacrsVintageAllocations([], {}),
    /No open tax depreciation vintages/,
  );
});

test("summing allocation amounts never crosses the binary floating point boundary", () => {
  const large = source("2025-08-20", "90071992547409.1234");
  const result = prepareMacrsVintageAllocations([large], {
    [large.key]: {
      disposedUnadjustedBasis: "90071992547409.1233",
      remainingUnadjustedBasis: "0.0001",
    },
  });
  assert.equal(result.disposedUnadjustedBasis, "90071992547409.1233");
  assert.equal(result.remainingUnadjustedBasis, "0.0001");
});
