import assert from "node:assert/strict";
import test from "node:test";
import { genericBalancingGroups, genericSegmentBalancingProvider } from "./generic-balancing.ts";
import type { BalancingContext, BalancingLineView } from "./balancing-hooks.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { PostingError } from "./posting-contracts.ts";

const line = (
  amount: string,
  extraDims: Record<string, unknown>,
  overrides: Partial<BalancingLineView> = {},
): BalancingLineView => ({
  accountId: "expense",
  amount,
  subsidiaryId: "entity",
  currency: "CAD",
  txnAmount: amount,
  fxRate: "1",
  extraDims,
  ...overrides,
});

test("generic balancing preserves simultaneous dimensions and exact fractional amounts", () => {
  const source = [
    line("12.0001", { fund: "a", purpose: "x" }, { departmentId: "north" }),
    line("-12.0001", { fund: "b", purpose: "y" }, { departmentId: "south" }),
  ];
  const groups = genericBalancingGroups(source);
  assert.equal(groups.length, 2);
  assert.equal(
    groups.reduce((total, group) => total + group.amount, 0n),
    0n,
  );
  for (const original of source) {
    const group = groups.find((value) => value.extraDims.fund === original.extraDims?.fund)!;
    assert.equal(group.departmentId, original.departmentId);
    assert.deepEqual(group.extraDims, original.extraDims);
  }
});

test("dimension key order and source line order do not change generic balancing output", () => {
  const first = [
    line("3.0000", { fund: "a", purpose: "x" }),
    line("2.0000", { purpose: "x", fund: "a" }),
    line("-5.0000", { fund: "b", purpose: "y" }),
  ];
  assert.deepEqual(genericBalancingGroups(first), genericBalancingGroups([...first].reverse()));
  assert.deepEqual(
    genericBalancingGroups([line("5", { fund: "a" }), line("-5", { fund: "a" })]),
    [],
  );
});

test("null assignments and subsidiary boundaries remain separate balancing obligations", () => {
  const groups = genericBalancingGroups([
    line("4", { fund: null }),
    line("-4", { fund: "a" }),
    line("1", { fund: null }, { subsidiaryId: "other" }),
    line("-1", { fund: "a" }, { subsidiaryId: "other" }),
  ]);
  assert.equal(groups.length, 4);
  assert.equal(groups.filter((group) => group.subsidiaryId === "other").length, 2);
  assert.equal(groups.filter((group) => Object.keys(group.extraDims).length === 0).length, 2);
});

const context: BalancingContext = {
  orgId: "org",
  postingDate: "2026-10-18",
  bookId: "book",
  sourceDocumentId: null,
  regeneration: false,
};

test("custom balancing defaults are used to detect imbalance and label clearing legs", async () => {
  const responses: unknown[][] = [
    [
      {
        key: "fund",
        storage_column: null,
        default_value_id: "default-fund",
        account_id: "clearing",
        priority: 1,
      },
    ],
    [
      {
        id: "book",
        code: "PRIMARY",
        name: "Primary",
        is_primary: true,
        replication_mode: "full",
        replication_from: null,
        currency_difference_account_id: null,
      },
    ],
    [{ id: "entity", name: "Entity", base_currency: "CAD" }],
    [{ id: "clearing" }],
    [{ id: "clearing" }],
  ];
  let calls = 0;
  const runner = {
    execute: async (_query: unknown, mode?: string) =>
      Promise.resolve({ rows: responses[calls++] ?? [] }).then(
        <T extends { rows: unknown }>(result: T) => (mode === "objects" ? result.rows : result),
      ),
  } as unknown as SqlExecutor;
  const legs = await genericSegmentBalancingProvider(runner, context, [
    line("5", { fund: "restricted-fund" }),
    line("-5", {}),
  ]);
  assert.equal(legs.length, 2);
  assert.deepEqual(legs.map((leg) => leg.extraDims.fund).sort(), [
    "default-fund",
    "restricted-fund",
  ]);
});

test("every unbalanced custom segment requires its own clearing policy", async () => {
  let calls = 0;
  const runner = {
    execute: async (_query: unknown, mode?: string) => {
      const inMode = <T extends { rows: unknown }>(result: T) =>
        mode === "objects" ? result.rows : result;
      calls += 1;
      return inMode({
        rows: [
          {
            key: "department",
            storage_column: "department_id",
            default_value_id: null,
            account_id: "clearing",
            priority: 1,
          },
          {
            key: "region",
            storage_column: null,
            default_value_id: null,
            account_id: null,
            priority: 2,
          },
        ],
      });
    },
  } as unknown as SqlExecutor;
  const failure = await genericSegmentBalancingProvider(runner, context, [
    line("5", { region: "north" }, { departmentId: "sales" }),
    line("-5", { region: "south" }, { departmentId: "support" }),
  ]).catch((error: unknown) => error);
  assert.ok(failure instanceof PostingError);
  assert.match(failure.message, /Balancing segment region has no clearing policy/);
  assert.equal(calls, 1);
});
