import assert from "node:assert/strict";
import test from "node:test";
import {
  assertStageMoveAllowed,
  effectiveOfferStatus,
  funnelCounts,
  timeToFillDays,
} from "./funnel.ts";

test("a sent offer past its expiry reads expired; every other status reads through", () => {
  assert.equal(
    effectiveOfferStatus({ status: "sent", expiresOn: "2026-09-01", businessToday: "2026-09-20" }),
    "expired",
  );
  assert.equal(
    effectiveOfferStatus({ status: "sent", expiresOn: "2026-09-20", businessToday: "2026-09-20" }),
    "sent",
  );
  assert.equal(
    effectiveOfferStatus({ status: "sent", expiresOn: null, businessToday: "2026-09-20" }),
    "sent",
  );
  assert.equal(
    effectiveOfferStatus({ status: "accepted", expiresOn: "2026-09-01", businessToday: "2026-09-20" }),
    "accepted",
  );
  assert.equal(
    effectiveOfferStatus({ status: "draft", expiresOn: null, businessToday: "2026-09-20" }),
    "draft",
  );
});

test("an unknown stored offer status is a failure, not a silent pass-through", () => {
  assert.throws(() => effectiveOfferStatus({ status: "lost", expiresOn: null, businessToday: "2026-09-20" }), /unknown offer status/);
});

test("time-to-fill counts whole days from opening to hire", () => {
  assert.equal(timeToFillDays("2026-08-01", "2026-09-20"), 50);
  assert.equal(timeToFillDays("2026-09-20", "2026-09-20"), 0);
});

test("time-to-fill refuses an unreadable date instead of averaging it", () => {
  assert.throws(() => timeToFillDays("not-a-date", "2026-09-20"), /unreadable date/);
});

test("the funnel counts every application on the template's own ordered stages", () => {
  assert.deepEqual(
    funnelCounts({
      stageKeys: ["applied", "screen", "interview", "hired"],
      applications: [{ stageKey: "applied" }, { stageKey: "screen" }, { stageKey: "screen" }],
    }),
    [
      { stageKey: "applied", count: 1 },
      { stageKey: "screen", count: 2 },
      { stageKey: "interview", count: 0 },
      { stageKey: "hired", count: 0 },
    ],
  );
});

test("the funnel refuses an application on an unknown stage instead of dropping it", () => {
  assert.throws(
    () =>
      funnelCounts({
        stageKeys: ["applied"],
        applications: [{ stageKey: "ghost" }],
      }),
    /unknown stage "ghost"/,
  );
});

test("the move matrix refuses every illegal shape by name", () => {
  const open = {
    fromStatus: "active",
    fromIsTerminal: false,
    toKind: "interview",
    toIsTerminal: false,
    sameTemplate: true,
    viaHire: false,
  } as const;
  assert.doesNotThrow(() => assertStageMoveAllowed({ ...open }));
  assert.throws(
    () => assertStageMoveAllowed({ ...open, fromStatus: "rejected" }),
    /rejected.*terminal/,
  );
  assert.throws(
    () => assertStageMoveAllowed({ ...open, fromIsTerminal: true }),
    /current stage is terminal/,
  );
  assert.throws(
    () => assertStageMoveAllowed({ ...open, sameTemplate: false }),
    /another pipeline template/,
  );
  assert.throws(
    () => assertStageMoveAllowed({ ...open, toKind: "hired", toIsTerminal: true }),
    /only through hire/,
  );
  assert.throws(
    () => assertStageMoveAllowed({ ...open, toKind: "rejected", toIsTerminal: true }),
    /through reject with a reason/,
  );
  // The hire transaction is the one legal path into the hired stage.
  assert.doesNotThrow(() =>
    assertStageMoveAllowed({ ...open, toKind: "hired", toIsTerminal: true, viaHire: true }),
  );
});
