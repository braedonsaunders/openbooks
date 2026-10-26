import assert from "node:assert/strict";
import test from "node:test";
import { placeSourcePostingDate, resolveSourcePostingDate } from "./source-posting-date.ts";
import type { NativeDocument } from "./native.ts";

const JULY = { periodId: "period-july", start: "2026-07-01", end: "2026-07-31" };

test("a source date inside its posting period is kept under either policy", () => {
  for (const policy of ["refuse", "period_boundary"] as const) {
    for (const date of ["2026-07-01", "2026-07-15", "2026-07-31"]) {
      assert.deepEqual(resolveSourcePostingDate(date, JULY, policy, "netsuite"), {
        kind: "inside",
      });
    }
  }
});

test("refusing names the source date, the period window and both remedies", () => {
  const resolution = resolveSourcePostingDate("2020-07-30", JULY, "refuse", "netsuite");
  assert.equal(resolution.kind, "refused");
  assert.match(
    resolution.kind === "refused" ? resolution.message : "",
    /source date 2020-07-30 is outside its netsuite posting period \(2026-07-01 to 2026-07-31\)\. Correct the date in netsuite, or set this connection's out-of-period dates to post on the period boundary\./,
  );
});

test("the period boundary policy posts on the window date nearest the source date", () => {
  assert.deepEqual(resolveSourcePostingDate("2020-07-30", JULY, "period_boundary", "netsuite"), {
    kind: "boundary",
    postingDate: "2026-07-01",
    evidence: {
      sourceDate: "2020-07-30",
      periodId: "period-july",
      postedOn: "2026-07-01",
      policy: "period_boundary",
    },
  });
  assert.deepEqual(resolveSourcePostingDate("2026-08-01", JULY, "period_boundary", "netsuite"), {
    kind: "boundary",
    postingDate: "2026-07-31",
    evidence: {
      sourceDate: "2026-08-01",
      periodId: "period-july",
      postedOn: "2026-07-31",
      policy: "period_boundary",
    },
  });
});

function sourceDocument(overrides: Partial<NativeDocument>): NativeDocument {
  return {
    sourceRef: "SRC-1",
    kind: "journal",
    posting: true,
    partyId: null,
    documentDate: "2020-07-30",
    dueDate: null,
    memo: null,
    referenceNumber: null,
    controlAccountId: null,
    lines: [],
    ...overrides,
  };
}

test("only a posting document that names its source period is placed", async () => {
  let reads = 0;
  const readWindow = async () => {
    reads++;
    return JULY;
  };
  assert.deepEqual(
    await placeSourcePostingDate(
      sourceDocument({ postingPeriodId: null }),
      readWindow,
      "refuse",
      "netsuite",
    ),
    { postingDate: "2020-07-30", evidence: null },
  );
  assert.deepEqual(
    await placeSourcePostingDate(
      sourceDocument({ posting: false, postingPeriodId: "period-july" }),
      readWindow,
      "refuse",
      "netsuite",
    ),
    { postingDate: "2020-07-30", evidence: null },
  );
  assert.equal(reads, 0);
  assert.deepEqual(
    await placeSourcePostingDate(
      sourceDocument({ postingPeriodId: "period-july", postingDate: "2026-08-03" }),
      readWindow,
      "period_boundary",
      "netsuite",
    ),
    {
      postingDate: "2026-07-31",
      evidence: {
        sourceDate: "2026-08-03",
        periodId: "period-july",
        postedOn: "2026-07-31",
        policy: "period_boundary",
      },
    },
  );
  assert.equal(reads, 1);
});
