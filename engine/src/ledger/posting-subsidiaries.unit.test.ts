import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { isZero, mulRate, sum } from "../money/money.ts";
import { db } from "../platform/db.ts";
import { SubsidiaryError } from "../organization/subsidiaries.ts";
import {
  assertAccountCurrencyRestrictions,
  applySubsidiaries,
} from "./posting-subsidiaries.ts";
import { PostingError, type Doc, type KernelLine } from "./posting-contracts.ts";

type Runner = Pick<typeof db, "execute">;

/** Real Drizzle SQL builder: the double inspects the statement the code
 * actually emitted (subsidiary reads, fx pair/date params, the uuid-array
 * binding) instead of trusting call order alone. */
const dialect = (
  db as unknown as {
    dialect: {
      sqlToQuery(query: Parameters<typeof db.execute>[0]): {
        sql: string;
        params: unknown[];
      };
    };
  }
).dialect;

interface ScriptStep {
  /** Fragment of the generated SQL this read must hit. */
  sql: RegExp;
  rows: unknown[];
  check?: (built: { sql: string; params: unknown[] }) => void;
}

/** Strict scripted IO double: every read must match its scripted statement
 * in order, unexpected reads throw, and assertDrained proves no read was
 * skipped. FX math and refusal mapping stay real. */
const scripted = (
  steps: ScriptStep[],
): { runner: Runner; calls: string[]; assertDrained: () => void } => {
  let index = 0;
  const calls: string[] = [];
  const runner = {
    execute: async (query: Parameters<typeof db.execute>[0]) => {
      const built = dialect.sqlToQuery(query);
      const step = steps[index];
      index += 1;
      assert.ok(step, `unexpected database read #${index}: ${built.sql}`);
      calls.push(built.sql);
      assert.match(built.sql, step.sql, `read #${index} hit the expected statement`);
      step.check?.({ sql: built.sql, params: built.params });
      return { rows: step.rows };
    },
  } as unknown as Runner;
  return {
    runner,
    calls,
    assertDrained: () =>
      assert.equal(index, steps.length, `expected ${steps.length} database reads, saw ${index}`),
  };
};

const subRow = (over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  parentId: null,
  name: "Root",
  baseCurrency: "USD",
  isElimination: false,
  isActive: true,
  ...over,
});

const subsidiariesStep = (rows: unknown[], orgId: string): ScriptStep => ({
  sql: /from subsidiaries/,
  rows,
  check: ({ params }) =>
    assert.ok(params.includes(orgId), "subsidiary context is scoped to the org"),
});

const restrictionStep = (): ScriptStep => ({
  sql: /subsidiary_id as "subsidiaryId"/,
  rows: [],
});

const currencyStep = (rows: unknown[] = []): ScriptStep => ({
  sql: /currency_restriction as restriction/,
  rows,
});

const docOf = (over: Record<string, unknown> = {}): Doc =>
  ({
    id: "doc-1",
    orgId: "org-1",
    subsidiaryId: null,
    currency: "USD",
    fxRate: "1",
    postingDate: "2026-09-15",
    documentDate: "2026-09-15",
    partyId: null,
    ...over,
  }) as unknown as Doc;

test("currency restrictions need no query for an empty line set", async () => {
  const s = scripted([]);
  await assertAccountCurrencyRestrictions(s.runner, "org-1", []);
  s.assertDrained();
});

test("a matching restriction, an unrestricted account, and an unknown account all pass", async () => {
  const accountId = randomUUID();
  const rows = [{ id: accountId, number: "1010", name: "USD Bank", restriction: "USD" }];
  const s = scripted([{ sql: /currency_restriction as restriction/, rows }]);
  await assertAccountCurrencyRestrictions(s.runner, "org-1", [
    { accountId, currency: "USD" },
    // Unknown to the reader: no restriction row, so nothing to enforce.
    { accountId: randomUUID(), currency: "EUR" },
  ]);
  s.assertDrained();

  const open = scripted([
    {
      sql: /currency_restriction as restriction/,
      rows: [{ id: accountId, number: "1010", name: "USD Bank", restriction: null }],
    },
  ]);
  await assertAccountCurrencyRestrictions(open.runner, "org-1", [{ accountId, currency: "EUR" }]);
  open.assertDrained();
});

