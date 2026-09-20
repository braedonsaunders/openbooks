import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sum } from "../money/money.ts";
import { db } from "../platform/db.ts";
import {
  resolveDeferralAccounts,
  resolveExpenseReceivableDeps,
  resolveOpenItemAccounts,
  resolveOrgTaxAccounts,
  resolveTaxAccounts,
  resolveTaxComponents,
  validateRequiredDimensions,
} from "./posting-accounts.ts";
import {
  PostingError,
  type Doc,
  type KernelLine,
  type PostingDeps,
} from "./posting-contracts.ts";

type Runner = Pick<typeof db, "execute">;

/** Real Drizzle SQL builder: the double inspects the statement the code
 * actually emitted (org scoping, control-account fragments, union legs)
 * instead of trusting call order alone. */
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
 * skipped. Money, mapping, and refusal logic stay real. */
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

const deps = (): PostingDeps => ({
  control: { ar: "ar-1", ap: "ap-1", bank: "bank-1" },
});

const expenseDoc = (over: Record<string, unknown> = {}): Doc =>
  ({ id: "doc-1", orgId: "org-1", kind: "expense_report", ...over }) as unknown as Doc;

const featureStep = (enabled: boolean, orgId: string): ScriptStep => ({
  sql: /revenueRecognition/,
  rows: [{ enabled }],
  check: ({ params }) =>
    assert.ok(params.includes(orgId), "feature check is scoped to the org"),
});

test("deferral resolution stays off the database when revenue recognition is disabled", async () => {
  const s = scripted([featureStep(false, "org-1")]);
  assert.deepEqual(await resolveDeferralAccounts(s.runner, "doc-1", "org-1"), new Map());
  // Exactly one read: the feature gate. Draining proves the deferral select
  // never issued, so disabled orgs pay no query and need no configuration.
  s.assertDrained();
});

test("deferral resolution maps each rev-rec line to its deferred account", async () => {
  const s = scripted([
    featureStep(true, "org-1"),
    {
      sql: /deferred_account_id/,
      rows: [
        { line_id: "line-1", deferred_account_id: "deferred-1" },
        { line_id: "line-2", deferred_account_id: "deferred-2" },
      ],
      check: ({ params }) => {
        assert.ok(params.includes("doc-1"), "deferral read is scoped to the document");
        assert.ok(params.includes("org-1"), "deferral read is scoped to the org");
      },
    },
  ]);
  const map = await resolveDeferralAccounts(s.runner, "doc-1", "org-1");
  assert.equal(map.get("line-1"), "deferred-1");
  assert.equal(map.get("line-2"), "deferred-2");
  assert.equal(map.size, 2);
  s.assertDrained();
});

test("deferral resolution returns an empty map when no rev-rec lines exist", async () => {
  const s = scripted([featureStep(true, "org-1"), { sql: /deferred_account_id/, rows: [] }]);
  assert.deepEqual(await resolveDeferralAccounts(s.runner, "doc-1", "org-1"), new Map());
  s.assertDrained();
});

test("tax-code control accounts map only when configured, never as null", async () => {
  const s = scripted([
    {
      sql: /from tax_codes/,
      rows: [
        { id: "T1", collected_account_id: "collect-1", paid_account_id: "paid-1" },
        { id: "T2", collected_account_id: null, paid_account_id: "paid-2" },
        { id: "T3", collected_account_id: null, paid_account_id: null },
      ],
      check: ({ params }) =>
        assert.ok(params.includes("org-1"), "tax-code read is scoped to the org"),
    },
  ]);
  const { collected, paid } = await resolveTaxAccounts(s.runner, "org-1");
  assert.deepEqual([...collected], [["T1", "collect-1"]]);
  assert.deepEqual([...paid], [["T1", "paid-1"], ["T2", "paid-2"]]);
  s.assertDrained();
});

test("tax-code control accounts are empty when no code configures one", async () => {
  const s = scripted([{ sql: /from tax_codes/, rows: [] }]);
  const { collected, paid } = await resolveTaxAccounts(s.runner, "org-1");
  assert.equal(collected.size, 0);
  assert.equal(paid.size, 0);
  s.assertDrained();
});

test("non-expense documents and preset deps never touch the database", async () => {
  const journal = expenseDoc({ kind: "journal" });
  const untouched = scripted([]);
  const out = await resolveExpenseReceivableDeps(untouched.runner, journal, deps());
  assert.ok(out.control.employeeReceivable === undefined);
  untouched.assertDrained();

  const preset = deps();
  preset.control.employeeReceivable = randomUUID();
  const presetRunner = scripted([]);
  const kept = await resolveExpenseReceivableDeps(presetRunner.runner, expenseDoc(), preset);
  assert.ok(kept === preset, "explicit caller values still win without a read");
  assert.equal(kept.control.employeeReceivable, preset.control.employeeReceivable);
  presetRunner.assertDrained();
});

