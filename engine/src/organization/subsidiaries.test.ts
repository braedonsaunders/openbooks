import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db } from "../platform/db.ts";
import { add, mulRate } from "../money/money.ts";
import {
  absorbFxRoundingResidual,
  intercompanyBalancingLegs,
  SubsidiaryError,
  validateSubsidiaryRestrictions,
  type SubLine,
  type SubsidiaryContext,
} from "./subsidiaries.ts";

const originSubId = "00000000-0000-0000-0000-000000000001";
const counterSubId = "00000000-0000-0000-0000-000000000002";
const originDueFrom = "00000000-0000-0000-0000-000000000011";
const counterDueTo = "00000000-0000-0000-0000-000000000012";

const ctx: SubsidiaryContext = {
  byId: new Map([
    [originSubId, {
      id: originSubId,
      parentId: null,
      name: "Origin",
      baseCurrency: "CAD",
      isElimination: false,
      isActive: true,
    }],
    [counterSubId, {
      id: counterSubId,
      parentId: originSubId,
      name: "Counter",
      baseCurrency: "USD",
      isElimination: false,
      isActive: true,
    }],
  ]),
  rootId: originSubId,
  multi: true,
};

const runner = {
  execute: async () => ({
    rows: [{
      fromId: originSubId,
      toId: counterSubId,
      dueFrom: originDueFrom,
      dueTo: counterDueTo,
    }],
  }),
} as unknown as Pick<typeof db, "execute">;

function line(subsidiaryId: string, amount: string, txnAmount: string, fxRate: string): SubLine {
  return {
    accountId: randomUUID(),
    amount,
    txnAmount,
    currency: "CAD",
    fxRate,
    subsidiaryId,
  };
}

async function balancingLegs(lines: SubLine[]) {
  return intercompanyBalancingLegs(runner, {
    orgId: randomUUID(),
    ctx,
    originSubId,
    originFxRate: "1.0000000000",
    lines,
  });
}

test("posting refuses a line party outside that line's subsidiary", async () => {
  const linePartyId = randomUUID();
  let calls = 0;
  const runner = {
    execute: async () => {
      calls += 1;
      if (calls === 1) return { rows: [] };
      return {
        rows: [{
          id: linePartyId,
          name: "Root-only customer",
          subsidiaryId: originSubId,
          extra: [],
        }],
      };
    },
  } as unknown as Pick<typeof db, "execute">;

  await assert.rejects(
    validateSubsidiaryRestrictions(runner, {
      orgId: randomUUID(),
      ctx,
      docSubsidiaryId: originSubId,
      lines: [{
        accountId: randomUUID(),
        amount: "10.0000",
        subsidiaryId: counterSubId,
        partyId: linePartyId,
      }],
    }),
    (error: unknown) =>
      error instanceof SubsidiaryError &&
      /Root-only customer/.test(error.message) &&
      /Counter/.test(error.message),
  );
});

test("posting refuses an unknown header party instead of skipping it", async () => {
  // A deleted or foreign header partyId resolves to no row: the header
  // path must fail closed exactly like the line path, never proceed.
  const headerPartyId = randomUUID();
  let calls = 0;
  const runner = {
    execute: async () => {
      calls += 1;
      return { rows: [] };
    },
  } as unknown as Pick<typeof db, "execute">;
  await assert.rejects(
    validateSubsidiaryRestrictions(runner, {
      orgId: randomUUID(),
      ctx,
      docSubsidiaryId: originSubId,
      partyId: headerPartyId,
      lines: [{
        accountId: randomUUID(),
        amount: "10.0000",
        subsidiaryId: originSubId,
      }],
    }),
    (error: unknown) =>
      error instanceof SubsidiaryError &&
      /does not exist in this organization/.test(error.message) &&
      error.message.includes(headerPartyId),
  );
  // The accounts lookup plus the header party lookup both ran: the
  // refusal came from the check, not from skipping it.
  assert.equal(calls, 2);
});

