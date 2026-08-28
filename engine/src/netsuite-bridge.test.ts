import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { NetSuiteBridgeClient } from "./netsuite-bridge.ts";
import {
  parseSoapTransactionSearchPage,
  type NetSuiteCreds,
} from "./netsuite.ts";

const creds: NetSuiteCreds = {
  account: "test",
  host: "https://example.invalid",
  consumerKey: "consumer",
  consumerSecret: "secret",
  tokenKey: "token",
  tokenSecret: "secret",
};

test("NetSuite bridge package does not commit an account-specific auth target", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const project = JSON.parse(readFileSync(
    join(repoRoot, "integrations", "netsuite-bridge", "project.json"),
    "utf8",
  )) as { defaultAuthId?: unknown };
  assert.equal(project.defaultAuthId, undefined);
});

test("NetSuite RESTlet scopes export status and cleanup to an exact job boundary", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const source = readFileSync(
    join(repoRoot, "integrations", "netsuite-bridge", "src", "FileCabinet", "SuiteScripts", "OpenBooks", "openbooks_bridge_restlet.js"),
    "utf8",
  );
  type SearchResult = { id: string; name: string; getValue: (field: { name: string }) => string };
  type Restlet = { post: (input: Record<string, unknown>) => unknown };
  let restlet: Restlet | undefined;
  let searchOptions: { filters: unknown } | undefined;
  const deletedIds: string[] = [];
  const searchRows: SearchResult[] = [
    { id: "1", name: "ob-chunk-abc-a-000000.json", getValue: ({ name }) => name === "name" ? "ob-chunk-abc-a-000000.json" : "1" },
    { id: "2", name: "ob-chunk-abc2-a-000000.json", getValue: ({ name }) => name === "name" ? "ob-chunk-abc2-a-000000.json" : "1" },
    { id: "3", name: "ob-summary-abc.json", getValue: ({ name }) => name === "name" ? "ob-summary-abc.json" : "1" },
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
        load: () => ({ folder: 7 }),
        delete: ({ id }: { id: string }) => { deletedIds.push(id); },
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
      restlet = factory(file, {}, {}, {}, {}, search, {});
    },
  };
  runInNewContext(source, context);
  assert.ok(restlet);
  const status = restlet.post({ action: "exportStatus", jobId: "abc" }) as { files: Array<{ id: string }> };
  assert.deepEqual(Array.from(status.files, (file) => file.id), ["1", "3"]);
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
    { id: "1" }, { id: "2" }, { id: "3" },
  ]);
  assert.deepEqual(requested, [0, 1]);
  assert.deepEqual(sizes, [1_000, 1_000]);
});

test("NetSuite bridge client fails closed on script errors and incompatible schemas", async () => {
  const failed = new NetSuiteBridgeClient(creds, {}, async <T>() => ({
    ok: false, schemaVersion: 1, name: "QUERY_ERROR", error: "field is unavailable",
  }) as T);
  await assert.rejects(() => failed.query("SELECT bad FROM account"), /field is unavailable/);

  const incompatible = new NetSuiteBridgeClient(creds, {}, async <T>() => ({
    schemaVersion: 2, pageIndex: 0, pageSize: 1, totalRows: 0, hasMore: false, rows: [],
  }) as T);
  await assert.rejects(() => incompatible.query("SELECT id FROM account"), /incompatible/);
});

test("NetSuite bridge deletion feed preserves tombstone identity", async () => {
  const client = new NetSuiteBridgeClient(creds, {}, async <T>(params: Record<string, unknown>) => {
    assert.equal(params.action, "deleted");
    assert.equal(params.recordType, "transaction");
    return {
      schemaVersion: 1,
      rows: [{ internalId: "42", deletedAt: "7/19/2026", recordType: "Invoice", name: "INV42", externalId: "" }],
    } as T;
  });
  assert.deepEqual(await client.deletedRecords(new Date("2026-07-19T00:00:00Z"), "transaction"), [
    { internalId: "42", deletedAt: "7/19/2026", recordType: "Invoice", name: "INV42", externalId: "" },
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
    actions.push(action);
    if (action === "startExport") {
      jobId = String(params.jobId);
      return { schemaVersion: 1, jobId, taskId: "task-1", partitions: 2 } as T;
    }
    if (action === "exportStatus") return {
      schemaVersion: 1,
      jobId,
      status: "complete",
      files: [
        { id: "11", name: `ob-chunk-${jobId}-a-000000.json`, size: 1, createdAt: "", modifiedAt: "" },
        { id: "12", name: `ob-chunk-${jobId}-b-000000.json`, size: 1, createdAt: "", modifiedAt: "" },
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
              { partId: "a", status: "complete", rows: 1, chunks: [{ id: "11", name: `ob-chunk-${jobId}-a-000000.json`, rows: 1 }] },
              { partId: "b", status: "complete", rows: 1, chunks: [{ id: "12", name: `ob-chunk-${jobId}-b-000000.json`, rows: 1 }] },
            ],
          }),
        } as T;
      }
      const partId = String(params.fileId) === "12" ? "b" : "a";
      return {
        schemaVersion: 1,
        fileId: params.fileId,
        name: `ob-chunk-${jobId}-${partId}-000000.json`,
        contents: JSON.stringify({ schemaVersion: 1, jobId, partId, pageIndex: 0, rows: [{ id: partId }] }),
      } as T;
    }
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
  assert.deepEqual(rows, new Map([["a", [{ id: "a" }]], ["b", [{ id: "b" }]]]));
  assert.deepEqual(actions, ["startExport", "exportStatus", "readChunk", "readChunk", "readChunk", "deleteExport", "deleteExport"]);
});

