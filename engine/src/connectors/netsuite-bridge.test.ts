import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import {
  bridgeVersionSatisfies,
  NETSUITE_BRIDGE_MIN_VERSION,
  NetSuiteBridgeClient,
} from "./netsuite-bridge.ts";
import { parseSoapTransactionSearchPage, type NetSuiteCreds } from "./netsuite.ts";

const creds: NetSuiteCreds = {
  account: "test",
  host: "https://example.invalid",
  consumerKey: "consumer",
  consumerSecret: "secret",
  tokenKey: "token",
  tokenSecret: "secret",
};

const compatibleHealth = (version = "1.7.2") => ({
  ok: true,
  schemaVersion: 1,
  bridgeVersion: version,
  accountId: "TEST",
  environment: "SANDBOX",
  role: { id: "3", name: "Administrator" },
  serverTime: "2026-10-10 12:00:00",
  features: {},
  remainingUsage: 5000,
});

test("native CRM pages preserve complete note bodies and advance by source identity", async () => {
  const requests: Record<string, unknown>[] = [];
  const bridge = new NetSuiteBridgeClient(creds, {}, async <T>(params: Record<string, unknown>) => {
    requests.push(params);
    if (params.action === "health") return compatibleHealth() as T;
    assert.equal(params.action, "crmActivities");
    return {
      schemaVersion: 1,
      recordType: "note",
      hasMore: params.afterId === "0",
      rows: [{ id: params.afterId === "0" ? "12" : "19", fields: { note: "x".repeat(9000) } }],
    } as T;
  });
  const rows = await bridge.crmActivities("note");
  assert.deepEqual(
    rows.map((row) => row.id),
    ["12", "19"],
  );
  assert.equal(String(rows[0]!.fields.note).length, 9000);
  assert.deepEqual(
    requests.filter((row) => row.action === "crmActivities").map((row) => row.afterId),
    ["0", "12"],
  );
});

test("native CRM refuses unavailable sources and stalled pages instead of reporting zero activities", async () => {
  for (const failure of ["unavailable", "stalled"] as const) {
    const bridge = new NetSuiteBridgeClient(
      creds,
      {},
      async <T>(params: Record<string, unknown>) => {
        if (params.action === "health") return compatibleHealth() as T;
        if (failure === "unavailable") throw new Error("Source activity permission denied");
        return { schemaVersion: 1, recordType: "task", rows: [], hasMore: true } as T;
      },
    );
    await assert.rejects(
      bridge.crmActivities("task"),
      failure === "unavailable" ? /permission denied/ : /did not advance/,
    );
  }
});

test("native CRM record extraction whitelists fields and preserves native dates", () => {
  let restlet: { post: (params: Record<string, unknown>) => unknown } | undefined;
  const observed: string[] = [];
  runInNewContext(
    readSuiteScript(
      "integrations/netsuite-bridge/src/FileCabinet/SuiteScripts/OpenBooks/openbooks_bridge_restlet.js",
    ),
    {
      Date,
      define: (_dependencies: string[], factory: (...modules: unknown[]) => typeof restlet) => {
        restlet = factory(
          {},
          {},
          {
            runSuiteQLPaged: (input: { query: string; params: string[]; pageSize: number }) => {
              assert.equal(input.query, "select id from note where id > ? order by id");
              assert.equal(input.params[0], "0");
              assert.equal(input.pageSize, 50);
              return {
                pageRanges: [{ index: 0 }],
                count: 2,
                fetch: () => ({ data: { asMappedResults: () => [{ id: "51" }, { id: "3501" }] } }),
              };
            },
          },
          {
            load: () => ({
              getValue: ({ fieldId }: { fieldId: string }) => {
                observed.push(fieldId);
                return fieldId === "notedate"
                  ? new Date("2026-10-21T12:00:00Z")
                  : "A complete source value";
              },
            }),
          },
          {},
          {
            Sort: { ASC: "ASC" },
            createColumn: (value: unknown) => value,
            create: (input: { type: string }) => {
              assert.notEqual(input.type, "note", "note search omits transaction-linked notes");
              return { run: () => ({ getRange: () => [{ id: "99" }] }) };
            },
          },
          {},
        );
      },
    },
  );
  const page = JSON.parse(
    JSON.stringify(restlet!.post({ action: "crmActivities", recordType: "note", afterId: "0" })),
  ) as { rows: { id: string; fields: { notedate: string } }[] };
  assert.deepEqual(
    page.rows.map((row) => row.id),
    ["51", "3501"],
    "transaction-linked notes use the complete source identity list",
  );
  assert.equal(page.rows[0]!.fields.notedate, "2026-10-21T12:00:00.000Z");
  assert.ok(observed.includes("note"));
  assert.ok(!observed.includes("_eml_nkey_"));
  const taskPage = JSON.parse(
    JSON.stringify(restlet!.post({ action: "crmActivities", recordType: "task", afterId: "0" })),
  ) as { rows: { id: string }[] };
  assert.deepEqual(
    taskPage.rows.map((row) => row.id),
    ["99"],
  );
  assert.equal(
    (restlet!.post({ action: "crmActivities", recordType: "employee" }) as { ok: boolean }).ok,
    false,
  );
});

