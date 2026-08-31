// Run with:  node --import tsx --test engine/src/apps-runtime.test.ts   (from repo root)
//
// Unit tests for the App backend runtime. Uses in-memory adapter fakes, so the
// QuickJS sandbox is exercised end-to-end with no database.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runAppEndpoint,
  type AppHostAdapters,
  type AppRequest,
} from "./apps-runtime.ts";

function fakeAdapters(withRecords = false): AppHostAdapters {
  const store = new Map<string, unknown>();
  const k = (ns: string, key: string) => `${ns}\0${key}`;
  const adapters: AppHostAdapters = {
    storage: {
      async get(key, ns) {
        return store.has(k(ns, key)) ? store.get(k(ns, key)) : null;
      },
      async set(key, value, ns) {
        store.set(k(ns, key), value);
      },
      async list(prefix, ns) {
        const p = k(ns, prefix);
        return [...store.entries()]
          .filter(([kk]) => kk.startsWith(p))
          .map(([kk, value]) => ({ key: kk.slice(`${ns}\0`.length), value }));
      },
      async delete(key, ns) {
        store.delete(k(ns, key));
      },
    },
  };
  if (withRecords) {
    adapters.records = {
      async list(typeKey, filters) {
        return [{ id: "r1", typeKey, filters }];
      },
      async get(typeKey, id) {
        return { id, typeKey };
      },
    };
  }
  return adapters;
}

function withPlatform(adapters: AppHostAdapters): AppHostAdapters {
  adapters.platform = {
    async schema() {
      return [{ key: 'items', operations: ['list', 'get', 'create', 'update', 'delete'] }]
    },
    async list(typeKey, options) {
      return { records: [{ id: 'i1', typeKey }], options, total: 1, page: 1, perPage: 25 }
    },
    async get(typeKey, id) {
      return { typeKey, id }
    },
    async create(typeKey, body) {
      return { id: 'created', typeKey, ...body }
    },
    async update(typeKey, id, body) {
      return { id, typeKey, ...body }
    },
    async delete(typeKey, id) {
      return { ok: true, typeKey, id }
    },
  }
  return adapters
}

const req = (over: Partial<AppRequest> = {}): AppRequest => ({
  method: "POST",
  endpoint: "test",
  query: {},
  body: null,
  user: { id: "u1", name: "Ada", roles: ["admin"] },
  ...over,
});

test("handler returning a bare value → 200 with that body", async () => {
  const r = await runAppEndpoint({
    source: `function handler(request) { return { hello: request.user.name } }`,
    request: req(),
    adapters: fakeAdapters(),
  });
  assert.equal(r.status, "ok");
  assert.equal(r.response!.status, 200);
  assert.deepEqual(r.response!.body, { hello: "Ada" });
});

test("handler returning { status, body } is honored", async () => {
  const r = await runAppEndpoint({
    source: `function handler() { return { status: 201, body: { created: true } } }`,
    request: req(),
    adapters: fakeAdapters(),
  });
  assert.equal(r.status, "ok");
  assert.equal(r.response!.status, 201);
  assert.deepEqual(r.response!.body, { created: true });
});

test("storage set/get/list/delete round-trips via the KV adapter", async () => {
  const adapters = fakeAdapters();
  const set = await runAppEndpoint({
    source: `function handler(req) { ob.storage.set("counter", req.body.n); return ob.storage.get("counter") }`,
    request: req({ body: { n: 42 } }),
    adapters,
  });
  assert.equal(set.status, "ok");
  assert.equal(set.response!.body, 42);

  const list = await runAppEndpoint({
    source: `function handler() { ob.storage.set("a", 1); ob.storage.set("ab", 2); return ob.storage.list("a") }`,
    request: req(),
    adapters,
  });
  assert.equal(list.status, "ok");
  const keys = (list.response!.body as { key: string }[]).map((x) => x.key).sort();
  assert.deepEqual(keys, ["a", "ab"]);

  const del = await runAppEndpoint({
    source: `function handler() { ob.storage.delete("a"); return ob.storage.get("a") }`,
    request: req(),
    adapters,
  });
  assert.equal(del.response!.body, null);
});

test("records access is forbidden without the records adapter", async () => {
  const r = await runAppEndpoint({
    source: `function handler() { return ob.records.list("equipment") }`,
    request: req(),
    adapters: fakeAdapters(false),
  });
  assert.equal(r.status, "forbidden");
  assert.match(r.error!, /records\.read not granted/);
});

test("records access works when the adapter is present", async () => {
  const r = await runAppEndpoint({
    source: `function handler() { return ob.records.list("equipment", { status: "active" }) }`,
    request: req(),
    adapters: fakeAdapters(true),
  });
  assert.equal(r.status, "ok");
  const rows = r.response!.body as any[];
  assert.equal(rows[0].typeKey, "equipment");
  assert.deepEqual(rows[0].filters, { status: "active" });
});

test("governance budget stops a runaway handler", async () => {
  const r = await runAppEndpoint({
    source: `function handler() { for (var i = 0; i < 100; i++) ob.storage.set("k" + i, i); return "done" }`,
    request: req(),
    adapters: fakeAdapters(),
    unitBudget: 25, // 10 units per set → exceeded on the 3rd write
  });
  assert.equal(r.status, "error");
  assert.match(r.error!, /governance budget exceeded/);
  assert.ok(r.units > 25);
});