test("an expense report without personal lines keeps its deps with one probe read", async () => {
  const s = scripted([
    {
      sql: /settlement_type/,
      rows: [],
      check: ({ sql, params }) => {
        assert.match(sql, /personal/, "probe looks for personal settlement lines");
        assert.ok(params.includes("org-1") && params.includes("doc-1"));
      },
    },
  ]);
  const base = deps();
  const out = await resolveExpenseReceivableDeps(s.runner, expenseDoc(), base);
  assert.ok(out === base, "no personal lines means the deps object passes through");
  assert.ok(out.control.employeeReceivable === undefined);
  // Draining with one step proves the control-account lookup never issued.
  s.assertDrained();
});

test("a personal line without a configured control posts with no receivable", async () => {
  const s = scripted([
    { sql: /settlement_type/, rows: [{ one: 1 }] },
    { sql: /employeeReceivable/, rows: [{ raw: null, id: null, type: null, isActive: null, isSummary: null }] },
  ]);
  const out = await resolveExpenseReceivableDeps(s.runner, expenseDoc(), deps());
  assert.ok(out.control.employeeReceivable === undefined);
  s.assertDrained();
});

test("a personal line resolves the configured receivable control", async () => {
  for (const type of ["asset_receivable", "asset_current_other"]) {
    const controlId = randomUUID();
    const s = scripted([
      { sql: /settlement_type/, rows: [{ one: 1 }] },
      {
        sql: /employeeReceivable/,
        rows: [{ raw: controlId, id: controlId, type, isActive: true, isSummary: false }],
      },
    ]);
    const out = await resolveExpenseReceivableDeps(s.runner, expenseDoc(), deps());
    assert.equal(out.control.employeeReceivable, controlId, `type ${type} is accepted`);
    s.assertDrained();
  }
});

test("a missing, inactive, summary, mistyped, or malformed control is refused by name", async () => {
  const controlId = randomUUID();
  const cases: { name: string; row: Record<string, unknown>; match: RegExp }[] = [
    {
      name: "missing",
      row: { raw: controlId, id: null, type: null, isActive: null, isSummary: null },
      match: /does not exist in this organization/,
    },
    {
      name: "malformed",
      // A stored id that fails the UUID shape gate joins to nothing, so the
      // boundary refuses by name instead of escaping as a raw 22P02 cast error.
      row: { raw: "not-a-uuid", id: null, type: null, isActive: null, isSummary: null },
      match: /does not exist in this organization/,
    },
    {
      name: "inactive",
      row: { raw: controlId, id: controlId, type: "asset_receivable", isActive: false, isSummary: false },
      match: /is inactive/,
    },
    {
      name: "summary",
      row: { raw: controlId, id: controlId, type: "asset_receivable", isActive: true, isSummary: true },
      match: /is a summary account/,
    },
    {
      name: "mistyped",
      row: { raw: controlId, id: controlId, type: "liability_payable", isActive: true, isSummary: false },
      match: /is incompatible; expected asset_receivable, asset_current_other/,
    },
  ];
  for (const { name, row, match } of cases) {
    const s = scripted([
      { sql: /settlement_type/, rows: [{ one: 1 }] },
      { sql: /employeeReceivable/, rows: [row] },
    ]);
    await assert.rejects(
      () => resolveExpenseReceivableDeps(s.runner, expenseDoc(), deps()),
      (e: unknown) => e instanceof PostingError && match.test(e.message),
      `${name} control must fail closed`,
    );
    s.assertDrained();
  }
});

test("org tax fallbacks pass through, and a missing row stays undefined", async () => {
  const present = scripted([
    { sql: /controlAccounts/, rows: [{ tax_collected: "collect-1", tax_paid: "paid-1" }] },
  ]);
  assert.deepEqual(await resolveOrgTaxAccounts(present.runner, "org-1"), {
    taxCollected: "collect-1",
    taxPaid: "paid-1",
  });
  present.assertDrained();

  const nulled = scripted([
    { sql: /controlAccounts/, rows: [{ tax_collected: null, tax_paid: null }] },
  ]);
  assert.deepEqual(await resolveOrgTaxAccounts(nulled.runner, "org-1"), {
    taxCollected: undefined,
    taxPaid: undefined,
  });
  nulled.assertDrained();

  const missing = scripted([{ sql: /controlAccounts/, rows: [] }]);
  assert.deepEqual(await resolveOrgTaxAccounts(missing.runner, "org-1"), {
    taxCollected: undefined,
    taxPaid: undefined,
  });
  missing.assertDrained();
});