function readSuiteScript(path: string): string {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", path),
    "utf8",
  );
}

test("targeted deletion evidence filters audit columns without unsupported search criteria", () => {
  let restlet: { post: (input: Record<string, unknown>) => unknown } | undefined;
  const entries = ["10", "11"].map((id) => ({
    id,
    getValue: ({ name }: { name: string }) =>
      ({
        recordid: id,
        recordtype: "Time",
        deleteddate: "10/20/2026 2:00 PM",
        name: "Source time",
      })[name as "recordid"],
  }));
  let enumerations = 0;
  runInNewContext(
    readSuiteScript(
      "integrations/netsuite-bridge/src/FileCabinet/SuiteScripts/OpenBooks/openbooks_bridge_restlet.js",
    ),
    {
      define: (_dependencies: string[], factory: (...modules: unknown[]) => typeof restlet) => {
        restlet = factory(
          {},
          { Type: { DATE: "DATE" }, format: () => "01/01/1970" },
          {},
          {},
          {},
          {
            create: (input: { filters: unknown }) => {
              assert.ok(!JSON.stringify(input.filters).includes("recordid"));
              return {
                runPaged: () => {
                  enumerations++;
                  return { pageRanges: [{ index: 0 }], fetch: () => ({ data: entries }) };
                },
              };
            },
          },
          {},
        );
      },
    },
  );
  const response = JSON.parse(
    JSON.stringify(
      restlet!.post({ action: "deleted", since: "1970-01-01T00:00:00Z", recordIds: ["10"] }),
    ),
  ) as { rows: { internalId: string }[] };
  assert.deepEqual(
    response.rows.map((row) => row.internalId),
    ["10"],
  );
  assert.equal(enumerations, 1);
  assert.equal(
    (
      restlet!.post({ action: "deleted", since: "1970-01-01", recordIds: ["invalid"] }) as {
        ok: boolean;
      }
    ).ok,
    false,
  );
});

test("NetSuite RESTlet scopes export status and cleanup to an exact job boundary", () => {
  const source = readSuiteScript(
    "integrations/netsuite-bridge/src/FileCabinet/SuiteScripts/OpenBooks/openbooks_bridge_restlet.js",
  );
  type SearchResult = { id: string; name: string; getValue: (field: { name: string }) => string };
  type Restlet = { post: (input: Record<string, unknown>) => unknown };
  let restlet: Restlet | undefined;
  let searchOptions: { filters: unknown } | undefined;
  let exportTask: { params?: Record<string, unknown>; submit?: () => string } | undefined;
  const deletedIds: string[] = [];
  const searchRows: SearchResult[] = [
    {
      id: "1",
      name: "ob-chunk-abc-a-000000.json",
      getValue: ({ name }) => (name === "name" ? "ob-chunk-abc-a-000000.json" : "1"),
    },
    {
      id: "2",
      name: "ob-chunk-abc2-a-000000.json",
      getValue: ({ name }) => (name === "name" ? "ob-chunk-abc2-a-000000.json" : "1"),
    },
    {
      id: "3",
      name: "ob-summary-abc.json",
      getValue: ({ name }) => (name === "name" ? "ob-summary-abc.json" : "1"),
    },
  ];
  const matchesFilter = (expression: unknown, row: SearchResult): boolean => {
    if (!Array.isArray(expression)) return false;
    if (typeof expression[0] === "string") {
      const field = expression[0];
      const operator = expression[1];
      const value = expression[2];
      if (field === "folder") return true;
      if (field !== "name" || typeof value !== "string") return false;
      if (operator === "startswith") return row.name.startsWith(value);
      if (operator === "is") return row.name === value;
      return false;
    }
    let result = matchesFilter(expression[0], row);
    for (let index = 1; index < expression.length - 1; index += 2) {
      const operator = expression[index];
      const next = matchesFilter(expression[index + 1], row);
      result = operator === "AND" ? result && next : result || next;
    }
    return result;
  };
  const context = {
    define: (_deps: string[], factory: (...modules: unknown[]) => Restlet) => {
      const file = {
        Type: { JSON: "JSON" },
        load: () => ({ folder: 7 }),
        create: () => ({ save: () => "request-file" }),
        delete: ({ id }: { id: string }) => {
          deletedIds.push(id);
        },
      };
      const search = {
        create: (options: { filters: unknown }) => {
          searchOptions = options;
          return {
            run: () => ({
              each: (callback: (result: SearchResult) => boolean) => {
                for (const row of searchRows) {
                  if (matchesFilter(options.filters, row) && !callback(row)) break;
                }
                return true;
              },
            }),
          };
        },
      };
      const task = {
        TaskType: { MAP_REDUCE: "MAP_REDUCE" },
        create: () => (exportTask = { submit: () => "task-1" }),
      };
      restlet = factory(file, {}, {}, {}, {}, search, task);
    },
  };
  runInNewContext(source, context);
  assert.ok(restlet);
  restlet.post({
    action: "startExport",
    jobId: "abc",
    partitions: [{ id: "a", sql: "SELECT 1 FROM DUAL" }],
  });
  assert.equal(exportTask?.params?.custscript_openbooks_export_job_id, "abc");
  const status = restlet.post({ action: "exportStatus", jobId: "abc" }) as {
    files: Array<{ id: string }>;
  };
  assert.deepEqual(
    Array.from(status.files, (file) => file.id),
    ["1", "3"],
  );
  assert.equal(JSON.stringify(searchOptions?.filters).includes("contains"), false);
  const deletion = restlet.post({ action: "deleteExport", jobId: "abc" }) as { deleted: number };
  assert.equal(deletion.deleted, 2);
  assert.deepEqual(deletedIds, ["1", "3"]);
});

