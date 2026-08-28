import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

type FixtureAccount = {
  id: string;
  number: string;
  name: string;
  type: string;
  raw: string;
};

type LayoutFixture = {
  layout: {
    name: string;
    statement: "pnl" | "balance_sheet";
    rows: unknown[];
  };
  accounts: FixtureAccount[];
  calls: number;
};

const fixtureKey = Symbol.for("openbooks.layouts-test");
const fixture: LayoutFixture = {
  layout: { name: "", statement: "pnl", rows: [] },
  accounts: [],
  calls: 0,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[fixtureKey] =
  fixture;

const databaseMock = `
  const fixture = globalThis[Symbol.for("openbooks.layouts-test")]
  export const db = {
    async execute(query) {
      fixture.calls += 1
      if (fixture.calls === 1) return { rows: [fixture.layout] }
      const knownTypes = [
        "asset_bank", "asset_receivable", "asset_current_other", "asset_fixed", "asset_other",
        "liability_payable", "liability_card", "liability_current_other", "liability_long_term",
        "equity", "income", "income_other", "cogs", "expense", "expense_other", "expense_deferred",
      ]
      const types = knownTypes.filter((type) => query.text.includes(type))
      return { rows: fixture.accounts.filter((account) => types.includes(account.type)) }
    },
  }
`;

const drizzleMock = `
  const render = (value) => Array.isArray(value)
    ? value.join(",")
    : value && typeof value === "object" && Array.isArray(value.strings)
      ? value.strings.reduce((text, part, index) => text + part + (value.values[index] ?? ""), "")
      : String(value)
  export function sql(strings, ...values) {
    return { strings, values, text: strings.reduce((text, part, index) => text + part + (index < values.length ? render(values[index]) : ""), "") }
  }
`;

const orgScopeMock = `
  export async function resolveOrgId(orgId) {
    return orgId ?? "layouts-test-org"
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    if (specifier === "@openbooks/engine/src/db.ts") {
      return { shortCircuit: true, url: "mock:layouts-db" };
    }
    if (specifier === "drizzle-orm") {
      return { shortCircuit: true, url: "mock:layouts-drizzle" };
    }
    if (
      specifier === "./org-scope" &&
      context.parentURL?.includes("/web/lib/layouts.ts")
    ) {
      return { shortCircuit: true, url: "mock:layouts-org-scope" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:layouts-db") {
      return { format: "module", source: databaseMock, shortCircuit: true };
    }
    if (url === "mock:layouts-drizzle") {
      return { format: "module", source: drizzleMock, shortCircuit: true };
    }
    if (url === "mock:layouts-org-scope") {
      return { format: "module", source: orgScopeMock, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { renderLayout } = await import("./layouts.ts?layouts-test");
hooks.deregister();

function resetFixture(input: Pick<LayoutFixture, "layout" | "accounts">): void {
  fixture.layout = input.layout;
  fixture.accounts = input.accounts;
  fixture.calls = 0;
}

function account(
  id: string,
  number: string,
  name: string,
  type: string,
  raw: string,
): FixtureAccount {
  return { id, number, name, type, raw };
}

test("balance-sheet layouts include assets, liabilities, debt, and equity accounts", async () => {
  resetFixture({
    layout: {
      name: "Balance sheet",
      statement: "balance_sheet",
      rows: [
        {
          kind: "group",
          label: "Assets",
          match: { types: ["asset_bank", "asset_receivable"] },
        },
        {
          kind: "group",
          label: "Liabilities",
          match: { types: ["liability_payable", "liability_long_term"] },
        },
        { kind: "group", label: "Equity", match: { types: ["equity"] } },
      ],
    },
    accounts: [
      account("cash", "1000", "Cash", "asset_bank", "100.0000"),
      account(
        "receivable",
        "1100",
        "Receivables",
        "asset_receivable",
        "50.0000",
      ),
      account("payable", "2000", "Payables", "liability_payable", "-25.0000"),
      account(
        "debt",
        "2500",
        "Long-term debt",
        "liability_long_term",
        "-40.0000",
      ),
      account("equity", "3000", "Equity", "equity", "-85.0000"),
    ],
  });

  const rendered = await renderLayout(
    "balance-layout",
    "2026-01-01",
    "2026-01-31",
    undefined,
    "layouts-test-org",
  );
  assert.ok(rendered);
  assert.deepEqual(
    rendered.lines
      .filter((line) => line.kind === "account")
      .map((line) => line.label),
    ["Cash", "Receivables", "Payables", "Long-term debt", "Equity"],
  );
});

test("layout totals retain exact ledger decimals through groups and formulas", async () => {
  resetFixture({
    layout: {
      name: "Profit and loss",
      statement: "pnl",
      rows: [
        { kind: "group", label: "Revenue", match: { types: ["income"] } },
        {
          kind: "group",
          label: "Other revenue",
          match: { types: ["income_other"] },
        },
        {
          kind: "subtotal",
          label: "Combined revenue",
          of: ["Revenue", "Other revenue"],
        },
        {
          kind: "formula",
          label: "Net revenue",
          plus: ["Combined revenue"],
          minus: ["Revenue"],
        },
      ],
    },
    accounts: [
      account("revenue-a", "4000", "Revenue A", "income", "-0.1000"),
      account("revenue-b", "4010", "Revenue B", "income", "-0.2000"),
      account(
        "other-revenue",
        "4100",
        "Other revenue",
        "income_other",
        "-9007199254740993.1234",
      ),
    ],
  });

  const rendered = await renderLayout(
    "pnl-layout",
    "2026-01-01",
    "2026-01-31",
    undefined,
    "layouts-test-org",
  );
  assert.ok(rendered);
  assert.equal(
    rendered.lines.find((line) => line.label === "Total Revenue")?.amount,
    "0.3000",
  );
  assert.equal(
    rendered.lines.find((line) => line.label === "Total Other revenue")?.amount,
    "9007199254740993.1234",
  );
  assert.equal(
    rendered.lines.find((line) => line.label === "Combined revenue")?.amount,
    "9007199254740993.4234",
  );
  assert.equal(
    rendered.lines.find((line) => line.label === "Net revenue")?.amount,
    "9007199254740993.1234",
  );
});
