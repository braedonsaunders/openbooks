import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { isZero, mulRate, sum } from "../money/money.ts";
import { db } from "../platform/db.ts";
import { SubsidiaryError } from "../organization/subsidiaries.ts";
import { assertAccountCurrencyRestrictions, applySubsidiaries } from "./posting-subsidiaries.ts";
import { PostingError, type Doc, type KernelLine } from "../journal/posting-contracts.ts";

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
    execute: async (query: Parameters<typeof db.execute>[0], mode?: string) => {
      const inMode = <T extends { rows: unknown }>(result: T) =>
        mode === "objects" ? result.rows : result;
      const built = dialect.sqlToQuery(query);
      const step = steps[index];
      index += 1;
      assert.ok(step, `unexpected database read #${index}: ${built.sql}`);
      calls.push(built.sql);
      assert.match(built.sql, step.sql, `read #${index} hit the expected statement`);
      step.check?.({ sql: built.sql, params: built.params });
      return inMode({ rows: step.rows });
    },
  } as unknown as Runner;
  return {
    runner,
    calls,
    assertDrained: () =>
      assert.equal(index, steps.length, `expected ${steps.length} database reads, saw ${index}`),
  };
};

type SubsidiaryFixture = {
  id: string;
  parentId: string | null;
  name: string;
  baseCurrency: string;
  isElimination: boolean;
  isActive: boolean;
};

const subRow = (over: Partial<SubsidiaryFixture> = {}): SubsidiaryFixture => ({
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

/** The entity's posting rate type: the entity read and its preference
 * versions (none here, so the spot rate type applies). */
const postingPreferenceSteps = (subsidiaryId: string): ScriptStep[] => [
  { sql: /from subsidiaries/, rows: [{ id: subsidiaryId }] },
  { sql: /from subsidiary_accounting_preferences/, rows: [] },
];

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
    () =>
      assertAccountCurrencyRestrictions(unnumbered.runner, "org-1", [
        { accountId, currency: "USD" },
      ]),
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
    { accountId: a1, amount: "100.0000" as KernelLine["amount"] },
    { accountId: a2, amount: "-100.0000" as KernelLine["amount"] },
  ];
  const out = await applySubsidiaries(s.runner, docOf({ subsidiaryId: null }), lines, {
    bookId: null,
    regeneration: false,
  });
  assert.equal(out.docSubId, root.id, "a missing header subsidiary defaults to the root");
  assert.equal(out.multi, false);
  assert.equal(out.originBaseCurrency, "USD");
  assert.equal(out.originFxRate, "1");
  assert.equal(out.lines.length, 2);
  const [first, second] = out.lines;
  assert.ok(first);
  assert.ok(second);
  for (const [stamped, original] of [
    [first, "100.0000"],
    [second, "-100.0000"],
  ] as const) {
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
      { accountId: randomUUID(), amount: "100.0000" as KernelLine["amount"] },
      { accountId: randomUUID(), amount: "-100.0000" as KernelLine["amount"] },
    ],
    { bookId: null, regeneration: false },
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
    ...postingPreferenceSteps(root.id),
    {
      sql: /from fx_rates/,
      // The shared spot lookup reads an evidence row (stored/derived rates
      // plus identity), not a bare rate column.
      rows: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          as_of: "2026-09-15",
          source: "unit",
          stored_rate: spot,
          updated_at: "2026-09-15T00:00:00.000000Z",
          priority: 0,
          derived_rate: spot,
        },
      ],
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
      { accountId: randomUUID(), amount: "100.0000" as KernelLine["amount"] },
      { accountId: randomUUID(), amount: "-100.0000" as KernelLine["amount"] },
    ],
    { bookId: null, regeneration: false },
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

const recordedRate = (over: Record<string, unknown> = {}) => ({
  version: 1,
  rate: "1.35",
  source: "Bank confirmation",
  reason: "Contracted conversion for this shipment",
  fromCurrency: "USD",
  toCurrency: "CAD",
  rateDate: "2026-09-15",
  subsidiaryId: "",
  ...over,
});

// Internally composed documents may omit the evidence, like journal metadata.
const evidenceIsOptional: undefined extends Doc["documentFxRateEvidence"] ? true : never = true;