test("NetSuite bridge client exhausts deterministic pages", async () => {
  const requested: number[] = [];
  const sizes: number[] = [];
  const client = new NetSuiteBridgeClient(creds, {}, async <T>(params: Record<string, unknown>) => {
    const pageIndex = Number(params.pageIndex);
    requested.push(pageIndex);
    sizes.push(Number(params.pageSize));
    return {
      schemaVersion: 1,
      pageIndex,
      pageSize: 2,
      totalRows: 3,
      hasMore: pageIndex === 0,
      rows: pageIndex === 0 ? [{ id: "1" }, { id: "2" }] : [{ id: "3" }],
    } as T;
  });

  assert.deepEqual(await client.query<{ id: string }>("SELECT id FROM account"), [
    { id: "1" },
    { id: "2" },
    { id: "3" },
  ]);
  assert.deepEqual(requested, [0, 1]);
  assert.deepEqual(sizes, [1_000, 1_000]);
});

test("NetSuite bridge client fails closed on script errors and incompatible schemas", async () => {
  const failed = new NetSuiteBridgeClient(
    creds,
    {},
    async <T>() =>
      ({
        ok: false,
        schemaVersion: 1,
        name: "QUERY_ERROR",
        error: "field is unavailable",
      }) as T,
  );
  await assert.rejects(() => failed.query("SELECT bad FROM account"), /field is unavailable/);

  const incompatible = new NetSuiteBridgeClient(
    creds,
    {},
    async <T>() =>
      ({
        schemaVersion: 2,
        pageIndex: 0,
        pageSize: 1,
        totalRows: 0,
        hasMore: false,
        rows: [],
      }) as T,
  );
  await assert.rejects(() => incompatible.query("SELECT id FROM account"), /incompatible/);
});

test("NetSuite bridge deletion feed preserves tombstone identity", async () => {
  const client = new NetSuiteBridgeClient(creds, {}, async <T>(params: Record<string, unknown>) => {
    assert.equal(params.action, "deleted");
    assert.equal(params.recordType, "transaction");
    return {
      schemaVersion: 1,
      rows: [
        {
          internalId: "42",
          deletedAt: "7/19/2026",
          recordType: "Invoice",
          name: "INV42",
          externalId: "",
        },
      ],
    } as T;
  });
  assert.deepEqual(await client.deletedRecords(new Date("2026-07-19T00:00:00Z"), "transaction"), [
    {
      internalId: "42",
      deletedAt: "7/19/2026",
      recordType: "Invoice",
      name: "INV42",
      externalId: "",
    },
  ]);
});