test("tax components group by line in sequence and keep the stored recovery ratio", async () => {
  const row = (over: Record<string, unknown>) => ({
    document_line_id: "line-1",
    tax_code_id: "GST",
    sequence: 1,
    rate_percent: "5",
    taxable_amount: "100.0000",
    tax_amount: "5.0000",
    recoverable_amount: "5.0000",
    nonrecoverable_amount: "0.0000",
    calculation_type: "standard",
    price_includes_tax: false,
    compound_on_previous: false,
    rounding_scale: 2,
    collected_account_id: null,
    paid_account_id: null,
    withholding_account_id: null,
    recoverable_percent: "100.0000",
    ...over,
  });
  const s = scripted([
    {
      sql: /document_line_tax_components/,
      rows: [
        row({ sequence: 1, tax_amount: "5.0000" }),
        row({ sequence: 2, tax_code_id: "PST", tax_amount: "7.0000", recoverable_percent: "50.0000" }),
        row({ document_line_id: "line-2", sequence: 1, tax_amount: "13.0000", recoverable_percent: null }),
      ],
    },
  ]);
  const byLine = await resolveTaxComponents(s.runner, "doc-1", "org-1");
  const first = byLine.get("line-1");
  assert.ok(first);
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((c) => c.sequence), [1, 2]);
  // Real ledger math: the grouped components still cross-foot to 12.0000.
  assert.equal(
    sum(first.map((c) => c.taxAmount)),
    "12.0000",
  );
  assert.equal(first[1]?.recoverablePercent, "50.0000");
  const second = byLine.get("line-2");
  assert.ok(second);
  assert.equal(second.length, 1);
  assert.ok(second[0]?.recoverablePercent === undefined, "a null ratio stays undefined");
  s.assertDrained();
});

test("tax components are empty when the document carries no calculated tax", async () => {
  const s = scripted([{ sql: /document_line_tax_components/, rows: [] }]);
  assert.deepEqual(await resolveTaxComponents(s.runner, "doc-1", "org-1"), new Map());
  s.assertDrained();
});

test("a missing required dimension names the segment and the account", async () => {
  const rows = [
    {
      id: "acct-1",
      number: "6000",
      name: "Travel",
      required_dimensions: ["department"],
      segment_names: { department: "Department" },
    },
  ];
  const missing: KernelLine[] = [{ accountId: "acct-1", amount: "10.0000" }];
  await assert.rejects(
    () => validateRequiredDimensions(scripted([{ sql: /required_dimensions/, rows }]).runner, "org-1", missing),
    (e: unknown) =>
      e instanceof PostingError && /Department is required for account 6000 · Travel/.test(e.message),
  );
  const ok = scripted([{ sql: /required_dimensions/, rows }]);
  await validateRequiredDimensions(ok.runner, "org-1", [
    { accountId: "acct-1", amount: "10.0000", departmentId: "dept-1" },
  ]);
  ok.assertDrained();
});

test("custom segments refuse by key while unknown accounts pass through", async () => {
  const rows = [
    {
      id: "acct-9",
      number: null,
      name: "Misc",
      required_dimensions: ["region"],
      segment_names: {},
    },
  ];
  await assert.rejects(
    () =>
      validateRequiredDimensions(scripted([{ sql: /required_dimensions/, rows }]).runner, "org-1", [
        { accountId: "acct-9", amount: "10.0000" },
      ]),
    (e: unknown) => e instanceof PostingError && /region is required for account Misc/.test(e.message),
  );
  const custom = scripted([{ sql: /required_dimensions/, rows }]);
  // Real ledger math on the fixture: the passing pair still balances exactly.
  assert.equal(sum(["25.0000", "-25.0000"]), "0.0000");
  await validateRequiredDimensions(custom.runner, "org-1", [
    { accountId: "acct-9", amount: "25.0000", extraDims: { region: "emea" } },
    { accountId: "acct-unknown", amount: "-25.0000" },
  ]);
  custom.assertDrained();
});

test("open-item accounts union receivable, payable, and both employee controls", async () => {
  const s = scripted([
    {
      sql: /employeePayable/,
      rows: [{ id: "ar-1" }, { id: "ap-1" }, { id: "emp-payable" }],
      check: ({ sql }) =>
        assert.match(sql, /employeeReceivable/, "receivable control joins the same union"),
    },
  ]);
  const open = await resolveOpenItemAccounts(s.runner, "org-1");
  assert.deepEqual([...open].sort(), ["ap-1", "ar-1", "emp-payable"]);
  s.assertDrained();

  const empty = scripted([{ sql: /employeePayable/, rows: [] }]);
  assert.equal((await resolveOpenItemAccounts(empty.runner, "org-1")).size, 0);
  empty.assertDrained();
});