test("absent or null rate evidence is no explicit election: the header rate still prices the origin", async () => {
  assert.equal(evidenceIsOptional, true);
  const root = subRow({ baseCurrency: "CAD" });
  for (const evidence of [{}, { documentFxRateEvidence: null }]) {
    const s = scripted([subsidiariesStep([root], "org-1"), restrictionStep(), currencyStep()]);
    const out = await applySubsidiaries(
      s.runner,
      docOf({ kind: "vendor_bill", currency: "USD", fxRate: "1.3600000000", ...evidence }),
      [
        { accountId: randomUUID(), amount: "100.0000" as KernelLine["amount"] },
        { accountId: randomUUID(), amount: "-100.0000" as KernelLine["amount"] },
      ],
      { bookId: null, regeneration: false },
    );
    assert.equal(out.originFxRate, "1.3600000000");
    s.assertDrained();
  }
});

test("recorded rate evidence prices the origin legs without a rate read, even at exactly 1", async () => {
  // A pegged conversion recorded at 1 is evidence, not the unset default:
  // the document is measured at it rather than at a looked-up rate.
  const root = subRow({ baseCurrency: "CAD" });
  const s = scripted([subsidiariesStep([root], "org-1"), restrictionStep(), currencyStep()]);
  const out = await applySubsidiaries(
    s.runner,
    docOf({
      kind: "vendor_bill",
      subsidiaryId: root.id,
      currency: "USD",
      fxRate: "1.0000000000",
      documentFxRateEvidence: recordedRate({ rate: "1", subsidiaryId: root.id }),
    }),
    [
      { accountId: randomUUID(), amount: "100.0000" as KernelLine["amount"] },
      { accountId: randomUUID(), amount: "-100.0000" as KernelLine["amount"] },
    ],
    { bookId: null, regeneration: false },
  );
  assert.equal(out.originFxRate, "1");
  for (const stamped of out.lines) assert.equal(stamped.fxRate, "1");
  assert.ok(!s.calls.some((sql) => sql.includes("fx_rates")), "recorded evidence reads no rates");
  s.assertDrained();
});

test("recorded rate evidence never prices another entity on the same functional currency", async () => {
  const root = subRow({ name: "Root", baseCurrency: "CAD" });
  const child = subRow({ name: "Child", baseCurrency: "CAD" });
  (child as { parentId: string | null }).parentId = root.id;
  const spot = "1.3000000000";
  const s = scripted([
    subsidiariesStep([root, child], "org-1"),
    ...postingPreferenceSteps(child.id),
    {
      sql: /from fx_rates/,
      rows: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          as_of: "2026-09-15",
          source: "unit",
          stored_rate: spot,
          updated_at: "2026-09-15T00:00:00.000000Z",
          priority: 0,
          derived_rate: spot,
        },
      ],
    },
    {
      sql: /from intercompany_pairs/,
      rows: [{ fromId: root.id, toId: child.id, dueFrom: randomUUID(), dueTo: randomUUID() }],
    },
    restrictionStep(),
    currencyStep(),
  ]);
  const out = await applySubsidiaries(
    s.runner,
    docOf({
      kind: "vendor_bill",
      subsidiaryId: root.id,
      currency: "USD",
      fxRate: "1.3500000000",
      documentFxRateEvidence: recordedRate({ subsidiaryId: root.id }),
    }),
    [
      { accountId: randomUUID(), amount: "100.0000" as KernelLine["amount"] },
      {
        accountId: randomUUID(),
        amount: "-100.0000" as KernelLine["amount"],
        subsidiaryId: child.id,
      },
    ],
    { bookId: null, regeneration: false },
  );
  assert.equal(out.originFxRate, "1.35");
  assert.equal(out.lines[0]?.fxRate, "1.35", "the owning entity is measured at the recorded rate");
  assert.equal(out.lines[1]?.fxRate, spot, "the other entity is measured at the exchange rates");
  s.assertDrained();
});