test("SuiteTalk transaction search parsing returns only result records", () => {
  const page = parseSoapTransactionSearchPage(`
    <searchResult xmlns:platformCore="urn:core_2022_1.platform.webservices.netsuite.com">
      <platformCore:status isSuccess="true"/>
      <platformCore:totalPages>2</platformCore:totalPages>
      <platformCore:searchId>SEARCH-123</platformCore:searchId>
      <platformCore:recordList>
        <platformCore:record internalId="4001" xsi:type="expenseReport">
          <entity internalId="2654"/>
        </platformCore:record>
        <platformCore:record xsi:type="vendorBill" internalId="4002"/>
      </platformCore:recordList>
    </searchResult>
  `);
  assert.deepEqual(page, {
    transactionIds: ["4001", "4002"],
    searchId: "SEARCH-123",
    totalPages: 2,
  });
  assert.throws(
    () =>
      parseSoapTransactionSearchPage(
        `<status isSuccess="false"/><statusDetail><message>Denied</message></statusDetail>`,
      ),
    /Denied/,
  );
});

test("NetSuite bulk export assembles partition chunks and always cleans up", async () => {
  const actions: string[] = [];
  let jobId = "";
  let cleanupCalls = 0;
  const client = new NetSuiteBridgeClient(creds, {}, async <T>(params: Record<string, unknown>) => {
    const action = String(params.action);
    if (action === "health") return compatibleHealth() as T;
    actions.push(action);
    if (action === "startExport") {
      jobId = String(params.jobId);
      return { schemaVersion: 1, jobId, taskId: "task-1", partitions: 2 } as T;
    }
    if (action === "exportStatus")
      return {
        schemaVersion: 1,
        jobId,
        status: "complete",
        files: [
          {
            id: "11",
            name: `ob-chunk-${jobId}-a-000000.json`,
            size: 1,
            createdAt: "",
            modifiedAt: "",
          },
          {
            id: "12",
            name: `ob-chunk-${jobId}-b-000000.json`,
            size: 1,
            createdAt: "",
            modifiedAt: "",
          },
          { id: "13", name: `ob-summary-${jobId}.json`, size: 1, createdAt: "", modifiedAt: "" },
        ],
      } as T;
    if (action === "readChunk") {
      if (String(params.fileId) === "13") {
        return {
          schemaVersion: 1,
          fileId: params.fileId,
          name: `ob-summary-${jobId}.json`,
          contents: JSON.stringify({
            schemaVersion: 1,
            jobId,
            status: "complete",
            rows: 2,
            parts: [
              {
                partId: "a",
                status: "complete",
                rows: 1,
                chunks: [{ id: "11", name: `ob-chunk-${jobId}-a-000000.json`, rows: 1 }],
              },
              {
                partId: "b",
                status: "complete",
                rows: 1,
                chunks: [{ id: "12", name: `ob-chunk-${jobId}-b-000000.json`, rows: 1 }],
              },
            ],
          }),
        } as T;
      }
      const partId = String(params.fileId) === "12" ? "b" : "a";
      return {
        schemaVersion: 1,
        fileId: params.fileId,
        name: `ob-chunk-${jobId}-${partId}-000000.json`,
        contents: JSON.stringify({
          schemaVersion: 1,
          jobId,
          partId,
          pageIndex: 0,
          rows: [{ id: partId }],
        }),
      } as T;
    }
    if (action === "exportTaskStatus")
      return { schemaVersion: 1, taskId: params.taskId, status: "complete" } as T;
    if (action === "deleteExport") {
      cleanupCalls += 1;
      return {
        schemaVersion: 1,
        jobId,
        deleted: cleanupCalls === 1 ? 25 : 3,
        remaining: cleanupCalls === 1 ? 3 : 0,
      } as T;
    }
    throw new Error(`unexpected action ${action}`);
  });

  const rows = await client.bulkQuery<{ id: string }>([
    { id: "a", sql: "SELECT 1 AS id FROM DUAL" },
    { id: "b", sql: "SELECT 2 AS id FROM DUAL" },
  ]);
  assert.deepEqual(
    rows,
    new Map([
      ["a", [{ id: "a" }]],
      ["b", [{ id: "b" }]],
    ]),
  );
  assert.deepEqual(actions, [
    "startExport",
    "exportStatus",
    "exportTaskStatus",
    "readChunk",
    "readChunk",
    "readChunk",
    "deleteExport",
    "deleteExport",
  ]);
});

