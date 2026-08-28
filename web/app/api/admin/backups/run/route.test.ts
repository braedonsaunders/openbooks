import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.backup-run-route-test");
interface RouteState {
  calls: string[];
  enqueueCalls: number;
  enqueueError?: Error;
  runId: string;
}
const routeState: RouteState = {
  calls: [],
  enqueueCalls: 0,
  runId: "00000000-0000-4000-8000-00000000b001",
};
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

/** Flatten a drizzle SQL chunk into its raw text for scripted replies. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk);
      return "";
    })
    .join("");
}
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlTextBackupRun = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.backup-run-route-test')]
      const sqlText = globalThis.openbooksSqlTextBackupRun
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.calls.push(text)
          if (text.includes('insert into backup_runs')) {
            return { rows: [{ id: state.runId }] }
          }
          return { rows: [] }
        },
      }
      export const env = {}
      export const pool = {}
    `,
  ],
  [
    "mock:file-storage",
    "export const s3Enabled = true",
  ],
  [
    "mock:jobs",
    `
      const state = globalThis[Symbol.for('openbooks.backup-run-route-test')]
      export async function enqueueBackupRun() {
        state.enqueueCalls += 1
        if (state.enqueueError) throw state.enqueueError
        return { id: state.runId }
      }
    `,
  ],
  [
    "mock:authz",
    `
      export async function guardPermission() {
        return { user: { orgId: '00000000-0000-4000-8000-00000000b002', id: '00000000-0000-4000-8000-00000000b003' } }
      }
    `,
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "@openbooks/engine/src/db.ts") {
      return { url: "mock:db", shortCircuit: true };
    }
    if (specifier === "@openbooks/engine/src/file-storage.ts") {
      return { url: "mock:file-storage", shortCircuit: true };
    }
    if (specifier === "@openbooks/jobs") {
      return { url: "mock:jobs", shortCircuit: true };
    }
    if (specifier === "../../../../../lib/authz") {
      return { url: "mock:authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?backup-enqueue-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  routeState.calls = [];
  routeState.enqueueCalls = 0;
  routeState.enqueueError = undefined;
}

test("a successfully enqueued backup returns its run id", async () => {
  reset();

  const response = await POST();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, runId: routeState.runId });
  assert.equal(routeState.enqueueCalls, 1);
  assert.equal(routeState.calls.filter((text) => text.includes("set status = 'failed'")).length, 0);
});

test("an enqueue failure marks the queued run failed and releases the in-flight slot", async () => {
  reset();
  routeState.enqueueError = new Error("Redis unavailable");

  const response = await POST();

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "could not queue backup" });
  assert.equal(routeState.enqueueCalls, 1);
  const cleanup = routeState.calls.find((text) => text.includes("set status = 'failed'"));
  assert.ok(cleanup, "the committed queued row is transitioned to failed");
  assert.match(cleanup, /update backup_runs/);
  assert.match(cleanup, /status = 'queued'/);
});
