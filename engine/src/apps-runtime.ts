import { newAsyncContext } from "./quickjs.ts";

/**
 * App backend runtime — the server-side half of an App. Endpoint scripts run in
 * the SAME QuickJS WASM sandbox the user-scripting engine uses (no Node, no
 * filesystem, no network, no DB connection), but with an App-shaped host API
 * and a governance budget: every host call costs units, and a script that
 * exceeds its budget is stopped. This is what backs openbooks.callBackend()
 * from a sandboxed App frontend.
 *
 * Isolation via dependency injection: the runtime NEVER touches the database
 * directly. The caller passes `adapters` — storage (the App's own KV store) and
 * optionally records (org-scoped custom-record reads, present only when the App
 * was granted records.read). The web layer wires org- and permission-scoped
 * adapters; unit tests wire in-memory fakes. The sandbox therefore can't reach
 * anything the adapters don't expose, and can't escape its org.
 *
 * Contract: an endpoint file defines  function handler(request) { ... }
 *   request = { method, endpoint, path, query, body, user }   (deep-frozen)
 *   return  = the response body, OR { status: <int>, body: <any> }
 *
 * Host API on the global `ob`:
 *   ob.log(...)                            collect log lines
 *   ob.request                             the frozen request
 *   ob.storage.get(key[, ns])              read the App's KV store
 *   ob.storage.set(key, value[, ns])       write the App's KV store  (governed)
 *   ob.storage.list(prefix[, ns])          list KV entries by prefix
 *   ob.storage.delete(key[, ns])           delete a KV entry         (governed)
 *   ob.records.list(typeKey[, filters])    read custom records (needs records.read)
 *   ob.records.get(typeKey, id)            read one custom record   (needs records.read)
 *   ob.platform.schema()                   discover permitted record types + fields
 *   ob.platform.list/get(...)              search and read registered records
 *   ob.platform.create/update/delete(...)  governed domain writes with per-type permissions
 *   ob.journal.create(input[, {post}])     create a balanced draft journal, optionally
 *                                          post it through the posting engine (needs gl.post)
 */

export interface AppRequest {
  method: string;
  endpoint: string;
  path?: string;
  query: Record<string, string>;
  body: unknown;
  user: { id: string; name: string; roles: string[] } | null;
}

export interface AppStorageAdapter {
  get(key: string, namespace: string): Promise<unknown>;
  set(key: string, value: unknown, namespace: string): Promise<void>;
  list(
    prefix: string,
    namespace: string,
  ): Promise<{ key: string; value: unknown }[]>;
  delete(key: string, namespace: string): Promise<void>;
}

export interface AppRecordsAdapter {
  list(typeKey: string, filters: Record<string, unknown>): Promise<unknown[]>;
  get(typeKey: string, id: string): Promise<unknown>;
}

export interface AppJournalAdapter {
  /** Create a balanced draft journal; post=true runs the posting engine. */
  create(input: unknown, post: boolean): Promise<unknown>;
}

/** Permission-scoped access to the platform's self-describing record API. */
export interface AppPlatformAdapter {
  schema(): Promise<unknown>;
  list(typeKey: string, options: Record<string, unknown>): Promise<unknown>;
  get(typeKey: string, id: string): Promise<unknown>;
  create(typeKey: string, body: Record<string, unknown>): Promise<unknown>;
  update(typeKey: string, id: string, body: Record<string, unknown>): Promise<unknown>;
  delete(typeKey: string, id: string): Promise<unknown>;
}

export interface AppHostAdapters {
  storage: AppStorageAdapter;
  /** Present only when the App was granted records.read. */
  records?: AppRecordsAdapter;
  /** Present only when the App was granted gl.post (∩ the calling user). */
  journal?: AppJournalAdapter;
  /** Self-describing core/custom record CRUD, with per-type permission gates. */
  platform?: AppPlatformAdapter;
}

export interface AppEndpointResult {
  status: "ok" | "error" | "timeout" | "forbidden";
  /** Handler's response, normalized: { status: httpStatus, body }. */
  response?: { status: number; body: unknown };
  error?: string;
  logs: string[];
  units: number;
  durationMs: number;
}

