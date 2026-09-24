// Run with:  node --import tsx --test engine/src/apps/runtime.test.ts   (from repo root)
//
// Unit tests for the App backend runtime. Uses in-memory adapter fakes, so the
// QuickJS sandbox is exercised end-to-end with no database.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isHostVmUnfreeableSignal,
  runAppEndpoint,
  type AppHostAdapters,
  type AppRequest,
} from "./runtime.ts";

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

test("a pending host adapter is bounded by the endpoint deadline", async () => {
  const adapters = fakeAdapters();
  adapters.storage.get = async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return "too late";
  };
  const started = Date.now();
  const r = await runAppEndpoint({
    source: `function handler() { return ob.storage.get("slow") }`,
    request: req(),
    adapters,
    timeoutMs: 20,
  });

  assert.equal(r.status, "timeout");
  assert.equal(r.error, "execution timed out");
  assert.ok(Date.now() - started < 200, `endpoint exceeded bound: ${Date.now() - started}ms`);
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
  const rows = r.response!.body as Array<{ typeKey: unknown; filters: unknown }>;
  assert.equal(rows[0]!.typeKey, "equipment");
  assert.deepEqual(rows[0]!.filters, { status: "active" });
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
  assert.equal((calls[0]!.input as { memo?: unknown }).memo, "m");
  assert.equal(calls[1]!.post, true);
  const body = r.response!.body as { draft: { documentNumber: unknown }; posted: { entryId: unknown } };
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
  const body = r.response!.body as {
    schema: Array<{ key: unknown }>;
    list: { options: { q: unknown } };
    get: { id: unknown };
    create: { name: unknown };
    update: { name: unknown };
    deleted: { ok: unknown };
  };
  assert.equal(body.schema[0]!.key, "items");
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

test("a guest stack overflow is an endpoint error, not a host process abort", async () => {
  const r = await runAppEndpoint({
    source: `function handler() { function rec() { rec(); } rec(); }`,
    request: req(),
    adapters: fakeAdapters(),
  });
  assert.equal(r.status, "error");
  assert.equal(
    r.error,
    "guest stack overflow: the handler exceeded the sandbox stack limit",
  );
  // Dispose of that poisoned WASM runtime must not take the process down:
  // a later endpoint on the same host still returns a result.
  const after = await runAppEndpoint({
    source: `function handler() { return 1 }`,
    request: req(),
    adapters: fakeAdapters(),
  });
  assert.equal(after.status, "ok");
  assert.equal(after.response!.body, 1);
});

test("guest-controlled error text does not rewrite or skip runtime dispose", async () => {
  for (const text of ["stack overflow", "Maximum call stack size exceeded"]) {
    const r = await runAppEndpoint({
      source: `function handler() { throw new Error(${JSON.stringify(text)}); }`,
      request: req(),
      adapters: fakeAdapters(),
    });
    assert.equal(r.status, "error");
    assert.equal(r.error, text);
  }
});

test("a renamed Error is not a WebAssembly abort", () => {
  assert.equal(
    isHostVmUnfreeableSignal(new WebAssembly.RuntimeError("Aborted()")),
    true,
  );
  const renamed = new Error("Aborted()");
  renamed.name = "RuntimeError";
  assert.equal(isHostVmUnfreeableSignal(renamed), false);
  assert.equal(renamed instanceof WebAssembly.RuntimeError, false);
});

test('platform query plans round-trip through QuickJS without exposing SQL', async () => {
  const adapters = withPlatform(fakeAdapters())
  const plan = { from: { type: 'items', as: 'item' }, select: [{ source: 'item', field: 'id' }] }
  adapters.platform!.query = async (received) => {
    assert.deepEqual(received, plan)
    return { records: [{ 'item.id': 'i1' }], hasMore: false }
  }
  const result = await runAppEndpoint({
    source: 'function handler(request) { return ob.platform.query(request.body); }',
    request: req({ body: plan }), adapters,
  })
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.response!.body, { records: [{ 'item.id': 'i1' }], hasMore: false })
  assert.equal(result.units, 80)
})

test("the sandbox has no host db, fs, or net primitives except injected adapters", async () => {
  const r = await runAppEndpoint({
    source: `function handler() {
      var names = Object.getOwnPropertyNames(globalThis).sort();
      return {
        process: typeof process,
        require: typeof require,
        fetch: typeof fetch,
        fs: typeof fs,
        net: typeof net,
        http: typeof http,
        https: typeof https,
        child_process: typeof child_process,
        Buffer: typeof Buffer,
        XMLHttpRequest: typeof XMLHttpRequest,
        WebSocket: typeof WebSocket,
        Deno: typeof Deno,
        os: typeof os,
        std: typeof std,
        names: names
      };
    }`,
    request: req(),
    adapters: fakeAdapters(),
  });
  assert.equal(r.status, "ok");
  const body = r.response!.body as Record<string, unknown>;
  for (const key of [
    "process",
    "require",
    "fetch",
    "fs",
    "net",
    "http",
    "https",
    "child_process",
    "Buffer",
    "XMLHttpRequest",
    "WebSocket",
    "Deno",
    "os",
    "std",
  ]) {
    assert.equal(body[key], "undefined", `${key} leaked into the sandbox`);
  }
  const names = body.names as string[];
  assert.ok(names.includes("ob"));
  assert.equal(names.includes("process"), false);
  assert.equal(names.includes("require"), false);
});