test("a currency mismatch names the account and both currencies, never an id", async () => {
  const accountId = randomUUID();
  const s = scripted([
    {
      sql: /currency_restriction as restriction/,
      rows: [{ id: accountId, number: "1010", name: "USD Bank", restriction: "USD" }],
    },
  ]);
  await assert.rejects(
    () => assertAccountCurrencyRestrictions(s.runner, "org-1", [{ accountId, currency: "EUR" }]),
    (e: unknown) =>
      e instanceof PostingError &&
      /1010 USD Bank only accepts USD postings, not EUR/.test(e.message),
  );
  s.assertDrained();

  const unnumbered = scripted([
    {
      sql: /currency_restriction as restriction/,
      rows: [{ id: accountId, number: null, name: "Euro Safe", restriction: "EUR" }],
    },
  ]);
  await assert.rejects(
    () => assertAccountCurrencyRestrictions(unnumbered.runner, "org-1", [{ accountId, currency: "USD" }]),
    (e: unknown) =>
      e instanceof PostingError && /Euro Safe only accepts EUR postings, not USD/.test(e.message),
  );
  unnumbered.assertDrained();
});

test("a same-currency single-entity document stamps subsidiaries with no fx reads", async () => {
  const root = subRow();
  const a1 = randomUUID();
  const a2 = randomUUID();
  const s = scripted([subsidiariesStep([root], "org-1"), restrictionStep(), currencyStep()]);
  // Real ledger math: the kernel fixture balances exactly before stamping.
  assert.equal(sum(["100.0000", "-100.0000"]), "0.0000");
  const lines: KernelLine[] = [
    { accountId: a1, amount: "100.0000" },
    { accountId: a2, amount: "-100.0000" },
  ];
  const out = await applySubsidiaries(s.runner, docOf({ subsidiaryId: null }), lines);
  assert.equal(out.docSubId, root.id, "a missing header subsidiary defaults to the root");
  assert.equal(out.multi, false);
  assert.equal(out.originBaseCurrency, "USD");
  assert.equal(out.originFxRate, "1");
  assert.equal(out.lines.length, 2);
  const [first, second] = out.lines;
  assert.ok(first);
  assert.ok(second);
  for (const [stamped, original] of [[first, "100.0000"], [second, "-100.0000"]] as const) {
    assert.equal(stamped.subsidiaryId, root.id);
    assert.equal(stamped.currency, "USD");
    assert.equal(stamped.fxRate, "1");
    assert.equal(stamped.txnAmount, original);
    // Real FX math prices the expectation: a 1:1 stamp preserves the amount.
    assert.equal(stamped.amount, mulRate(original, "1"));
  }
  assert.ok(!s.calls.some((sql) => sql.includes("fx_rates")), "same-currency legs read no rates");
  s.assertDrained();
});

test("an explicit header rate prices every origin leg without a spot read", async () => {
  const root = subRow({ baseCurrency: "CAD" });
  const headerRate = "1.3600000000";
  const s = scripted([subsidiariesStep([root], "org-1"), restrictionStep(), currencyStep()]);
  const out = await applySubsidiaries(
    s.runner,
    docOf({ currency: "USD", fxRate: headerRate }),
    [
      { accountId: randomUUID(), amount: "100.0000" },
      { accountId: randomUUID(), amount: "-100.0000" },
    ],
  );
  assert.equal(out.originBaseCurrency, "CAD");
  assert.equal(out.originFxRate, headerRate, "the caller-supplied rate is honoured");
  for (const stamped of out.lines) {
    assert.equal(stamped.fxRate, headerRate);
    assert.equal(stamped.currency, "USD");
  }
  assert.equal(out.lines[0]?.amount, mulRate("100.0000", headerRate));
  assert.equal(out.lines[1]?.amount, mulRate("-100.0000", headerRate));
  assert.ok(!s.calls.some((sql) => sql.includes("fx_rates")), "header-rate legs read no rates");
  s.assertDrained();
});

