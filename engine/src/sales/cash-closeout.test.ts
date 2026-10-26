import assert from "node:assert/strict";
import test from "node:test";
import {
  CashCloseoutError,
  FEE_TENDER_KINDS,
  assertTenderCloseoutPart,
  parseCashCloseout,
  serializeCashCloseout,
} from "./cash-closeout.ts";

const tenders = [
  { kind: "cash", amountMinor: 10_000_000n },
  { kind: "card", amountMinor: 11_500_000n },
];

test("no close-out bag parses to null", () => {
  assert.equal(parseCashCloseout(undefined, tenders), null);
  assert.equal(parseCashCloseout(null, tenders), null);
  assert.equal(parseCashCloseout({}, tenders), null);
  assert.equal(
    parseCashCloseout({ tipsTotal: "0", feeTotal: "0", overShort: "0", parts: [] }, tenders),
    null,
  );
});

test("a full close-out parses with sorted parts", () => {
  const parsed = parseCashCloseout(
    {
      tipsTotal: "5.0000",
      feeTotal: "0.3500",
      overShort: "-0.5000",
      serverPartyId: "123e4567-e89b-12d3-a456-426614174000",
      parts: [{ position: 2, tip: "5.0000", fee: "0.3500" }],
    },
    tenders,
  );
  assert.deepEqual(parsed, {
    tipsTotalMinor: 50000n,
    feeTotalMinor: 3500n,
    overShortMinor: -5000n,
    serverPartyId: "123e4567-e89b-12d3-a456-426614174000",
    parts: [{ position: 2, tipMinor: 50000n, feeMinor: 3500n }],
  });
});

test("an explicit null server pools the tips instead of keeping a named server", () => {
  const parsed = parseCashCloseout(
    {
      tipsTotal: "5.0000",
      feeTotal: "0.0000",
      overShort: "0",
      serverPartyId: null,
      parts: [{ position: 1, tip: "5.0000", fee: "0.0000" }],
    },
    tenders,
  );
  assert.equal(parsed?.serverPartyId, null);
});

test("an unknown close-out field refuses instead of parking silently", () => {
  assert.throws(
    () => parseCashCloseout({ tipsTotal: "1", typoTotla: "2" }, tenders),
    (error: unknown) =>
      error instanceof CashCloseoutError && /unknown field "typoTotla"/.test(error.message),
  );
});

test("totals must cross-foot to the parts", () => {
  assert.throws(
    () =>
      parseCashCloseout({ tipsTotal: "6.0000", parts: [{ position: 2, tip: "5.0000" }] }, tenders),
    (error: unknown) =>
      error instanceof CashCloseoutError &&
      /tips total 6\.0000 does not match its tender tips 5\.0000/.test(error.message),
  );
  assert.throws(
    () =>
      parseCashCloseout({ feeTotal: "1.0000", parts: [{ position: 2, fee: "0.3500" }] }, tenders),
    (error: unknown) =>
      error instanceof CashCloseoutError && /fee total 1\.0000 does not match/.test(error.message),
  );
});

test("a tip on a gift card tender refuses", () => {
  assert.throws(
    () =>
      parseCashCloseout({ tipsTotal: "1.0000", parts: [{ position: 1, tip: "1.0000" }] }, [
        { kind: "stored_value", amountMinor: 10_000_000n },
      ]),
    (error: unknown) =>
      error instanceof CashCloseoutError && /puts a tip on a gift card tender/.test(error.message),
  );
});

test("a processor fee rides card-family tenders only", () => {
  assert.ok(FEE_TENDER_KINDS.has("card"));
  assert.ok(!FEE_TENDER_KINDS.has("cash"));
  assert.throws(
    () =>
      parseCashCloseout({ feeTotal: "0.3000", parts: [{ position: 1, fee: "0.3000" }] }, tenders),
    (error: unknown) =>
      error instanceof CashCloseoutError &&
      /deducts a processor fee from a cash tender/.test(error.message),
  );
});

test("tip and fee cannot exceed what the tender collected", () => {
  assert.throws(
    () =>
      parseCashCloseout(
        { tipsTotal: "2000.0000", parts: [{ position: 2, tip: "2000.0000" }] },
        tenders,
      ),
    (error: unknown) =>
      error instanceof CashCloseoutError &&
      /exceeds its tender's collected 1150\.0000/.test(error.message),
  );
});

test("parts must name this sale's tenders exactly once", () => {
  assert.throws(
    () => parseCashCloseout({ tipsTotal: "1", parts: [{ position: 3, tip: "1" }] }, tenders),
    (error: unknown) =>
      error instanceof CashCloseoutError && /not one of this sale's 2 tenders/.test(error.message),
  );
  assert.throws(
    () =>
      parseCashCloseout(
        {
          tipsTotal: "2",
          parts: [
            { position: 2, tip: "1" },
            { position: 2, tip: "1" },
          ],
        },
        tenders,
      ),
    (error: unknown) =>
      error instanceof CashCloseoutError && /repeats tender 2/.test(error.message),
  );
  assert.throws(
    () => parseCashCloseout({ tipsTotal: "0", parts: [{ position: 2 }] }, tenders),
    (error: unknown) =>
      error instanceof CashCloseoutError && /no tip and no fee/.test(error.message),
  );
});

test("a malformed server reference refuses", () => {
  assert.throws(
    () =>
      parseCashCloseout({ overShort: "0.2500", serverPartyId: "not-a-uuid", parts: [] }, tenders),
    (error: unknown) =>
      error instanceof CashCloseoutError && /not a valid staff reference/.test(error.message),
  );
});

test("the row-level check is shared with the tender writer", () => {
  assert.doesNotThrow(() =>
    assertTenderCloseoutPart(
      { kind: "card", amountMinor: 1000n, tipMinor: 100n, feeMinor: 10n },
      "Tender 1",
    ),
  );
  assert.throws(
    () =>
      assertTenderCloseoutPart(
        { kind: "cash", amountMinor: 1000n, tipMinor: 0n, feeMinor: 10n },
        "Tender 1",
      ),
    (error: unknown) => error instanceof CashCloseoutError && /cash tender/.test(error.message),
  );
});

test("serialize round-trips through parse", () => {
  const parsed = parseCashCloseout(
    { feeTotal: "0.3500", overShort: "0.2500", parts: [{ position: 2, fee: "0.3500" }] },
    tenders,
  );
  assert.ok(parsed);
  const reparsed = parseCashCloseout(
    serializeCashCloseout(parsed),
    tenders.map((tender) => ({ kind: tender.kind, amountMinor: tender.amountMinor })),
  );
  assert.deepEqual(reparsed, parsed);
});