test("recorded rate evidence for another posting date refuses before any rate is read", async () => {
  const root = subRow({ baseCurrency: "CAD" });
  const s = scripted([subsidiariesStep([root], "org-1")]);
  await assert.rejects(
    () =>
      applySubsidiaries(
        s.runner,
        docOf({
          kind: "vendor_bill",
          subsidiaryId: root.id,
          currency: "USD",
          fxRate: "1.3500000000",
          documentFxRateEvidence: recordedRate({ subsidiaryId: root.id, rateDate: "2026-09-14" }),
        }),
        [{ accountId: randomUUID(), amount: "100.0000" as KernelLine["amount"] }],
        { bookId: null, regeneration: false },
      ),
    (e: unknown) =>
      e instanceof PostingError && /no longer matches this document's posting date/.test(e.message),
  );
  s.assertDrained();
});

test("a missing spot rate names the pair and the date as a posting refusal", async () => {
  const root = subRow({ baseCurrency: "USD" });
  const s = scripted([
    subsidiariesStep([root], "org-1"),
    ...postingPreferenceSteps(root.id),
    { sql: /from fx_rates/, rows: [] },
  ]);
  await assert.rejects(
    () =>
      applySubsidiaries(
        s.runner,
        docOf({ currency: "EUR", fxRate: "1.0000000000" }),
        [
          { accountId: randomUUID(), amount: "100.0000" as KernelLine["amount"] },
          { accountId: randomUUID(), amount: "-100.0000" as KernelLine["amount"] },
        ],
        { bookId: null, regeneration: false },
      ),
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
      applySubsidiaries(
        s.runner,
        docOf({ subsidiaryId: "missing-sub" }),
        [{ accountId: randomUUID(), amount: "10.0000" as KernelLine["amount"] }],
        { bookId: null, regeneration: false },
      ),
    (e: unknown) =>
      e instanceof PostingError && /subsidiary missing-sub does not exist/.test(e.message),
  );
  s.assertDrained();
});

test("a line stamped to an unknown subsidiary is refused", async () => {
  const root = subRow();
  const s = scripted([subsidiariesStep([root], "org-1")]);
  await assert.rejects(
    () =>
      applySubsidiaries(
        s.runner,
        docOf({ subsidiaryId: root.id }),
        [
          {
            accountId: randomUUID(),
            amount: "10.0000" as KernelLine["amount"],
            subsidiaryId: "ghost-sub",
          },
        ],
        { bookId: null, regeneration: false },
      ),
    (e: unknown) =>
      e instanceof PostingError && /subsidiary ghost-sub does not exist/.test(e.message),
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
      applySubsidiaries(
        s.runner,
        docOf({ subsidiaryId: root.id }),
        [
          { accountId: randomUUID(), amount: "100.0000" as KernelLine["amount"] },
          { accountId: randomUUID(), amount: "-100.0000" as KernelLine["amount"] },
          {
            accountId: randomUUID(),
            amount: "50.0000" as KernelLine["amount"],
            subsidiaryId: dormant.id,
          },
          {
            accountId: randomUUID(),
            amount: "-50.0000" as KernelLine["amount"],
            subsidiaryId: dormant.id,
          },
        ],
        { bookId: null, regeneration: false },
      ),
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
      applySubsidiaries(
        s.runner,
        docOf({ subsidiaryId: root.id }),
        [
          { accountId, amount: "100.0000" as KernelLine["amount"] },
          { accountId: randomUUID(), amount: "-100.0000" as KernelLine["amount"] },
        ],
        { bookId: null, regeneration: false },
      ),
    (e: unknown) =>
      e instanceof PostingError &&
      /2000 EUR-only only accepts EUR postings, not USD/.test(e.message),
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
  const out = await applySubsidiaries(
    s.runner,
    docOf({ subsidiaryId: rootId }),
    [
      { accountId: randomUUID(), amount: "100.0000" as KernelLine["amount"] },
      { accountId: randomUUID(), amount: "-40.0000" as KernelLine["amount"] },
      {
        accountId: randomUUID(),
        amount: "-100.0000" as KernelLine["amount"],
        subsidiaryId: childId,
      },
      { accountId: randomUUID(), amount: "40.0000" as KernelLine["amount"], subsidiaryId: childId },
    ],
    { bookId: null, regeneration: false },
  );
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
      applySubsidiaries(
        failing,
        docOf(),
        [{ accountId: randomUUID(), amount: "10.0000" as KernelLine["amount"] }],
        { bookId: null, regeneration: false },
      ),
    (e: unknown) => e instanceof TypeError && !(e instanceof PostingError),
  );
});