test("NetSuite bulk export fails closed on conflicting duplicate chunks", async () => {
  let jobId = "";
  const client = new NetSuiteBridgeClient(creds, {}, async <T>(params: Record<string, unknown>) => {
    const action = String(params.action);
    if (action === "health") return compatibleHealth() as T;
    if (action === "startExport") {
      jobId = String(params.jobId);
      return { schemaVersion: 1, jobId, taskId: "task-1", partitions: 1 } as T;
    }
    if (action === "exportStatus")
      return {
        schemaVersion: 1,
        jobId,
        status: "complete",
        files: [
          {
            id: "21",
            name: `ob-chunk-${jobId}-a-000000.json`,
            size: 1,
            createdAt: "",
            modifiedAt: "",
          },
          {
            id: "22",
            name: `ob-chunk-${jobId}-a-000000.json`,
            size: 1,
            createdAt: "",
            modifiedAt: "",
          },
          { id: "23", name: `ob-summary-${jobId}.json`, size: 1, createdAt: "", modifiedAt: "" },
        ],
      } as T;
    if (action === "readChunk")
      return {
        schemaVersion: 1,
        fileId: params.fileId,
        name:
          String(params.fileId) === "23"
            ? `ob-summary-${jobId}.json`
            : `ob-chunk-${jobId}-a-000000.json`,
        contents:
          String(params.fileId) === "23"
            ? JSON.stringify({
                schemaVersion: 1,
                jobId,
                status: "complete",
                rows: 1,
                parts: [
                  {
                    partId: "a",
                    status: "complete",
                    rows: 1,
                    chunks: [
                      { id: "21", name: `ob-chunk-${jobId}-a-000000.json`, rows: 1 },
                      { id: "22", name: `ob-chunk-${jobId}-a-000000.json`, rows: 1 },
                    ],
                  },
                ],
              })
            : JSON.stringify({
                schemaVersion: 1,
                jobId,
                partId: "a",
                pageIndex: 0,
                rows: [{ id: String(params.fileId) }],
              }),
      } as T;
    if (action === "exportTaskStatus")
      return { schemaVersion: 1, taskId: params.taskId, status: "complete" } as T;
    if (action === "deleteExport")
      return { schemaVersion: 1, jobId, deleted: 2, remaining: 0 } as T;
    throw new Error(`unexpected action ${action}`);
  });

  await assert.rejects(
    () => client.bulkQuery([{ id: "a", sql: "SELECT 1 AS id FROM DUAL" }]),
    /duplicate chunk manifest/,
  );
});

test("NetSuite bulk export fails closed when the summary names a missing chunk", async () => {
  let jobId = "";
  let cleanupCalls = 0;
  const client = new NetSuiteBridgeClient(creds, {}, async <T>(params: Record<string, unknown>) => {
    const action = String(params.action);
    if (action === "health") return compatibleHealth() as T;
    if (action === "startExport") {
      jobId = String(params.jobId);
      return { schemaVersion: 1, jobId, taskId: "task-1", partitions: 1 } as T;
    }
    if (action === "exportStatus")
      return {
        schemaVersion: 1,
        jobId,
        status: "complete",
        files: [
          { id: "31", name: `ob-summary-${jobId}.json`, size: 1, createdAt: "", modifiedAt: "" },
          {
            id: "32",
            name: `ob-chunk-${jobId}-a-000000.json`,
            size: 1,
            createdAt: "",
            modifiedAt: "",
          },
        ],
      } as T;
    if (action === "readChunk") {
      if (String(params.fileId) === "31")
        return {
          schemaVersion: 1,
          fileId: params.fileId,
          name: `ob-summary-${jobId}.json`,
          contents: JSON.stringify({
            schemaVersion: 1,
            jobId,
            status: "complete",
            rows: 2,
            parts: [
              {
                partId: "a",
                status: "complete",
                rows: 2,
                chunks: [
                  { id: "32", name: `ob-chunk-${jobId}-a-000000.json`, rows: 1 },
                  { id: "33", name: `ob-chunk-${jobId}-a-000001.json`, rows: 1 },
                ],
              },
            ],
          }),
        } as T;
      return {
        schemaVersion: 1,
        fileId: params.fileId,
        name: `ob-chunk-${jobId}-a-000000.json`,
        contents: JSON.stringify({
          schemaVersion: 1,
          jobId,
          partId: "a",
          pageIndex: 0,
          rows: [{ id: "a" }],
        }),
      } as T;
    }
    if (action === "exportTaskStatus")
      return { schemaVersion: 1, taskId: params.taskId, status: "complete" } as T;
    if (action === "deleteExport") {
      cleanupCalls += 1;
      return { schemaVersion: 1, jobId, deleted: 1, remaining: 0 } as T;
    }
    throw new Error(`unexpected action ${action}`);
  });

  await assert.rejects(
    () => client.bulkQuery([{ id: "a", sql: "SELECT 1 AS id FROM DUAL" }]),
    /chunk listing does not match its summary/,
  );
  assert.equal(cleanupCalls, 1);
});

