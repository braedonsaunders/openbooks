import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

interface SqlQuery {
  text: string;
  values: unknown[];
}

interface VendorFixture {
  partyId: string;
  postingDate: string;
  status: "posted" | "draft";
}

interface VendorDataTestState {
  bills: VendorFixture[];
  queries: SqlQuery[];
}

const stateKey = Symbol.for("openbooks.vendor-data-period-test");
const state: VendorDataTestState = { bills: [], queries: [] };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mockSources = new Map<string, string>([
  [
    "mock:drizzle-orm",
    `
      export function sql(strings, ...values) {
        return { text: strings.join('?'), values }
      }
    `,
  ],
  [
    "mock:business-date",
    `
      export async function businessToday() {
        return '2024-03-31'
      }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.vendor-data-period-test')]

      function billRows(query) {
        const values = query.values
        const from = query.text.includes('posting_date >= ?') ? values[1] : null
        const ref = values[2] ?? values[1]
        const selected = state.bills.filter((bill) =>
          bill.status === 'posted' &&
          (from === null || bill.postingDate >= from) &&
          bill.postingDate <= ref,
        )
        const byParty = new Map()
        for (const bill of selected) {
          const row = byParty.get(bill.partyId) ?? { id: bill.partyId, bills: 0, last_bill: null }
          row.bills += 1
          if (row.last_bill === null || bill.postingDate > row.last_bill) row.last_bill = bill.postingDate
          byParty.set(bill.partyId, row)
        }
        return [...byParty.values()]
      }

      export const db = {
        async execute(query) {
          state.queries.push(query)
          if (query.text.includes('from documents')) return { rows: billRows(query) }
          if (query.text.includes('from ew e')) {
            if (query.text.includes('to_char(e.posting_date')) return { rows: [] }
            return {
              rows: [
                { id: 'vendor-with-bills', name: 'Vendor With Bills', spend: '300', prior_spend: '0' },
                { id: 'vendor-without-bills', name: 'Vendor Without Bills', spend: '120', prior_spend: '0' },
              ],
            }
          }
          if (query.text.includes('from applications')) return { rows: [] }
          throw new Error('unexpected vendor data query: ' + query.text)
        },
      }
    `,
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,export {}", format: "module", shortCircuit: true };
    }
    const mockUrl = new Map([
      ["drizzle-orm", "mock:drizzle-orm"],
      ["@openbooks/engine/src/business-date.ts", "mock:business-date"],
      ["@openbooks/engine/src/db.ts", "mock:db"],
    ]).get(specifier);
    if (mockUrl) return { url: mockUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { vendorData } = await import("./vendor-data.ts") as typeof import("./vendor-data.ts");
hooks.deregister();

test("vendor performance counts only bills inside the selected period", async () => {
  state.bills = [
    { partyId: "vendor-with-bills", postingDate: "2023-12-31", status: "posted" },
    { partyId: "vendor-with-bills", postingDate: "2024-01-15", status: "posted" },
    { partyId: "vendor-with-bills", postingDate: "2024-03-20", status: "posted" },
    { partyId: "vendor-with-bills", postingDate: "2024-04-01", status: "posted" },
    { partyId: "vendor-with-bills", postingDate: "2024-02-01", status: "draft" },
  ];
  state.queries = [];

  const result = await vendorData(
    { from: "2024-01-01", to: "2024-03-31", label: "Q1 2024" },
    "org-1",
  );

  const withBills = result.rows.find((row) => row.id === "vendor-with-bills");
  const withoutBills = result.rows.find((row) => row.id === "vendor-without-bills");
  assert.ok(withBills);
  assert.ok(withoutBills);
  assert.equal(withBills.bills, 2);
  assert.equal(withBills.avgBill, 150);
  assert.equal(withBills.lastBill, "2024-03-20");
  assert.equal(withoutBills.bills, 0);
  assert.equal(withoutBills.avgBill, 0);
  assert.equal(withoutBills.lastBill, null);
  assert.equal(result.totals.bills, 2);
  assert.equal(result.totals.avgBill, 210);

  const billQuery = state.queries.find((query) => query.text.includes("from documents"));
  assert.ok(billQuery);
  assert.match(billQuery.text, /posting_date >= \?/);
  assert.match(billQuery.text, /posting_date <= \?/);
});