test("missing handler function is an error", async () => {
  const r = await runAppEndpoint({
    source: `var x = 1;`,
    request: req(),
    adapters: fakeAdapters(),
  });
  assert.equal(r.status, "error");
  assert.match(r.error!, /must define function handler/);
});

test("ob.log output is captured", async () => {
  const r = await runAppEndpoint({
    source: `function handler() { ob.log("hi", 123); return 1 }`,
    request: req(),
    adapters: fakeAdapters(),
  });
  assert.equal(r.status, "ok");
  assert.equal(r.logs.length, 1);
  assert.match(r.logs[0]!, /hi/);
});

test("ob.log obeys the governance budget", async () => {
  const r = await runAppEndpoint({
    source: `function handler() { ob.log("first"); ob.log("second"); return "done" }`,
    request: req(),
    adapters: fakeAdapters(),
    unitBudget: 1,
  });
  assert.equal(r.status, "error");
  assert.match(r.error!, /governance budget exceeded/);
  assert.equal(r.units, 2);
  assert.equal(r.logs.length, 1);
});

test("ob.log is stopped when it exceeds the governance budget", async () => {
  const r = await runAppEndpoint({
    source: `function handler() { for (var i = 0; i < 100; i++) ob.log("tick", i); return "done" }`,
    request: req(),
    adapters: fakeAdapters(),
    unitBudget: 2,
  });
  assert.equal(r.status, "error");
  assert.match(r.error!, /governance budget exceeded/);
  assert.ok(r.units > 2);
});

test("journal.create is forbidden without the journal adapter", async () => {
  const r = await runAppEndpoint({
    source: `function handler() { return ob.journal.create({ lines: [] }) }`,
    request: req(),
    adapters: fakeAdapters(),
  });
  assert.equal(r.status, "forbidden");
  assert.match(r.error!, /gl\.post not granted/);
});

test("journal.create round-trips input and post flag through the adapter", async () => {
  const calls: { input: unknown; post: boolean }[] = [];
  const adapters = fakeAdapters();
  adapters.journal = {
    async create(input, post) {
      calls.push({ input, post });
      return { id: "j1", documentNumber: "JE-0001", ...(post ? { entryId: "e1" } : {}) };
    },
  };
  const r = await runAppEndpoint({
    source: `function handler() {
      var draft = ob.journal.create({ memo: "m", lines: [{ accountCode: "5100", amount: 10 }, { accountCode: "2100", amount: -10 }] });
      var posted = ob.journal.create({ lines: [] }, { post: true });
      return { draft: draft, posted: posted };
    }`,
    request: req(),
    adapters,
  });
  assert.equal(r.status, "ok");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.post, false);
  assert.equal((calls[0]!.input as any).memo, "m");
  assert.equal(calls[1]!.post, true);
  const body = r.response!.body as any;
  assert.equal(body.draft.documentNumber, "JE-0001");
  assert.equal(body.posted.entryId, "e1");
});

test("a journal adapter failure surfaces as a script error, not a crash", async () => {
  const adapters = fakeAdapters();
  adapters.journal = {
    async create() {
      throw new Error("journal is not balanced");
    },
  };
  const r = await runAppEndpoint({
    source: `function handler() { return ob.journal.create({ lines: [] }) }`,
    request: req(),
    adapters,
  });
  assert.equal(r.status, "error");
  assert.match(r.error!, /not balanced/);
});

test("platform schema and CRUD functions round-trip through the governed adapter", async () => {
  const r = await runAppEndpoint({
    source: `function handler() {
      return {
        schema: ob.platform.schema(),
        list: ob.platform.list("items", { q: "widget" }),
        get: ob.platform.get("items", "i1"),
        create: ob.platform.create("items", { name: "Widget" }),
        update: ob.platform.update("items", "i1", { name: "Updated" }),
        deleted: ob.platform.delete("items", "i1")
      };
    }`,
    request: req(),
    adapters: withPlatform(fakeAdapters()),
  });
  assert.equal(r.status, "ok");
  const body = r.response!.body as any;
  assert.equal(body.schema[0].key, "items");
  assert.equal(body.list.options.q, "widget");
  assert.equal(body.get.id, "i1");
  assert.equal(body.create.name, "Widget");
  assert.equal(body.update.name, "Updated");
  assert.equal(body.deleted.ok, true);
  assert.equal(r.units, 200);
});

test("platform access is unavailable when the host does not provide an adapter", async () => {
  const r = await runAppEndpoint({
    source: `function handler() { return ob.platform.schema() }`,
    request: req(),
    adapters: fakeAdapters(),
  });
  assert.equal(r.status, "forbidden");
  assert.match(r.error!, /platform API unavailable/);
});

test("an infinite loop is stopped by the deadline", async () => {
  const r = await runAppEndpoint({
    source: `function handler() { while (true) {} }`,
    request: req(),
    adapters: fakeAdapters(),
    timeoutMs: 150,
  });
  assert.equal(r.status, "timeout");
});
