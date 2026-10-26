import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import type { NetSuitePaymentTerm } from "../connectors/netsuite-bridge.ts";
import {
  NetSuiteSource,
  netSuiteTermDateDrivenFields,
  normalizeNetSuitePaymentTerm,
} from "./netsuite-source.ts";

const creds = {
  account: "TEST",
  host: "https://test.example.invalid",
  consumerKey: "consumer",
  consumerSecret: "secret",
  tokenKey: "token",
  tokenSecret: "token-secret",
};

const standard = (fields: Partial<NetSuitePaymentTerm> = {}): NetSuitePaymentTerm => ({
  id: "1",
  name: "Net 30",
  netDays: 30,
  discountPercent: null,
  discountDays: null,
  ...fields,
});

test("standard NetSuite terms keep their net days and day-counted discount", () => {
  const term = standard({
    name: "2% 10 Net 30",
    discountPercent: "2.0",
    discountDays: 10,
    dateDriven: false,
  });
  assert.deepEqual(normalizeNetSuitePaymentTerm(term, term).fields, {
    name: "2% 10 Net 30",
    netDays: 30,
    dueDayOfMonth: null,
    discountDays: 10,
    discountPercent: "2.0",
  });
});

test("date-driven NetSuite terms become a due day of month whose net days are the next-month window", () => {
  const followingFirst = standard({
    id: "7",
    name: "Net 30, 1st Following",
    netDays: 0,
    dateDriven: true,
    dayOfMonthNetDue: "1",
    dueNextMonthIfWithinDays: "30",
    dateDrivenDiscountPercent: null,
    dayDiscountExpires: null,
  });
  assert.deepEqual(normalizeNetSuitePaymentTerm(followingFirst, followingFirst), {
    sourceRef: "7",
    naturalKey: "Net 30, 1st Following",
    fields: {
      name: "Net 30, 1st Following",
      netDays: "30",
      dueDayOfMonth: "1",
      discountPercent: null,
      discountDays: null,
      discountDayOfMonth: null,
    },
  });
  // A blank window is none; a blank day is carried as 0 for the loader to refuse.
  const blank = standard({
    netDays: 0,
    dateDriven: true,
    dayOfMonthNetDue: null,
    dueNextMonthIfWithinDays: null,
  });
  assert.deepEqual(
    [
      normalizeNetSuitePaymentTerm(blank, blank).fields.netDays,
      normalizeNetSuitePaymentTerm(blank, blank).fields.dueDayOfMonth,
    ],
    [0, 0],
  );
  // A date-driven discount carries its expiry day so the loader refuses it; a zero discount is none.
  const discounted = standard({
    netDays: 0,
    dateDriven: true,
    dayOfMonthNetDue: "15",
    dateDrivenDiscountPercent: "2.0%",
    dayDiscountExpires: "5",
  });
  assert.equal(normalizeNetSuitePaymentTerm(discounted, discounted).fields.discountDayOfMonth, "5");
  const zero = { ...discounted, dateDrivenDiscountPercent: "0.0%" };
  assert.deepEqual(
    [
      normalizeNetSuitePaymentTerm(zero, zero).fields.discountPercent,
      normalizeNetSuitePaymentTerm(zero, zero).fields.discountDayOfMonth,
    ],
    [null, null],
  );
});

test("an older bridge's terms are completed from the term record only when they state no net days", async () => {
  const loaded: string[] = [];
  const source = new NetSuiteSource(creds, { baseCurrency: "USD" });
  Object.defineProperty(source, "bridge", {
    value: {
      paymentTerms: async () => [
        standard({ id: "1", name: "Net 30" }),
        standard({ id: "7", name: "Net 1st Following", netDays: 0 }),
        standard({ id: "9", name: "Due on receipt", netDays: 0 }),
      ],
      record: async (recordType: string, id: string) => {
        assert.equal(recordType, "term");
        loaded.push(id);
        return {
          fields:
            id === "7"
              ? {
                  datedriven: "T",
                  dayofmonthnetdue: "1",
                  duenextmonthifwithindays: null,
                  discountpercentdatedriven: null,
                  daydiscountexpires: null,
                }
              : { datedriven: false, daysuntilnetdue: null },
        };
      },
    },
  });
  const entities = await source["paymentTerms"]();
  assert.deepEqual(loaded, ["7", "9"]);
  assert.deepEqual(
    entities.map((entity) => [
      entity.sourceRef,
      entity.fields.netDays,
      entity.fields.dueDayOfMonth,
    ]),
    [
      ["1", 30, null],
      ["7", 0, "1"],
      ["9", 0, null],
    ],
  );
});

test("the term record's date-driven flag is read from either NetSuite spelling", () => {
  assert.equal(netSuiteTermDateDrivenFields({ datedriven: true }).dateDriven, true);
  assert.equal(netSuiteTermDateDrivenFields({ datedriven: "T" }).dateDriven, true);
  assert.equal(netSuiteTermDateDrivenFields({ datedriven: "F" }).dateDriven, false);
  assert.equal(netSuiteTermDateDrivenFields({}).dateDriven, false);
});

test("the bridge reports each term's date-driven fields from the term search", () => {
  type Restlet = { post: (input: Record<string, unknown>) => unknown };
  let restlet: Restlet | undefined;
  let columns: string[] = [];
  const rows: Array<Record<string, unknown>> = [
    { internalid: "1", name: "Net 30", daysuntilnetdue: "30", datedriven: false },
    {
      internalid: "7",
      name: "Net 30, 1st Following",
      datedriven: true,
      dayofmonthnetdue: "1",
      duenextmonthifwithindays: "30",
    },
  ];
  const search = {
    Type: { TERM: "term" },
    create: (input: { columns: string[] }) => {
      columns = input.columns;
      return {
        run: () => ({
          each: (
            visit: (result: {
              id: string;
              getValue: (column: { name: string }) => unknown;
            }) => boolean,
          ) => {
            for (const row of rows)
              visit({ id: String(row.internalid), getValue: ({ name }) => row[name] ?? "" });
          },
        }),
      };
    },
  };
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "integrations/netsuite-bridge/src/FileCabinet/SuiteScripts/OpenBooks/openbooks_bridge_restlet.js",
  );
  runInNewContext(readFileSync(path, "utf8"), {
    define: (_dependencies: string[], factory: (...modules: unknown[]) => Restlet) => {
      restlet = factory({}, {}, {}, {}, {}, search, {});
    },
  });
  const response = JSON.parse(JSON.stringify(restlet!.post({ action: "paymentTerms" }))) as {
    rows: NetSuitePaymentTerm[];
  };
  for (const column of [
    "datedriven",
    "dayofmonthnetdue",
    "duenextmonthifwithindays",
    "discountpercentdatedriven",
    "daydiscountexpires",
  ]) {
    assert.ok(columns.includes(column), column);
  }
  assert.deepEqual(response.rows, [
    {
      id: "1",
      name: "Net 30",
      netDays: 30,
      discountPercent: null,
      discountDays: null,
      dateDriven: false,
      dayOfMonthNetDue: null,
      dueNextMonthIfWithinDays: null,
      dateDrivenDiscountPercent: null,
      dayDiscountExpires: null,
    },
    {
      id: "7",
      name: "Net 30, 1st Following",
      netDays: 0,
      discountPercent: null,
      discountDays: null,
      dateDriven: true,
      dayOfMonthNetDue: "1",
      dueNextMonthIfWithinDays: "30",
      dateDrivenDiscountPercent: null,
      dayDiscountExpires: null,
    },
  ]);
});