test("NetSuite export deletion refuses substring-colliding files", async () => {
  let cleanupCalls = 0;
  const client = new NetSuiteBridgeClient(creds, {}, async <T>(params: Record<string, unknown>) => {
    const action = String(params.action);
    if (action === "listExports")
      return {
        schemaVersion: 1,
        files: [
          { id: "51", name: "ob-chunk-abc2-a-000000.json", size: 1, createdAt: "", modifiedAt: "" },
        ],
      } as T;
    if (action === "deleteExport") {
      cleanupCalls += 1;
      return { schemaVersion: 1, jobId: "abc", deleted: 1, remaining: 0 } as T;
    }
    throw new Error(`unexpected action ${action}`);
  });

  await assert.rejects(() => client.deleteExport("abc"), /ambiguous names/);
  assert.equal(cleanupCalls, 0);
});

test("NetSuite bulk export map/reduce only accepts the submitted job's request files", () => {
  const source = readSuiteScript(
    "integrations/netsuite-bridge/src/FileCabinet/SuiteScripts/OpenBooks/openbooks_export_map_reduce.js",
  );
  const files = [
    { id: "1", name: "ob-request-job-a.json" },
    { id: "2", name: "ob-request-other-a.json" },
  ];
  type Search = {
    run: () => { each: (callback: (row: (typeof files)[number]) => boolean) => void };
  };
  type Script = { getInputData: () => Search };
  const modules: Record<string, unknown> = {
    "N/file": { load: () => ({ folder: 7 }) },
    "N/query": {},
    "N/runtime": { getCurrentScript: () => ({ getParameter: () => "job" }) },
    "N/search": {
      create: (options: { filters: unknown[] }) => ({
        run: () => ({
          each: (callback: (row: (typeof files)[number]) => boolean) => {
            const prefix = String((options.filters[2] as string[])[2]);
            files.filter((file) => file.name.startsWith(prefix)).every(callback);
          },
        }),
      }),
    },
  };
  let script: Script | undefined;
  const context = {
    define: (deps: string[], factory: (...deps: unknown[]) => Script) => {
      script = factory(...deps.map((dep) => modules[dep]));
    },
  };
  runInNewContext(source, context);
  const matched: string[] = [];
  script!
    .getInputData()
    .run()
    .each((row) => {
      matched.push(row.id);
      return true;
    });
  assert.deepEqual(matched, ["1"]);
});

test("attachment inventory includes all transaction kinds and every page of file relationships", () => {
  type Column = { name: string; join?: string; sort?: string; summary?: string };
  type Restlet = { post: (input: Record<string, unknown>) => unknown };
  let restlet: Restlet | undefined;
  const requests: { type: string; filters: unknown; columns: Column[] }[] = [];
  const pages: number[] = [];
  const search = {
    Type: {
      TRANSACTION: "transaction",
      VENDOR_BILL: "vendorBill",
      EXPENSE_REPORT: "expenseReport",
    },
    Sort: { ASC: "ASC" },
    Summary: { GROUP: "GROUP" },
    createColumn: (column: Column) => column,
    create: (options: { type: string; filters: unknown; columns: Column[] }) => {
      requests.push(options);
      return {
        runPaged: () => ({
          count: 2,
          pageRanges: [{ index: 0 }, { index: 1 }],
          fetch: ({ index }: { index: number }) => {
            pages.push(index);
            return {
              data: [
                {
                  id: "10",
                  getValue: (column: Column) => (column.join ? String(100 + index) : "10"),
                },
              ],
            };
          },
        }),
      };
    },
  };
  runInNewContext(
    readSuiteScript(
      "integrations/netsuite-bridge/src/FileCabinet/SuiteScripts/OpenBooks/openbooks_bridge_restlet.js",
    ),
    {
      define: (_dependencies: string[], factory: (...modules: unknown[]) => Restlet) => {
        restlet = factory({}, {}, {}, {}, {}, search, {});
      },
    },
  );
  const response = restlet!.post({
    action: "attachmentInventory",
    records: [{ recordType: "transaction", internalId: "10" }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    schemaVersion: 1,
    records: { "10": ["100", "101"] },
  });
  assert.equal(requests[0]!.type, "transaction");
  assert.deepEqual(pages, [0, 1]);
  assert.ok(
    requests[0]!.columns.every((column) => column.sort === "ASC" && column.summary === "GROUP"),
  );
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0]!.filters)), [
    ["internalid", "anyof", ["10"]],
  ]);
});

test("text attachments request original bytes instead of treating decoded text as base64", () => {
  type Restlet = { post: (input: Record<string, unknown>) => unknown };
  let restlet: Restlet | undefined;
  let textReads = 0;
  const file = {
    load: () => ({
      name: "schedule.csv",
      fileType: "CSV",
      size: 3,
      isText: true,
      getContents() {
        textReads++;
        return "a,b";
      },
    }),
  };
  runInNewContext(
    readSuiteScript(
      "integrations/netsuite-bridge/src/FileCabinet/SuiteScripts/OpenBooks/openbooks_bridge_restlet.js",
    ),
    {
      define: (_dependencies: string[], factory: (...modules: unknown[]) => Restlet) => {
        restlet = factory(file, {}, {}, {}, {}, {}, {});
      },
    },
  );
  const response = restlet!.post({ action: "attachmentContent", fileId: "10" });
  assert.deepEqual(JSON.parse(JSON.stringify(response)), {
    ok: true,
    schemaVersion: 1,
    file: { id: "10", name: "schedule.csv", fileType: "CSV", size: 3, encoding: "raw-bytes" },
  });
  assert.equal(textReads, 0);
});