test("posting refuses a header party outside the document subsidiary", async () => {
  const headerPartyId = randomUUID();
  let calls = 0;
  const runner = {
    execute: async () => {
      calls += 1;
      if (calls === 1) return { rows: [] };
      return {
        rows: [{
          id: headerPartyId,
          name: "Root-only customer",
          subsidiaryId: originSubId,
          extra: [],
        }],
      };
    },
  } as unknown as Pick<typeof db, "execute">;
  await assert.rejects(
    validateSubsidiaryRestrictions(runner, {
      orgId: randomUUID(),
      ctx,
      docSubsidiaryId: counterSubId,
      partyId: headerPartyId,
      lines: [{
        accountId: randomUUID(),
        amount: "10.0000",
        subsidiaryId: counterSubId,
      }],
    }),
    (error: unknown) =>
      error instanceof SubsidiaryError &&
      /Root-only customer/.test(error.message) &&
      /Counter/.test(error.message),
  );
});

test("posting accepts a header party inside the document subsidiary", async () => {
  const headerPartyId = randomUUID();
  const runner = {
    execute: async () => {
      return {
        rows: [{
          id: headerPartyId,
          name: "Counter customer",
          subsidiaryId: counterSubId,
          extra: [],
        }],
      };
    },
  } as unknown as Pick<typeof db, "execute">;
  await validateSubsidiaryRestrictions(runner, {
    orgId: randomUUID(),
    ctx,
    docSubsidiaryId: counterSubId,
    partyId: headerPartyId,
    lines: [{
      accountId: randomUUID(),
      amount: "10.0000",
      subsidiaryId: counterSubId,
    }],
  });
});

test("intercompany balancing blends differing subsidiary FX rates", async () => {
  const legs = await balancingLegs([
    line(originSubId, "-125.0000", "-125.0000", "1"),
    line(counterSubId, "100.0000", "100.0000", "1"),
    line(counterSubId, "50.0000", "25.0000", "2"),
  ]);
  const counter = legs.find((leg) => leg.subsidiaryId === counterSubId)!;

  assert.equal(counter.fxRate, "1.2000000000");
  assert.equal(counter.amount, mulRate(counter.txnAmount, counter.fxRate));
  assert.equal(add("150.0000", counter.amount), "0.0000");
});

test("intercompany balancing keeps a positive aggregate FX rate for credit totals", async () => {
  const legs = await balancingLegs([
    line(originSubId, "125.0000", "125.0000", "1"),
    line(counterSubId, "-100.0000", "-100.0000", "1"),
    line(counterSubId, "-50.0000", "-25.0000", "2"),
  ]);
  const counter = legs.find((leg) => leg.subsidiaryId === counterSubId)!;

  assert.equal(counter.amount, "150.0000");
  assert.equal(counter.txnAmount, "125.0000");
  assert.equal(counter.fxRate, "1.2000000000");
  assert.equal(counter.amount, mulRate(counter.txnAmount, counter.fxRate));
});

test("intercompany balancing refuses a non-zero functional residual with zero transaction total", async () => {
  await assert.rejects(
    balancingLegs([
      line(originSubId, "100.0000", "100.0000", "1"),
      line(counterSubId, "100.0000", "100.0000", "1"),
      line(counterSubId, "-200.0000", "-100.0000", "2"),
    ]),
    (error: unknown) =>
      error instanceof SubsidiaryError &&
      /zero transaction-currency total/.test(error.message),
  );
});

test("intercompany balancing derives a rate from rounded mixed-FX totals", async () => {
  const firstAmount = mulRate("0.0300", "1.3333333333");
  const secondAmount = mulRate("0.0200", "0.6666666667");
  const legs = await balancingLegs([
    line(originSubId, "-0.0533", "-0.0500", "1"),
    line(counterSubId, firstAmount, "0.0300", "1.3333333333"),
    line(counterSubId, secondAmount, "0.0200", "0.6666666667"),
  ]);
  const counter = legs.find((leg) => leg.subsidiaryId === counterSubId)!;

  assert.equal(counter.amount, "-0.0533");
  assert.equal(counter.amount, mulRate(counter.txnAmount, counter.fxRate));
  assert.equal(add("0.0533", counter.amount), "0.0000");
});

