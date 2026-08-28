import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

type MockJob = {
  id: string;
  state: string;
  getState: () => Promise<string>;
  remove: () => Promise<void>;
};

type RouteState = {
  jobs: Map<string, MockJob>;
  createdJobIds: string[];
  enqueueAttempts: number;
  running: boolean;
  lockHeld: boolean;
  lockWaiters: Array<() => void>;
  blockFirstEnqueue: boolean;
  firstEnqueueStarted?: () => void;
  releaseFirstEnqueue?: () => void;
};

const stateKey = Symbol.for("openbooks.connection-run-route-test");
const routeState: RouteState = {
  jobs: new Map(),
  createdJobIds: [],
  enqueueAttempts: 0,
  running: false,
  lockHeld: false,
  lockWaiters: [],
  blockFirstEnqueue: false,
};
(
  globalThis as typeof globalThis & Record<symbol, unknown>
)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:next-server",
    `
      export class NextResponse extends Response {
        static json(body, init = {}) {
          return new NextResponse(JSON.stringify(body), {
            ...init,
            headers: { 'content-type': 'application/json', ...(init.headers || {}) },
          })
        }
      }
    `,
  ],
  [
    "mock:json",
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        try { return { ok: true, data: await request.json() } }
        catch { return { ok: false, response: Response.json({ errorCode: 'INVALID_JSON' }, { status: 400 }) } }
      }
    `,
  ],
  [
    "mock:authz",
    `
      export async function guardPermission() {
        return { user: { id: 'user-1', orgId: 'org-1' } }
      }
    `,
  ],
  [
    "mock:connection",
    `
      export async function getConnection() {
        return { status: 'connected', source: 'netsuite' }
      }
    `,
  ],
  [
    "mock:drizzle",
    `
      export function sql(strings, ...values) {
        return { queryChunks: strings.flatMap((part, index) => index < values.length ? [part, values[index]] : [part]) }
      }
    `,
  ],
  [
    "mock:jobs",
    `
      const state = globalThis[Symbol.for('openbooks.connection-run-route-test')]
      function makeJob(jobId) {
        const job = {
          id: jobId,
          state: 'waiting',
          async getState() { return job.state },
          async remove() { state.jobs.delete(jobId) },
        }
        return job
      }
      const queue = {
        async getJob(jobId) { return state.jobs.get(jobId) || undefined },
      }
      export function getMigrationQueue() { return queue }
      export async function enqueueMigration(_data, options) {
        state.enqueueAttempts++
        const jobId = options.jobId
        const existing = state.jobs.get(jobId)
        if (existing) return existing
        const job = makeJob(jobId)
        state.jobs.set(jobId, job)
        state.createdJobIds.push(jobId)
        if (state.blockFirstEnqueue) {
          state.blockFirstEnqueue = false
          state.firstEnqueueStarted?.()
          await new Promise((resolve) => { state.releaseFirstEnqueue = resolve })
        }
        return job
      }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.connection-run-route-test')]
      function sqlText(query) {
        const chunks = query?.queryChunks
        if (!Array.isArray(chunks)) return ''
        return chunks.map((chunk) => {
          if (typeof chunk === 'string') return chunk
          if (chunk && Array.isArray(chunk.queryChunks)) return sqlText(chunk)
          return String(chunk ?? '')
        }).join('')
      }
      function makeTx() {
        let lockAcquired = false
        return {
          async execute(query) {
            const text = sqlText(query)
            if (text.includes('pg_advisory_xact_lock')) {
              if (state.lockHeld) await new Promise((resolve) => state.lockWaiters.push(resolve))
              state.lockHeld = true
              lockAcquired = true
            }
            if (text.includes('from sync_runs')) {
              return { rows: state.running ? [{ one: 1 }] : [] }
            }
            return { rows: [] }
          },
          ownsLock() { return lockAcquired },
        }
      }
      export const db = {
        async transaction(callback) {
          const tx = makeTx()
          try { return await callback(tx) }
          finally {
            if (tx.ownsLock()) {
              state.lockHeld = false
              state.lockWaiters.shift()?.()
            }
          }
        },
      }
    `,
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { format: "module", shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    const mock =
      specifier === "next/server"
        ? "mock:next-server"
        : specifier === "@/lib/api/json"
          ? "mock:json"
          : specifier === "../../../../../../lib/authz"
            ? "mock:authz"
            : specifier === "@openbooks/engine/src/connection.ts"
              ? "mock:connection"
              : specifier === "@openbooks/engine/src/sync/connection.ts"
                ? "mock:connection"
                : specifier === "@openbooks/jobs"
                  ? "mock:jobs"
                  : specifier === "@openbooks/engine/src/db.ts"
                    ? "mock:db"
                    : specifier === "drizzle-orm"
                      ? "mock:drizzle"
                      : undefined;
    if (mock) return { format: "module", shortCircuit: true, url: mock };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", shortCircuit: true, source };
    return nextLoad(url, context);
  },
});

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  routeState.jobs.clear();
  routeState.createdJobIds.length = 0;
  routeState.enqueueAttempts = 0;
  routeState.running = false;
  routeState.lockHeld = false;
  routeState.lockWaiters.length = 0;
  routeState.blockFirstEnqueue = false;
  routeState.firstEnqueueStarted = undefined;
  routeState.releaseFirstEnqueue = undefined;
}

function request(mode: string): Request {
  return new Request("http://openbooks.test/api/platform/connections/conn-1/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

test("concurrent requests serialize the check and queue claim", async () => {
  reset();
  routeState.blockFirstEnqueue = true;
  const firstEnqueueStarted = new Promise<void>((resolve) => {
    routeState.firstEnqueueStarted = resolve;
  });

  const first = POST(request("full_migration"), {
    params: Promise.resolve({ id: "conn-1" }),
  });
  await firstEnqueueStarted;

  const second = POST(request("full_migration"), {
    params: Promise.resolve({ id: "conn-1" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(routeState.lockWaiters.length, 1, "the second request waits on the advisory lock");

  routeState.releaseFirstEnqueue?.();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);

  assert.equal(firstResponse.status, 200);
  assert.deepEqual(await firstResponse.json(), {
    jobId: "migration|conn-1|full_migration",
    mode: "full_migration",
  });
  assert.equal(secondResponse.status, 409);
  assert.deepEqual(await secondResponse.json(), { errorCode: "RUN_ALREADY_ACTIVE" });
  assert.equal(routeState.createdJobIds.length, 1, "only one queue job was created");
  assert.equal(routeState.enqueueAttempts, 1);
});

test("a terminal queue record can be replaced for a later deliberate run", async () => {
  reset();

  const firstResponse = await POST(request("mirror"), {
    params: Promise.resolve({ id: "conn-1" }),
  });
  assert.equal(firstResponse.status, 200);
  const prior = routeState.jobs.get("migration|conn-1|mirror");
  assert.ok(prior);
  prior.state = "completed";

  const secondResponse = await POST(request("mirror"), {
    params: Promise.resolve({ id: "conn-1" }),
  });
  assert.equal(secondResponse.status, 200);
  assert.deepEqual(await secondResponse.json(), {
    jobId: "migration|conn-1|mirror",
    mode: "mirror",
  });
  assert.equal(routeState.createdJobIds.length, 2);
  assert.deepEqual(routeState.createdJobIds, [
    "migration|conn-1|mirror",
    "migration|conn-1|mirror",
  ]);
});