test("NetSuite bulk export fails closed on conflicting duplicate chunks", async () => {
  let jobId = "";
  const client = new NetSuiteBridgeClient(creds, {}, async <T>(params: Record<string, unknown>) => {
    const action = String(params.action);
    if (action === "startExport") {
      jobId = String(params.jobId);
      return { schemaVersion: 1, jobId, taskId: "task-1", partitions: 1 } as T;
    }
    if (action === "exportStatus") return {
      schemaVersion: 1,
      jobId,
      status: "complete",
      files: [
        { id: "21", name: `ob-chunk-${jobId}-a-000000.json`, size: 1, createdAt: "", modifiedAt: "" },
        { id: "22", name: `ob-chunk-${jobId}-a-000000.json`, size: 1, createdAt: "", modifiedAt: "" },
        { id: "23", name: `ob-summary-${jobId}.json`, size: 1, createdAt: "", modifiedAt: "" },
      ],
    } as T;
    if (action === "readChunk") return {
      schemaVersion: 1,
      fileId: params.fileId,
      name: String(params.fileId) === "23" ? `ob-summary-${jobId}.json` : `ob-chunk-${jobId}-a-000000.json`,
      contents: String(params.fileId) === "23"
        ? JSON.stringify({
          schemaVersion: 1,
          jobId,
          status: "complete",
          rows: 1,
          parts: [{
            partId: "a",
            status: "complete",
            rows: 1,
            chunks: [
              { id: "21", name: `ob-chunk-${jobId}-a-000000.json`, rows: 1 },
              { id: "22", name: `ob-chunk-${jobId}-a-000000.json`, rows: 1 },
            ],
          }],
        })
        : JSON.stringify({
          schemaVersion: 1,
          jobId,
          partId: "a",
          pageIndex: 0,
          rows: [{ id: String(params.fileId) }],
        }),
    } as T;
    if (action === "deleteExport") return { schemaVersion: 1, jobId, deleted: 2, remaining: 0 } as T;
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
    if (action === "startExport") {
      jobId = String(params.jobId);
      return { schemaVersion: 1, jobId, taskId: "task-1", partitions: 1 } as T;
    }
    if (action === "exportStatus") return {
      schemaVersion: 1,
      jobId,
      status: "complete",
      files: [
        { id: "31", name: `ob-summary-${jobId}.json`, size: 1, createdAt: "", modifiedAt: "" },
        { id: "32", name: `ob-chunk-${jobId}-a-000000.json`, size: 1, createdAt: "", modifiedAt: "" },
      ],
    } as T;
    if (action === "readChunk") {
      if (String(params.fileId) === "31") return {
        schemaVersion: 1,
        fileId: params.fileId,
        name: `ob-summary-${jobId}.json`,
        contents: JSON.stringify({
          schemaVersion: 1,
          jobId,
          status: "complete",
          rows: 2,
          parts: [{
            partId: "a",
            status: "complete",
            rows: 2,
            chunks: [
              { id: "32", name: `ob-chunk-${jobId}-a-000000.json`, rows: 1 },
              { id: "33", name: `ob-chunk-${jobId}-a-000001.json`, rows: 1 },
            ],
          }],
        }),
      } as T;
      return {
        schemaVersion: 1,
        fileId: params.fileId,
        name: `ob-chunk-${jobId}-a-000000.json`,
        contents: JSON.stringify({ schemaVersion: 1, jobId, partId: "a", pageIndex: 0, rows: [{ id: "a" }] }),
      } as T;
    }
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

test("NetSuite bulk export refuses cleanup when status contains a colliding job", async () => {
  let jobId = "";
  let cleanupCalls = 0;
  const client = new NetSuiteBridgeClient(creds, {}, async <T>(params: Record<string, unknown>) => {
    const action = String(params.action);
    if (action === "startExport") {
      jobId = String(params.jobId);
      return { schemaVersion: 1, jobId, taskId: "task-1", partitions: 1 } as T;
    }
    if (action === "exportStatus") return {
      schemaVersion: 1,
      jobId,
      status: "complete",
      files: [{ id: "41", name: `ob-chunk-${jobId}2-a-000000.json`, size: 1, createdAt: "", modifiedAt: "" }],
    } as T;
    if (action === "deleteExport") {
      cleanupCalls += 1;
      return { schemaVersion: 1, jobId, deleted: 1, remaining: 0 } as T;
    }
    throw new Error(`unexpected action ${action}`);
  });

  await assert.rejects(
    () => client.bulkQuery([{ id: "a", sql: "SELECT 1 AS id FROM DUAL" }]),
    /ambiguous names/,
  );
  assert.equal(cleanupCalls, 0);
});

test("NetSuite export deletion refuses substring-colliding files", async () => {
  let cleanupCalls = 0;
  const client = new NetSuiteBridgeClient(creds, {}, async <T>(params: Record<string, unknown>) => {
    const action = String(params.action);
    if (action === "listExports") return {
      schemaVersion: 1,
      files: [{ id: "51", name: "ob-chunk-abc2-a-000000.json", size: 1, createdAt: "", modifiedAt: "" }],
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