test("vendor bill PDFs and expense-line receipts share one deduplicated transaction file inventory", () => {
  type Column = { name: string; join?: string };
  let restlet: { post: (input: Record<string, unknown>) => unknown } | undefined;
  const record = {
    Type: { EXPENSE_REPORT: "expenseReport" },
    load: ({ type, id }: { type: string; id: string }) => {
      assert.equal(type, "expenseReport");
      assert.equal(id, "20");
      return {
        getLineCount: () => 3,
        getSublistValue: ({
          sublistId,
          fieldId,
          line,
        }: {
          sublistId: string;
          fieldId: string;
          line: number;
        }) => {
          assert.equal(sublistId, "expense");
          assert.equal(fieldId, "expmediaitem");
          return ["201", "202", "201"][line];
        },
      };
    },
  };
  const search = {
    Type: {
      TRANSACTION: "transaction",
      VENDOR_BILL: "vendorBill",
      EXPENSE_REPORT: "expenseReport",
    },
    Sort: { ASC: "ASC" },
    Summary: { GROUP: "GROUP" },
    createColumn: (column: Column) => column,
    create: ({ type }: { type: string }) => ({
      runPaged: () => ({
        count: 1,
        pageRanges: [{ index: 0 }],
        fetch: () => ({
          data: [
            {
              id: type === "vendorBill" ? "10" : "20",
              getValue: (column: Column) =>
                column.join
                  ? type === "vendorBill"
                    ? "100"
                    : "200"
                  : type === "vendorBill"
                    ? "10"
                    : "20",
            },
          ],
        }),
      }),
    }),
  };
  runInNewContext(
    readSuiteScript(
      "integrations/netsuite-bridge/src/FileCabinet/SuiteScripts/OpenBooks/openbooks_bridge_restlet.js",
    ),
    {
      define: (_dependencies: string[], factory: (...modules: unknown[]) => typeof restlet) => {
        restlet = factory({}, {}, {}, record, {}, search, {});
      },
    },
  );
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        restlet!.post({
          action: "attachmentInventory",
          records: [
            { recordType: "vendorBill", internalId: "10" },
            { recordType: "expenseReport", internalId: "20" },
          ],
        }),
      ),
    ),
    {
      ok: true,
      schemaVersion: 1,
      records: { "10": ["100"], "20": ["200", "201", "202"] },
    },
  );
});

test("expense reports deleted at the source inventory as fileless while other load failures still refuse", () => {
  const bridgeWith = (failure: { name: string; message: string }) => {
    let restlet: { post: (input: Record<string, unknown>) => unknown } | undefined;
    const record = {
      Type: { EXPENSE_REPORT: "expenseReport" },
      load: ({ id }: { id: string }) => {
        if (id === "21") throw Object.assign(new Error(failure.message), { name: failure.name });
        return { getLineCount: () => 1, getSublistValue: () => "300" };
      },
    };
    const search = {
      Type: {
        TRANSACTION: "transaction",
        VENDOR_BILL: "vendorBill",
        EXPENSE_REPORT: "expenseReport",
      },
      Sort: { ASC: "ASC" },
      Summary: { GROUP: "GROUP" },
      createColumn: (column: unknown) => column,
      create: () => ({
        runPaged: () => ({ count: 0, pageRanges: [], fetch: () => ({ data: [] }) }),
      }),
    };
    runInNewContext(
      readSuiteScript(
        "integrations/netsuite-bridge/src/FileCabinet/SuiteScripts/OpenBooks/openbooks_bridge_restlet.js",
      ),
      {
        define: (_dependencies: string[], factory: (...modules: unknown[]) => typeof restlet) => {
          restlet = factory({}, {}, {}, record, {}, search, {});
        },
      },
    );
    return restlet!.post({
      action: "attachmentInventory",
      records: [
        { recordType: "expenseReport", internalId: "20" },
        { recordType: "expenseReport", internalId: "21" },
      ],
    });
  };
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        bridgeWith({ name: "RCRD_DSNT_EXIST", message: "That record does not exist." }),
      ),
    ),
    {
      ok: true,
      schemaVersion: 1,
      records: { "20": ["300"], "21": [] },
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(bridgeWith({ name: "INSUFFICIENT_PERMISSION", message: "Denied" }))),
    {
      ok: false,
      schemaVersion: 1,
      error: "Denied",
      name: "INSUFFICIENT_PERMISSION",
    },
  );
});