test("a default header rate is unset, so one spot read prices every line", async () => {
  const root = subRow({ baseCurrency: "USD" });
  const spot = "1.0842000000";
  const s = scripted([
    subsidiariesStep([root], "org-1"),
    {
      sql: /from fx_rates/,
      rows: [{ rate: spot }],
      check: ({ params }) => {
        assert.ok(params.includes("EUR") && params.includes("USD"), "the pair is named");
        assert.ok(params.includes("2026-09-15"), "the rate respects the posting date");
      },
    },
    restrictionStep(),
    currencyStep(),
  ]);
  const out = await applySubsidiaries(
    s.runner,
    // The schema default reads back as ten-decimal "1": on a foreign-currency
    // document that means unset, not a 1:1 peg, so the spot lookup must run.
    docOf({ currency: "EUR", fxRate: "1.0000000000" }),
    [
      { accountId: randomUUID(), amount: "100.0000" },
      { accountId: randomUUID(), amount: "-100.0000" },
    ],
  );
  assert.equal(out.originFxRate, spot);
  for (const stamped of out.lines) {
    assert.equal(stamped.fxRate, spot);
    assert.equal(stamped.currency, "EUR");
  }
  assert.equal(out.lines[0]?.amount, mulRate("100.0000", spot));
  assert.equal(
    s.calls.filter((sql) => sql.includes("fx_rates")).length,
    1,
    "the second line reuses the cached rate",
  );
  s.assertDrained();
});

test("a missing spot rate names the pair and the date as a posting refusal", async () => {
  const root = subRow({ baseCurrency: "USD" });
  const s = scripted([
    subsidiariesStep([root], "org-1"),
    { sql: /from fx_rates/, rows: [] },
  ]);
  await assert.rejects(
    () =>
      applySubsidiaries(s.runner, docOf({ currency: "EUR", fxRate: "1.0000000000" }), [
        { accountId: randomUUID(), amount: "100.0000" },
        { accountId: randomUUID(), amount: "-100.0000" },
      ]),
    (e: unknown) =>
      e instanceof PostingError &&
      !(e instanceof SubsidiaryError) &&
      /no spot rate for EUR→USD on or before 2026-09-15/.test(e.message),
  );
  s.assertDrained();
});

test("an unknown document subsidiary is refused before any rate is read", async () => {
  const root = subRow();
  const s = scripted([subsidiariesStep([root], "org-1")]);
  await assert.rejects(
    () =>
      applySubsidiaries(s.runner, docOf({ subsidiaryId: "missing-sub" }), [
        { accountId: randomUUID(), amount: "10.0000" },
      ]),
    (e: unknown) => e instanceof PostingError && /subsidiary missing-sub does not exist/.test(e.message),
  );
  s.assertDrained();
});

test("a line stamped to an unknown subsidiary is refused", async () => {
  const root = subRow();
  const s = scripted([subsidiariesStep([root], "org-1")]);
  await assert.rejects(
    () =>
      applySubsidiaries(s.runner, docOf({ subsidiaryId: root.id }), [
        { accountId: randomUUID(), amount: "10.0000", subsidiaryId: "ghost-sub" },
      ]),
    (e: unknown) => e instanceof PostingError && /subsidiary ghost-sub does not exist/.test(e.message),
  );
  s.assertDrained();
});

test("a line on an inactive subsidiary is refused", async () => {
  const root = subRow({ name: "Root" });
  const dormant = subRow({ name: "Dormant", baseCurrency: "USD", isActive: false });
  (dormant as { parentId: string | null }).parentId = root.id;
  const s = scripted([subsidiariesStep([root, dormant], "org-1")]);
  await assert.rejects(
    () =>
      applySubsidiaries(s.runner, docOf({ subsidiaryId: root.id }), [
        { accountId: randomUUID(), amount: "100.0000" },
        { accountId: randomUUID(), amount: "-100.0000" },
        { accountId: randomUUID(), amount: "50.0000", subsidiaryId: dormant.id },
        { accountId: randomUUID(), amount: "-50.0000", subsidiaryId: dormant.id },
      ]),
    (e: unknown) => e instanceof PostingError && /"Dormant" is inactive/.test(e.message),
  );
  // Both entity groups net to zero, so no intercompany read issues first:
  // draining with one step proves the refusal lands before any pair lookup.
  s.assertDrained();
});

