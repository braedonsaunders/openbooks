import assert from "node:assert/strict";
import test from "node:test";
import type { NativeContext } from "./native.ts";
import { NetSuiteSource } from "./netsuite-source.ts";

const creds = {
  account: "TEST",
  host: "https://test.example.invalid",
  consumerKey: "consumer",
  consumerSecret: "secret",
  tokenKey: "token",
  tokenSecret: "token-secret",
};

test("targeted NetSuite pulls include payment links touching either document side", async () => {
  const queries: string[] = [];
  const source = new NetSuiteSource(creds, { baseCurrency: "USD", accountingBookId: "1" });
  Object.defineProperty(source, "q", {
    value: async (query: string) => {
      queries.push(query);
      if (/MAX\(lastmodifieddate\)/i.test(query)) {
        return [{ now: "2026-07-31 12:00:00" }];
      }
      if (/COUNT\(\*\)/i.test(query)) return [{ n: "1" }];
      if (/nexttransactionlinelink/i.test(query)) {
        return [
          {
            previousdoc: "10",
            previousline: "1",
            nextdoc: "20",
            nextline: "2",
            foreignamount: "25.0000",
            paycurrency: "CAD",
            payexrate: "1",
            payposting: "T",
            appposting: "T",
            payaccount: "AR",
            appaccount: "AR",
          },
        ];
      }
      return [];
    },
  });

  const changes = await source.nativeTransactionsByIds(["10"], {} as NativeContext);

  assert.deepEqual(changes.applications, [
    {
      paymentRef: "20",
      appliedRef: "10",
      amount: "25.0000",
      currency: "CAD",
      rate: "1",
      paymentAccountRef: "AR",
      appliedAccountRef: "AR",
    },
  ]);
  assert.match(
    queries.find((query) => /nexttransactionlinelink/i.test(query))!,
    /n\.nextdoc IN \(10\) OR n\.previousdoc IN \(10\)/,
  );
});

function allocationGraphSource(
  options: {
    count?: number;
    rows?: unknown[];
    changedCount?: number;
    changedRows?: unknown[];
  } = {},
) {
  const source = new NetSuiteSource(creds, { baseCurrency: "CAD", accountingBookId: "1" });
  const queries: string[] = [];
  let reads = 0;
  let graphReads = 0;
  Object.defineProperty(source, "q", {
    configurable: true,
    value: async (query: string) => {
      queries.push(query);
      if (/MAX\(lastmodifieddate\)/i.test(query)) return [{ now: "2026-07-31 12:00:00" }];
      if (/nexttransactionlinelink/i.test(query)) {
        if (/COUNT\(\*\)/i.test(query)) {
          reads += 1;
          return [
            {
              n: String(
                reads > 1 ? (options.changedCount ?? options.count ?? 0) : (options.count ?? 0),
              ),
            },
          ];
        }
        graphReads++;
        return graphReads > 1 ? (options.changedRows ?? options.rows ?? []) : (options.rows ?? []);
      }
      if (/COUNT\(\*\)/i.test(query)) return [{ n: "0" }];
      return [];
    },
  });
  Object.defineProperty(source, "bridge", {
    value: {
      deletedRecords: async () => [],
      bulkQuery: async () => {
        throw new Error("Allocation reads must not start an export task");
      },
    },
  });
  return { source, queries };
}

