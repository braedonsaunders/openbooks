import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db } from "./db.ts";
import { add, mulRate } from "./money.ts";
import {
  intercompanyBalancingLegs,
  SubsidiaryError,
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