test("a currency-restricted account is refused through subsidiary posting", async () => {
  const root = subRow();
  const accountId = randomUUID();
  const s = scripted([
    subsidiariesStep([root], "org-1"),
    restrictionStep(),
    currencyStep([{ id: accountId, number: "2000", name: "EUR-only", restriction: "EUR" }]),
  ]);
  await assert.rejects(
    () =>
      applySubsidiaries(s.runner, docOf({ subsidiaryId: root.id }), [
        { accountId, amount: "100.0000" },
        { accountId: randomUUID(), amount: "-100.0000" },
      ]),
    (e: unknown) =>
      e instanceof PostingError && /2000 EUR-only only accepts EUR postings, not USD/.test(e.message),
  );
  s.assertDrained();
});

test("a two-entity entry balances per subsidiary with intercompany legs", async () => {
  const rootId = randomUUID();
  const childId = randomUUID();
  const root = subRow({ id: rootId, name: "Root", baseCurrency: "USD" });
  const child = subRow({ id: childId, name: "Child", baseCurrency: "USD" });
  (child as { parentId: string | null }).parentId = rootId;
  const dueFrom = randomUUID();
  const dueTo = randomUUID();
  const s = scripted([
    subsidiariesStep([root, child], "org-1"),
    {
      sql: /from intercompany_pairs/,
      rows: [{ fromId: rootId, toId: childId, dueFrom, dueTo }],
      check: ({ sql, params }) => {
        assert.match(sql, /is_active/, "only active pairs balance an entry");
        assert.ok(params.includes(rootId), "the pair lookup names the origin");
        assert.ok(
          params.some((p) => typeof p === "string" && p.includes(childId)),
          "counter-subsidiaries bind as one uuid-array param",
        );
      },
    },
    restrictionStep(),
    currencyStep(),
  ]);
  const out = await applySubsidiaries(s.runner, docOf({ subsidiaryId: rootId }), [
    { accountId: randomUUID(), amount: "100.0000" },
    { accountId: randomUUID(), amount: "-40.0000" },
    { accountId: randomUUID(), amount: "-100.0000", subsidiaryId: childId },
    { accountId: randomUUID(), amount: "40.0000", subsidiaryId: childId },
  ]);
  assert.equal(out.multi, true);
  assert.equal(out.lines.length, 6, "four source lines plus two balancing legs");
  const childLines = out.lines.filter((l) => l.subsidiaryId === childId);
  const rootLines = out.lines.filter((l) => l.subsidiaryId === rootId);
  // Real ledger math: each legal entity's books balance on their own.
  assert.ok(isZero(sum(childLines.map((l) => l.amount))), "counter-subsidiary nets to zero");
  assert.ok(isZero(sum(rootLines.map((l) => l.amount))), "origin nets to zero");
  const childLeg = childLines.find((l) => l.memo?.includes("Intercompany"));
  const originLeg = rootLines.find((l) => l.memo?.includes("Intercompany"));
  assert.ok(childLeg);
  assert.ok(originLeg);
  assert.equal(childLeg.accountId, dueTo, "the counter books its own side of the pair");
  assert.equal(originLeg.accountId, dueFrom, "the origin mirrors on its side");
  s.assertDrained();
});

test("subsidiary refusals arrive as PostingError while foreign failures propagate", async () => {
  const failing = {
    execute: async () => {
      throw new TypeError("boom");
    },
  } as unknown as Runner;
  await assert.rejects(
    () =>
      applySubsidiaries(failing, docOf(), [{ accountId: randomUUID(), amount: "10.0000" }]),
    (e: unknown) => e instanceof TypeError && !(e instanceof PostingError),
  );
});