test("the guest-visible host surface is exactly the sealed set", async () => {
  // A new host function changes what the guest can reach: it must be added
  // to the expected surface here AND given a straggler call below, so it
  // cannot skip the post-outcome seal by accident.
  const r = await runAppEndpoint({
    source: `function handler() { return Object.getOwnPropertyNames(ob).sort(); }`,
    request: req(),
    adapters: fakeAdapters(),
  });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.response!.body, [
    "__journal_create",
    "__platform_create",
    "__platform_delete",
    "__platform_get",
    "__platform_list",
    "__platform_query",
    "__platform_schema",
    "__platform_update",
    "__records_get",
    "__records_list",
    "__storage_delete",
    "__storage_get",
    "__storage_list",
    "__storage_set",
    "journal",
    "log",
    "platform",
    "records",
    "request",
    "storage",
  ]);
});

test("a post-outcome straggler cannot append logs or reach adapters", async () => {
  // The wall-clock timer and the host-call deadline share one absolute
  // deadline, so with an adapter that outlives it the two timers expire on
  // the same millisecond and either may fire first: the host deadline may
  // win (the guest catches, finishes pre-seal, the run reports ok) or the
  // wall may win (the timeout outcome is determined while the guest is
  // still suspended, and the guest resumes AFTER the seal). Only the
  // wall-won path exercises the seal, so repeat until it is observed.
  // The catch block below then calls every host function; each must refuse
  // instead of charging budget or reaching its adapter. When adding a host
  // function, add its call here too.
  const stragglerSource = `function handler() {
      try { ob.storage.get("slow"); }
      catch (e) {
        var ops = [
          () => ob.log("straggler"),
          () => ob.storage.get("k"),
          () => ob.storage.set("k", 1),
          () => ob.storage.list(""),
          () => ob.storage.delete("k"),
          () => ob.records.list("t"),
          () => ob.records.get("t", "1"),
          () => ob.journal.create({}),
          () => ob.platform.schema(),
          () => ob.platform.list("t", {}),
          () => ob.platform.get("t", "1"),
          () => ob.platform.create("t", {}),
          () => ob.platform.update("t", "1", {}),
          () => ob.platform.delete("t", "1"),
          () => ob.platform.query({})
        ];
        for (var i = 0; i < ops.length; i++) { try { ops[i](); } catch (ignored) {} }
      }
      return "done";
    }`;
  const buildAdapters = (): { adapters: AppHostAdapters; calls: string[] } => {
    const calls: string[] = [];
    const adapters = withPlatform(fakeAdapters(true));
    adapters.storage = {
      get: async (key) => {
        calls.push(`get:${key}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
        return "too late";
      },
      set: async (key) => {
        calls.push(`set:${key}`);
      },
      list: async () => {
        calls.push("list");
        return [];
      },
      delete: async (key) => {
        calls.push(`delete:${key}`);
      },
    };
    adapters.records = {
      list: async () => {
        calls.push("records.list");
        return [];
      },
      get: async () => {
        calls.push("records.get");
        return null;
      },
    };
    adapters.journal = {
      create: async () => {
        calls.push("journal.create");
        return { id: "j1" };
      },
    };
    adapters.platform = {
      query: async () => {
        calls.push("platform.query");
        return {};
      },
      schema: async () => {
        calls.push("platform.schema");
        return [];
      },
      list: async () => {
        calls.push("platform.list");
        return [];
      },
      get: async () => {
        calls.push("platform.get");
        return null;
      },
      create: async () => {
        calls.push("platform.create");
        return {};
      },
      update: async () => {
        calls.push("platform.update");
        return {};
      },
      delete: async () => {
        calls.push("platform.delete");
        return {};
      },
    };
    return { adapters, calls };
  };
  // Warm the sandbox once so a cold first compile cannot outlast the test's
  // deadline before the first host call (that path resolves the host
  // deadline synchronously and never suspends past the wall).
  const warm = await runAppEndpoint({
    source: `function handler() { return 1 }`,
    request: req(),
    adapters: fakeAdapters(),
  });
  assert.equal(warm.status, "ok");
  let timeoutsObserved = 0;
  for (let attempt = 0; attempt < 25 && timeoutsObserved === 0; attempt++) {
    const { adapters, calls } = buildAdapters();
    const r = await runAppEndpoint({
      source: stragglerSource,
      request: req(),
      adapters,
      timeoutMs: 20,
    });
    if (r.status !== "timeout") continue;
    timeoutsObserved++;
    // Let the suspended guest resume post-seal and run its straggler calls.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(r.logs, [], "a sealed ob.log must not mutate the returned logs");
    assert.deepEqual(calls, ["get:slow"], "no sealed host function may reach its adapter");
  }
  assert.equal(timeoutsObserved, 1, "expected the wall to win at least once in 25 tries");
});

test("raw records, journal, and platform host functions fail closed without adapters", async () => {
  const records = await runAppEndpoint({
    source: `function handler() { return JSON.parse(ob.__records_get("equipment", "r1")); }`,
    request: req(),
    adapters: fakeAdapters(),
  });
  assert.equal(records.status, "forbidden");
  assert.match(records.error!, /records\.read not granted/);

  const journal = await runAppEndpoint({
    source: `function handler() { return JSON.parse(ob.__journal_create("{}", false)); }`,
    request: req(),
    adapters: fakeAdapters(),
  });
  assert.equal(journal.status, "forbidden");
  assert.match(journal.error!, /gl\.post not granted/);

  const platform = await runAppEndpoint({
    source: `function handler() { return JSON.parse(ob.__platform_create("items", "{}")); }`,
    request: req(),
    adapters: fakeAdapters(),
  });
  assert.equal(platform.status, "forbidden");
  assert.match(platform.error!, /platform API unavailable/);
});