test("incremental NetSuite mirrors fetch a complete allocation graph even without changed transactions", async () => {
  const { source, queries } = allocationGraphSource({
    count: 2,
    rows: [
      {
        previousdoc: "bill",
        previousline: "0",
        nextdoc: "payment",
        nextline: "1",
        foreignamount: "0",
        paycurrency: "CAN",
        payexrate: "1",
      },
      {
        previousdoc: "void-journal",
        previousline: "1",
        nextdoc: "payment",
        nextline: "1",
        foreignamount: "611.52",
        paycurrency: "CAN",
        payexrate: "1",
        payposting: "T",
        appposting: "T",
        payaccount: "111",
        appaccount: "111",
      },
    ],
  });
  const result = await source.nativeChanges(new Date("2026-07-31T11:59:00Z"), {} as NativeContext);
  assert.equal(result.documents.length, 0);
  assert.equal(result.settlementObservation?.scope.kind, "all");
  assert.deepEqual(result.applications, [
    {
      paymentRef: "payment",
      appliedRef: "void-journal",
      amount: "611.52",
      currency: "CAD",
      rate: "1",
      paymentAccountRef: "111",
      appliedAccountRef: "111",
    },
  ]);
  const graphQueries = queries.filter((query) => /nexttransactionlinelink/i.test(query));
  assert.equal(graphQueries.length, 4);
  for (const query of graphQueries)
    assert.doesNotMatch(query, /lastmodifieddate\s*(?:>=|<=|>|<|=)|\bIN\s*\(/i);
});

test("an incomplete NetSuite allocation graph refuses instead of authorizing releases", async () => {
  const { source } = allocationGraphSource({ count: 1 });
  await assert.rejects(
    () => source.nativeChanges(new Date(), {} as NativeContext),
    /application graph is incomplete/,
  );
});

test("a source graph changing during pagination refuses its allocation snapshot", async () => {
  const { source } = allocationGraphSource({ count: 0, changedCount: 1 });
  await assert.rejects(
    () => source.nativeChanges(new Date(), {} as NativeContext),
    /changed during reading/,
  );
});

test("a confirmed empty source allocation graph remains authoritative", async () => {
  const { source } = allocationGraphSource();
  const changes = await source.nativeChanges(new Date(), {} as NativeContext);
  assert.equal(changes.settlementObservation?.scope.kind, "all");
  assert.deepEqual(changes.applications, []);
});

test("unknown and invalid source graph counts never authorize an empty snapshot", async () => {
  for (const count of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const { source } = allocationGraphSource({ count });
    await assert.rejects(
      () => source.nativeChanges(new Date(), {} as NativeContext),
      /graph count is unavailable/,
    );
  }
});

test("duplicate page identities cannot substitute for missing source allocations", async () => {
  const row = {
    previousdoc: "bill",
    previousline: "0",
    nextdoc: "payment",
    nextline: "1",
    foreignamount: "25",
    paycurrency: "CAN",
    payexrate: "1",
  };
  const { source } = allocationGraphSource({ count: 2, rows: [row, row] });
  await assert.rejects(
    () => source.nativeChanges(new Date(), {} as NativeContext),
    /graph is incomplete/,
  );
});

test("complete NetSuite settlement graphs refuse missing control-account evidence", async () => {
  const { source } = allocationGraphSource({
    count: 1,
    rows: [
      {
        previousdoc: "bill",
        previousline: "0",
        nextdoc: "payment",
        nextline: "1",
        foreignamount: "25",
        paycurrency: "CAN",
        payexrate: "1",
        payposting: "T",
        appposting: "T",
        payaccount: "111",
      },
    ],
  });
  await assert.rejects(
    () => source.nativeChanges(new Date(), {} as NativeContext),
    /control-account identity is unavailable/,
  );
});

function postedLink(overrides: Record<string, unknown> = {}) {
  return {
    previousdoc: "10",
    previousline: "0",
    nextdoc: "20",
    nextline: "1",
    foreignamount: "25",
    paycurrency: "CAN",
    payexrate: "1",
    payposting: "T",
    appposting: "T",
    payaccount: "111",
    appaccount: "111",
    ...overrides,
  };
}

test("pending payments and targets are observed without admitting financial settlements", async () => {
  const { source } = allocationGraphSource({
    count: 3,
    rows: [
      postedLink(),
      postedLink({ nextdoc: "21", payposting: "F", payaccount: null }),
      postedLink({ nextdoc: "22", previousdoc: "11", appposting: "F", appaccount: null }),
    ],
  });
  const changes = await source.nativeChanges(new Date(), {} as NativeContext);
  assert.equal(changes.applications.length, 1);
  assert.deepEqual(changes.settlementObservation?.nonpostingRefs, ["11", "21"]);
  assert.deepEqual(
    changes.settlementObservation?.exclusions.map((row) => row.reason),
    ["nonposting_payment", "nonposting_target"],
  );
  assert.equal(changes.settlementObservation?.rawLinks, 3);
  assert.equal(changes.settlementObservation?.eligibleLinks, 1);
});

test("unknown posting states and absent source amounts refuse rather than becoming exclusions", async () => {
  for (const overrides of [
    { payposting: null },
    { appposting: "" },
    { foreignamount: null },
    { foreignamount: "" },
  ]) {
    const { source } = allocationGraphSource({ count: 1, rows: [postedLink(overrides)] });
    await assert.rejects(
      () => source.nativeChanges(new Date(), {} as NativeContext),
      /unknown endpoint posting state|has no source amount/,
    );
  }
});

test("same-count changes to amounts, accounts, and posting states invalidate the observation", async () => {
  for (const overrides of [
    { foreignamount: "24" },
    { payaccount: "112" },
    { payposting: "F" },
    { appstatus: "B" },
  ]) {
    const { source } = allocationGraphSource({
      count: 1,
      rows: [postedLink()],
      changedRows: [postedLink(overrides)],
    });
    await assert.rejects(
      () => source.nativeChanges(new Date(), {} as NativeContext),
      /changed during reading/,
    );
  }
});

test("targeted pulls use the same posting classifier and record a partial scope", async () => {
  const { source, queries } = allocationGraphSource({
    count: 1,
    rows: [postedLink({ payposting: "F", payaccount: null })],
  });
  const changes = await source.nativeTransactionsByIds(["10"], {} as NativeContext);
  assert.deepEqual(changes.applications, []);
  assert.deepEqual(changes.settlementObservation?.scope, { kind: "references", refs: ["10"] });
  for (const query of queries.filter((query) => /nexttransactionlinelink/.test(query))) {
    assert.match(query, /n.nextdoc IN \(10\) OR n.previousdoc IN \(10\)/);
  }
});

test("targeted posted links cannot bypass missing account evidence", async () => {
  const { source } = allocationGraphSource({ count: 1, rows: [postedLink({ appaccount: null })] });
  await assert.rejects(
    () => source.nativeTransactionsByIds(["10"], {} as NativeContext),
    /control-account identity is unavailable.*20:1→10:0/,
  );
});

test("a later source change refuses pre-reconciliation validation", async () => {
  const { source } = allocationGraphSource({ count: 1, rows: [postedLink()] });
  const changes = await source.nativeChanges(new Date(), {} as NativeContext);
  Object.defineProperty(source, "q", {
    configurable: true,
    value: async (query: string) =>
      /COUNT/.test(query) ? [{ n: "1" }] : [postedLink({ foreignamount: "24" })],
  });
  await assert.rejects(
    () => source.revalidateSettlementObservation(changes.settlementObservation!),
    /changed before reconciliation/,
  );
});

test("removed links cannot release a payer that is now nonposting or inaccessible", async () => {
  for (const paymentRows of [[], [{ id: "20", posting: "F" }]]) {
    const { source } = allocationGraphSource();
    const changes = await source.nativeChanges(new Date(), {} as NativeContext);
    Object.defineProperty(source, "q", {
      configurable: true,
      value: async (query: string) =>
        /nexttransactionlinelink/.test(query)
          ? /COUNT/.test(query)
            ? [{ n: "0" }]
            : []
          : paymentRows,
    });
    await assert.rejects(
      () => source.confirmSettlementReleases(changes.settlementObservation!, ["20"]),
      /missing, nonposting, or changed.*settlements were preserved/,
    );
  }
});

test("release confirmation rechecks only affected payer links and permits a stable posted payer", async () => {
  const { source, queries } = allocationGraphSource();
  const changes = await source.nativeChanges(new Date(), {} as NativeContext);
  Object.defineProperty(source, "q", {
    configurable: true,
    value: async (query: string) => {
      queries.push(query);
      if (/nexttransactionlinelink/.test(query)) return /COUNT/.test(query) ? [{ n: "0" }] : [];
      return [{ id: "20", posting: "T" }];
    },
  });
  const start = queries.length;
  await source.confirmSettlementReleases(changes.settlementObservation!, ["20"]);
  const graphQueries = queries
    .slice(start)
    .filter((query) => /nexttransactionlinelink/.test(query));
  assert.equal(graphQueries.length, 4);
  for (const query of graphQueries)
    assert.match(query, /n.nextdoc IN \(20\) OR n.previousdoc IN \(20\)/);
});

test("payer links appearing during release confirmation preserve prior allocations", async () => {
  const { source } = allocationGraphSource();
  const changes = await source.nativeChanges(new Date(), {} as NativeContext);
  Object.defineProperty(source, "q", {
    configurable: true,
    value: async (query: string) => (/COUNT/.test(query) ? [{ n: "1" }] : [postedLink()]),
  });
  await assert.rejects(
    () => source.confirmSettlementReleases(changes.settlementObservation!, ["20"]),
    /payer links changed before release/,
  );
});

test("nonposting source payments stay in both pull universes without becoming deletion candidates", async () => {
  const { source } = allocationGraphSource();
  Object.defineProperty(source, "q", {
    configurable: true,
    value: async (query: string) => {
      if (/MAX\(lastmodifieddate\)/i.test(query)) return [{ now: "2026-07-31 12:00:00" }];
      if (/COUNT\(\*\)/i.test(query)) return [{ n: "1" }];
      if (/nexttransactionlinelink/i.test(query))
        return [postedLink({ payposting: "F", payaccount: null })];
      if (/FROM transactionline tl/i.test(query)) return [{ transaction: "20", id: "0" }];
      if (/FROM transaction t WHERE/i.test(query))
        return [{ id: "20", ttype: "VendPymt", posting: "F" }];
      return [];
    },
  });
  for (const changes of [
    await source.nativeChanges(new Date(), {} as NativeContext),
    await source.nativeTransactionsByIds(["20"], {} as NativeContext),
  ]) {
    assert.deepEqual(changes.nonLedgerRefs, ["20"]);
    assert.deepEqual(changes.sourcePresence, [{ ref: "20", posting: false }]);
    assert.deepEqual(changes.documents, []);
    assert.deepEqual(changes.unbuildable, []);
    assert.deepEqual(changes.applications, []);
  }
});