test("FX residual folds onto the largest eligible line regardless of position", () => {
  // Transaction amounts balance (100 - 40 - 60) but independent per-line
  // translation leaves a 0.0001 functional residual. The bucket is chosen by
  // role (largest magnitude), never by position: here the largest line is
  // last, and the first two lines must be byte-identical afterwards.
  const lines = [
    { ...line(originSubId, "-54.0494", "-40.0000", "1.3512350000"), taxCodeId: null, isOpenItem: false },
    { ...line(originSubId, "-81.0741", "-60.0000", "1.3512350000"), taxCodeId: null, isOpenItem: false },
    { ...line(originSubId, "135.1236", "100.0000", "1.3512360000"), taxCodeId: null, isOpenItem: false },
  ];
  absorbFxRoundingResidual(lines);
  assert.equal(lines[0]!.amount, "-54.0494");
  assert.equal(lines[1]!.amount, "-81.0741");
  assert.equal(lines[2]!.amount, "135.1235");
  assert.equal(add(add(lines[0]!.amount, lines[1]!.amount), lines[2]!.amount), "0.0000");
  // The adjustment touches functional amounts only — transaction evidence is kept.
  assert.deepEqual(lines.map((l) => l.txnAmount), ["-40.0000", "-60.0000", "100.0000"]);
});

test("FX residual never lands on a tax control or open-item leg", () => {
  // The statutory tax leg carries the largest magnitude, yet the residual
  // must skip it (filed returns sum these lines directly) and the open-item
  // leg (the subledger settles at that amount), landing on the small plain
  // line instead.
  const lines = [
    { ...line(originSubId, "135.1235", "100.0000", "1.3512350000"), taxCodeId: randomUUID(), isOpenItem: false },
    { ...line(originSubId, "-81.0741", "-60.0000", "1.3512350000"), taxCodeId: null, isOpenItem: true },
    { ...line(originSubId, "-54.0493", "-40.0000", "1.3512325000"), taxCodeId: null, isOpenItem: false },
  ];
  absorbFxRoundingResidual(lines);
  assert.equal(lines[0]!.amount, "135.1235");
  assert.equal(lines[1]!.amount, "-81.0741");
  assert.equal(lines[2]!.amount, "-54.0494");
  assert.equal(add(add(lines[0]!.amount, lines[1]!.amount), lines[2]!.amount), "0.0000");
});

test("FX residual beyond per-line rounding is refused, not flattened", () => {
  // Two lines can carry at most half a unit of translation error each: a
  // 0.0002 residual on two lines cannot be rounding and must fail loudly
  // instead of being absorbed into the ledger.
  const lines = [
    { ...line(originSubId, "10.0001", "10.0000", "1"), taxCodeId: null, isOpenItem: false },
    { ...line(originSubId, "-9.9999", "-10.0000", "1"), taxCodeId: null, isOpenItem: false },
  ];
  assert.throws(
    () => absorbFxRoundingResidual(lines),
    (error: unknown) =>
      error instanceof SubsidiaryError && /exceeds per-line FX rounding/.test(error.message),
  );
  assert.deepEqual(lines.map((l) => l.amount), ["10.0001", "-9.9999"]);
});

test("FX residual with only control legs to take it is refused", () => {
  // A transaction-balanced group whose every line is a tax control or
  // open-item leg has no lawful bucket: absorbing would rewrite either a
  // statutory charge or a subledger settlement amount.
  const lines = [
    { ...line(originSubId, "10.0001", "10.0000", "1"), taxCodeId: randomUUID(), isOpenItem: false },
    { ...line(originSubId, "-10.0000", "-10.0000", "1"), taxCodeId: null, isOpenItem: true },
  ];
  assert.throws(
    () => absorbFxRoundingResidual(lines),
    (error: unknown) =>
      error instanceof SubsidiaryError && /no line that may absorb it/.test(error.message),
  );
});

test("FX absorber leaves transaction-imbalanced groups for the balancer", () => {
  // Transaction amounts summing to nonzero are real economics (handled by
  // intercompany legs or refused by the kernel), never rounding — even when
  // the functional side carries a small residual.
  const lines = [
    { ...line(originSubId, "10.0001", "10.0000", "1"), taxCodeId: null, isOpenItem: false },
    { ...line(originSubId, "-9.0000", "-9.0000", "1"), taxCodeId: null, isOpenItem: false },
  ];
  absorbFxRoundingResidual(lines);
  assert.deepEqual(lines.map((l) => l.amount), ["10.0001", "-9.0000"]);
});

test("FX absorber is a no-op on an already balanced group", () => {
  const lines = [
    { ...line(originSubId, "10.0000", "10.0000", "1"), taxCodeId: null, isOpenItem: false },
    { ...line(originSubId, "-10.0000", "-10.0000", "1"), taxCodeId: null, isOpenItem: false },
  ];
  absorbFxRoundingResidual(lines);
  assert.deepEqual(lines.map((l) => l.amount), ["10.0000", "-10.0000"]);
});