test("attachment change detection lists transactions whose files changed on or after a calendar day", () => {
  let restlet: { post: (input: Record<string, unknown>) => unknown } | undefined;
  let filters: unknown;
  const format = {
    Type: { DATE: "date" },
    format: ({ value }: { value: Date }) =>
      `${value.getMonth() + 1}/${value.getDate()}/${value.getFullYear()}`,
  };
  const search = {
    Type: { TRANSACTION: "transaction" },
    Sort: { ASC: "ASC" },
    Summary: { GROUP: "GROUP" },
    createColumn: (column: unknown) => column,
    create: (options: { filters: unknown }) => {
      filters = options.filters;
      return {
        runPaged: () => ({
          count: 2,
          pageRanges: [{ index: 0 }],
          fetch: () => ({ data: ["7", "9"].map((id) => ({ getValue: () => id })) }),
        }),
      };
    },
  };
  runInNewContext(
    readSuiteScript(
      "integrations/netsuite-bridge/src/FileCabinet/SuiteScripts/OpenBooks/openbooks_bridge_restlet.js",
    ),
    {
      define: (_dependencies: string[], factory: (...modules: unknown[]) => typeof restlet) => {
        restlet = factory({}, format, {}, {}, {}, search, {});
      },
    },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(restlet!.post({ action: "attachmentChanges", since: "2026-10-09" }))),
    {
      ok: true,
      schemaVersion: 1,
      since: "2026-10-09",
      recordType: "transaction",
      transactions: ["7", "9"],
    },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(filters)), [
    ["file.modified", "onorafter", "10/9/2026"],
  ]);
  assert.equal(
    (restlet!.post({ action: "attachmentChanges", since: "yesterday" }) as { ok: boolean }).ok,
    false,
  );
});

test("an outdated installed bridge refuses before any export starts, naming its version and the upgrade", async () => {
  const actions: string[] = [];
  const client = new NetSuiteBridgeClient(creds, {}, async <T>(params: Record<string, unknown>) => {
    actions.push(String(params.action));
    return compatibleHealth("1.3.0") as T;
  });
  await assert.rejects(
    () => client.bulkQuery([{ id: "a", sql: "SELECT 1 AS id FROM DUAL" }]),
    /version 1\.3\.0; this release requires 1\.7\.2 or later\. Deploy the SuiteCloud project in integrations\/netsuite-bridge/,
  );
  assert.deepEqual(actions, ["health"]);
});

test("bridge version comparison is numeric and refuses malformed versions", () => {
  assert.equal(bridgeVersionSatisfies("1.4.0", "1.4.0"), true);
  assert.equal(bridgeVersionSatisfies("1.10.0", "1.4.0"), true);
  assert.equal(bridgeVersionSatisfies("2", "1.4.0"), true);
  assert.equal(bridgeVersionSatisfies("1.3.9", "1.4.0"), false);
  assert.equal(bridgeVersionSatisfies("", "1.4.0"), false);
  assert.equal(bridgeVersionSatisfies("1.4.0-beta", "1.4.0"), false);
});

test("the shipped bridge reports a version the engine's minimum admits", () => {
  type Restlet = { post: (input: Record<string, unknown>) => unknown };
  let restlet: Restlet | undefined;
  const runtime = {
    accountId: "TEST",
    envType: "SANDBOX",
    getCurrentScript: () => ({ getRemainingUsage: () => 5000 }),
    getCurrentUser: () => ({ role: "3", roleId: "Administrator" }),
    isFeatureInEffect: () => false,
  };
  const query = { runSuiteQL: () => ({ asMappedResults: () => [{ now: "2026-10-10 12:00:00" }] }) };
  runInNewContext(
    readSuiteScript(
      "integrations/netsuite-bridge/src/FileCabinet/SuiteScripts/OpenBooks/openbooks_bridge_restlet.js",
    ),
    {
      define: (_dependencies: string[], factory: (...modules: unknown[]) => Restlet) => {
        restlet = factory({}, {}, query, {}, runtime, {}, {});
      },
    },
  );
  const response = JSON.parse(JSON.stringify(restlet!.post({ action: "health" }))) as {
    ok: boolean;
    bridgeVersion: string;
  };
  assert.equal(response.ok, true);
  assert.equal(bridgeVersionSatisfies(response.bridgeVersion, NETSUITE_BRIDGE_MIN_VERSION), true);
});