/** Governance unit costs per host operation. */
const COST = {
  log: 1,
  storageGet: 5,
  storageList: 5,
  storageSet: 10,
  storageDelete: 10,
  recordsList: 10,
  recordsGet: 5,
  journalDraft: 100,
  journalPost: 200,
  platformSchema: 20,
  platformList: 20,
  platformGet: 10,
  platformCreate: 50,
  platformUpdate: 50,
  platformDelete: 50,
};
const DEFAULT_BUDGET = 1000;
const DEFAULT_TIMEOUT_MS = 3000;

const FORBIDDEN = "__OB_FORBIDDEN__";
const GOVERNANCE = "__OB_GOV__";
const TIMEOUT = "__OB_TIMEOUT__";
const HOST_TIMEOUT = Symbol("host-timeout");

export async function runAppEndpoint(opts: {
  source: string;
  request: AppRequest;
  adapters: AppHostAdapters;
  timeoutMs?: number;
  unitBudget?: number;
}): Promise<AppEndpointResult> {
  const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 15_000);
  const budget = opts.unitBudget ?? DEFAULT_BUDGET;
  const { adapters, request } = opts;

  const vm = await newAsyncContext();
  const runtime = vm.runtime;
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);

  /**
   * Asyncify suspends the VM while an adapter promise is pending, so the
   * interrupt handler cannot observe the endpoint deadline during that wait.
   * Race every host operation against the same wall-clock deadline instead.
   * The adapter promise remains handled after the race settles; if it resolves
   * later, it cannot resume QuickJS or start another host operation.
   */
  const withHostDeadline = async <T>(operation: () => Promise<T>): Promise<T | typeof HOST_TIMEOUT> => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return HOST_TIMEOUT;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<typeof HOST_TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(HOST_TIMEOUT), remainingMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const timeoutError = (): { error: ReturnType<typeof vm.newError> } => ({
    error: vm.newError(`${TIMEOUT}execution timed out`),
  });

  const logs: string[] = [];
  let units = 0;
  const started = Date.now();

  // Host API seal — once this run's terminal outcome has been computed (or an
  // outer invocation envelope has begun adjudicating it), every asyncified
  // host function refuses further work. Adapter calls are synchronous with
  // the invocation's transaction only up to that boundary; a straggler host
  // call sneaking in afterwards could stage effect rows outside the window
  // the envelope rolls back or commits (see engine/src/apps-invocations.ts).
  let sealed = false;
  const refuseIfSealed = (): { error: ReturnType<typeof vm.newError> } | null =>
    sealed ? { error: vm.newError("host API closed: the endpoint outcome was already determined") } : null;

  let vmDisposed = false;
  let cleanupDeferred = false;
  const disposeVm = (): void => {
    if (vmDisposed) return;
    vmDisposed = true;
    vm.dispose();
    runtime.dispose();
  };

  /** Charge units; throw a governance error handle when over budget. */
  const charge = (
    cost: number,
  ): { error: ReturnType<typeof vm.newError> } | null => {
    units += cost;
    if (units > budget)
      return {
        error: vm.newError(
          `${GOVERNANCE}governance budget exceeded (${units}/${budget} units)`,
        ),
      };
    return null;
  };

  try {
    const obHandle = vm.newObject();

    const logFn = vm.newFunction("log", (...args) => {
      const over = charge(COST.log);
      if (over) return over;
      logs.push(args.map((a) => JSON.stringify(vm.dump(a))).join(" "));
    });

    const storageGet = vm.newAsyncifiedFunction(
      "__storage_get",
      async (keyH, nsH) => {
        const closed = refuseIfSealed();
        if (closed) return closed;
        const over = charge(COST.storageGet);
        if (over) return over;
        const value = await withHostDeadline(() =>
          adapters.storage.get(
            String(vm.dump(keyH)),
            String(vm.dump(nsH) ?? "default"),
          ),
        );
        if (value === HOST_TIMEOUT) return timeoutError();
        return vm.newString(JSON.stringify(value ?? null));
      },
    );
    const storageSet = vm.newAsyncifiedFunction(
      "__storage_set",
      async (keyH, valH, nsH) => {
        const closed = refuseIfSealed();
        if (closed) return closed;
        const over = charge(COST.storageSet);
        if (over) return over;
        const raw = vm.dump(valH);
        const result = await withHostDeadline(() =>
          adapters.storage.set(
            String(vm.dump(keyH)),
            raw === undefined ? null : JSON.parse(String(raw)),
            String(vm.dump(nsH) ?? "default"),
          ),
        );
        if (result === HOST_TIMEOUT) return timeoutError();
        return vm.undefined;
      },
    );
    const storageList = vm.newAsyncifiedFunction(
      "__storage_list",
      async (prefixH, nsH) => {
        const closed = refuseIfSealed();
        if (closed) return closed;
        const over = charge(COST.storageList);
        if (over) return over;
        const rows = await withHostDeadline(() =>
          adapters.storage.list(
            String(vm.dump(prefixH) ?? ""),
            String(vm.dump(nsH) ?? "default"),
          ),
        );
        if (rows === HOST_TIMEOUT) return timeoutError();
        return vm.newString(JSON.stringify(rows));
      },
    );
    const storageDelete = vm.newAsyncifiedFunction(
      "__storage_delete",
      async (keyH, nsH) => {
        const closed = refuseIfSealed();
        if (closed) return closed;
        const over = charge(COST.storageDelete);
        if (over) return over;
        const result = await withHostDeadline(() =>
          adapters.storage.delete(
            String(vm.dump(keyH)),
            String(vm.dump(nsH) ?? "default"),
          ),
        );
        if (result === HOST_TIMEOUT) return timeoutError();
        return vm.undefined;
      },
    );

    const recordsList = vm.newAsyncifiedFunction(
      "__records_list",
      async (typeH, filtersH) => {
        const closed = refuseIfSealed();
        if (closed) return closed;
        if (!adapters.records)
          return {
            error: vm.newError(
              `${FORBIDDEN}records.read not granted to this app`,
            ),
          };
        const over = charge(COST.recordsList);
        if (over) return over;
        const filtersRaw = vm.dump(filtersH);
        const filters = filtersRaw ? JSON.parse(String(filtersRaw)) : {};
        const rows = await withHostDeadline(() =>
          adapters.records!.list(String(vm.dump(typeH)), filters),
        );
        if (rows === HOST_TIMEOUT) return timeoutError();
        return vm.newString(JSON.stringify(rows));
      },
    );
    const recordsGet = vm.newAsyncifiedFunction(
      "__records_get",
      async (typeH, idH) => {
        const closed = refuseIfSealed();
        if (closed) return closed;
        if (!adapters.records)
          return {
            error: vm.newError(
              `${FORBIDDEN}records.read not granted to this app`,
            ),
          };
        const over = charge(COST.recordsGet);
        if (over) return over;
        const row = await withHostDeadline(() =>
          adapters.records!.get(String(vm.dump(typeH)), String(vm.dump(idH))),
        );
        if (row === HOST_TIMEOUT) return timeoutError();
        return vm.newString(JSON.stringify(row ?? null));
      },
    );

    const journalCreate = vm.newAsyncifiedFunction(
      "__journal_create",
      async (inputH, postH) => {
        const closed = refuseIfSealed();
        if (closed) return closed;
        if (!adapters.journal)
          return {
            error: vm.newError(`${FORBIDDEN}gl.post not granted to this app`),
          };
        const post = vm.dump(postH) === true;
        const over = charge(post ? COST.journalPost : COST.journalDraft);
        if (over) return over;
        try {
          const input = JSON.parse(String(vm.dump(inputH)));
          const result = await withHostDeadline(() =>
            adapters.journal!.create(input, post),
          );
          if (result === HOST_TIMEOUT) return timeoutError();
          return vm.newString(JSON.stringify(result));
        } catch (e) {
          return {
            error: vm.newError(
              `journal.create failed: ${(e as Error).message}`,
            ),
          };
        }
      },
    );

    const platformCall = (
      name: string,
      cost: number,
      call: (...args: unknown[]) => Promise<unknown>,
    ) =>
      vm.newAsyncifiedFunction(name, async (...handles) => {
        const closed = refuseIfSealed();
        if (closed) return closed;
        if (!adapters.platform) {
          return { error: vm.newError(`${FORBIDDEN}platform API unavailable`) };
        }
        const over = charge(cost);
        if (over) return over;
        try {
          const result = await withHostDeadline(() =>
            call(...handles.map((handle) => vm.dump(handle))),
          );
          if (result === HOST_TIMEOUT) return timeoutError();
          return vm.newString(JSON.stringify(result ?? null));
        } catch (e) {
          const message = (e as Error).message;
          return {
            error: vm.newError(
              message.startsWith("missing permission:") ? `${FORBIDDEN}${message}` : message,
            ),
          };
        }
      });

    const platformSchema = platformCall("__platform_schema", COST.platformSchema, () => adapters.platform!.schema());
    const platformList = platformCall("__platform_list", COST.platformList, (typeH, optionsH) =>
      adapters.platform!.list(String(typeH), optionsH ? JSON.parse(String(optionsH)) : {}),
    );
    const platformGet = platformCall("__platform_get", COST.platformGet, (typeH, idH) =>
      adapters.platform!.get(String(typeH), String(idH)),
    );
    const platformCreate = platformCall("__platform_create", COST.platformCreate, (typeH, bodyH) =>
      adapters.platform!.create(String(typeH), bodyH ? JSON.parse(String(bodyH)) : {}),
    );
    const platformUpdate = platformCall("__platform_update", COST.platformUpdate, (typeH, idH, bodyH) =>
      adapters.platform!.update(String(typeH), String(idH), bodyH ? JSON.parse(String(bodyH)) : {}),
    );
    const platformDelete = platformCall("__platform_delete", COST.platformDelete, (typeH, idH) =>
      adapters.platform!.delete(String(typeH), String(idH)),
    );

    vm.setProp(obHandle, "log", logFn);
    vm.setProp(obHandle, "__storage_get", storageGet);
    vm.setProp(obHandle, "__storage_set", storageSet);
    vm.setProp(obHandle, "__storage_list", storageList);
    vm.setProp(obHandle, "__storage_delete", storageDelete);
    vm.setProp(obHandle, "__records_list", recordsList);
    vm.setProp(obHandle, "__records_get", recordsGet);
    vm.setProp(obHandle, "__journal_create", journalCreate);
    vm.setProp(obHandle, "__platform_schema", platformSchema);
    vm.setProp(obHandle, "__platform_list", platformList);
    vm.setProp(obHandle, "__platform_get", platformGet);
    vm.setProp(obHandle, "__platform_create", platformCreate);
    vm.setProp(obHandle, "__platform_update", platformUpdate);
    vm.setProp(obHandle, "__platform_delete", platformDelete);
    vm.setProp(vm.global, "ob", obHandle);
    for (const h of [
      logFn,
      storageGet,
      storageSet,
      storageList,
      storageDelete,
      recordsList,
      recordsGet,
      journalCreate,
      platformSchema,
      platformList,
      platformGet,
      platformCreate,
      platformUpdate,
      platformDelete,
      obHandle,
    ])
      h.dispose();

    const program = `
      ${opts.source}
      ;(() => {
        const request = ${JSON.stringify(request)};
        const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
        deepFreeze(request);
        ob.request = request;

        ob.storage = {
          get: function(key, ns) { var r = ob.__storage_get(String(key), ns || "default"); return JSON.parse(r); },
          set: function(key, value, ns) { ob.__storage_set(String(key), JSON.stringify(value === undefined ? null : value), ns || "default"); },
          list: function(prefix, ns) { return JSON.parse(ob.__storage_list(prefix || "", ns || "default")); },
          delete: function(key, ns) { ob.__storage_delete(String(key), ns || "default"); }
        };

        ob.records = {
          list: function(typeKey, filters) { return JSON.parse(ob.__records_list(String(typeKey), filters ? JSON.stringify(filters) : "")); },
          get: function(typeKey, id) { return JSON.parse(ob.__records_get(String(typeKey), String(id))); }
        };

        ob.journal = {
          create: function(input, opts) { return JSON.parse(ob.__journal_create(JSON.stringify(input || {}), !!(opts && opts.post))); }
        };

        ob.platform = {
          schema: function() { return JSON.parse(ob.__platform_schema()); },
          list: function(typeKey, options) { return JSON.parse(ob.__platform_list(String(typeKey), JSON.stringify(options || {}))); },
          get: function(typeKey, id) { return JSON.parse(ob.__platform_get(String(typeKey), String(id))); },
          create: function(typeKey, body) { return JSON.parse(ob.__platform_create(String(typeKey), JSON.stringify(body || {}))); },
          update: function(typeKey, id, body) { return JSON.parse(ob.__platform_update(String(typeKey), String(id), JSON.stringify(body || {}))); },
          delete: function(typeKey, id) { return JSON.parse(ob.__platform_delete(String(typeKey), String(id))); }
        };

        if (typeof handler !== "function") throw new Error("endpoint must define function handler(request)");
        const out = handler(request);
        return JSON.stringify(out ?? null);
      })()
    `;

    let result: Awaited<ReturnType<typeof vm.evalCodeAsync>>;
    try {
      const evalPromise = vm.evalCodeAsync(program);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const winner = await Promise.race([
        evalPromise.then(
          (value) => ({ kind: "result" as const, value }),
          (error) => ({ kind: "error" as const, error }),
        ),
        new Promise<{ kind: "timeout" }>((resolve) => {
          const remainingMs = Math.max(0, deadline - Date.now());
          timer = setTimeout(() => resolve({ kind: "timeout" }), remainingMs);
        }),
      ]);
      if (timer) clearTimeout(timer);

      if (winner.kind === "timeout") {
        // Seal before returning the timeout so a host callback that resolves
        // after the wall-clock boundary cannot stage more governed work. Keep
        // the context alive until asyncify has observed that callback's
        // completion; disposing a suspended WASM stack would be unsafe.
        sealed = true;
        cleanupDeferred = true;
        void evalPromise.then(
          (lateResult) => {
            if (lateResult.error) lateResult.error.dispose();
            else lateResult.value.dispose();
            disposeVm();
          },
          disposeVm,
        );
        return {
          status: "timeout",
          error: "execution timed out",
          logs,
          units,
          durationMs: Date.now() - started,
        };
      }
      if (winner.kind === "error") throw winner.error;
      result = winner.value;
    } finally {
      // From here on no new host work belongs to this attempt: the outcome is
      // being adjudicated. Applies on both the resolved and rejected paths.
      sealed = true;
    }
    if (result.error) {
      const err = vm.dump(result.error);
      result.error.dispose();
      const msg =
        typeof err === "object" && err && "message" in err
          ? String((err).message)
          : String(err);
      if (msg.startsWith(FORBIDDEN)) {
        return {
          status: "forbidden",
          error: msg.slice(FORBIDDEN.length),
          logs,
          units,
          durationMs: Date.now() - started,
        };
      }
      if (msg.startsWith(TIMEOUT)) {
        return {
          status: "timeout",
          error: msg.slice(TIMEOUT.length),
          logs,
          units,
          durationMs: Date.now() - started,
        };
      }
      if (Date.now() > deadline) {
        return {
          status: "timeout",
          error: "execution timed out",
          logs,
          units,
          durationMs: Date.now() - started,
        };
      }
      return {
        status: "error",
        error: msg.startsWith(GOVERNANCE) ? msg.slice(GOVERNANCE.length) : msg,
        logs,
        units,
        durationMs: Date.now() - started,
      };
    }

    const raw = vm.dump(result.value);
    result.value.dispose();
    const parsed =
      typeof raw === "string" && raw !== "null" ? JSON.parse(raw) : null;
    const response = normalizeResponse(parsed);
    return {
      status: "ok",
      response,
      logs,
      units,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    return {
      status: "error",
      error: (e as Error).message,
      logs,
      units,
      durationMs: Date.now() - started,
    };
  } finally {
    if (!cleanupDeferred) disposeVm();
  }
}

/** A handler may return `{ status, body }` or a bare value (→ 200 with body). */
function normalizeResponse(out: unknown): { status: number; body: unknown } {
  if (
    out &&
    typeof out === "object" &&
    "status" in (out) &&
    typeof (out).status === "number"
  ) {
    const o = out as { status: number; body?: unknown };
    return { status: o.status, body: "body" in o ? o.body : null };
  }
  return { status: 200, body: out ?? null };
}
