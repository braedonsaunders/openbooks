import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Route-boundary regression: a self-service preference update and its audit
// evidence must be one atomic database unit. The scripted database keeps
// writes issued through a transaction pending until the callback succeeds;
// an audit failure therefore proves whether the user row was rolled back.
const stateKey = Symbol.for("openbooks.me-route-test");
interface PendingWrite {
  kind: "user" | "audit";
  preference?: { locale: string | null; navMode: string | null };
}
interface RouteState {
  executed: string[];
  queries: unknown[];
  committed: PendingWrite[];
  pending: PendingWrite[];
  inTx: boolean;
  failOnText?: string;
  userPreference: { locale: string | null; navMode: string | null };
  requestedPreference: { locale: string | null; navMode: string | null };
}

const state: RouteState = {
  executed: [],
  queries: [],
  committed: [],
  pending: [],
  inTx: false,
  userPreference: { locale: "en", navMode: "topbar" },
  requestedPreference: { locale: "en", navMode: "topbar" },
};
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

/** Flatten drizzle SQL chunks into text for deterministic scripted replies. */
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
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlTextMe = sqlText;
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksMeSqlText = sqlText;

const ORG_ID = "00000000-0000-4000-8000-00000000a001";
const USER_ID = "00000000-0000-4000-8000-00000000a002";

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.me-route-test')]
      const sqlText = globalThis.openbooksSqlTextMe
      const classify = (text) => text.includes('update users') ? 'user' : text.includes('insert into audit_log') ? 'audit' : null
      const execute = async (query) => {
        const text = sqlText(query)
        state.queries.push(query)
        state.executed.push(text)
        if (state.failOnText && text.includes(state.failOnText)) {
          throw new Error('forced storage failure: ' + state.failOnText)
        }
        const kind = classify(text)
        if (kind) {
          const write = { kind }
          if (kind === 'user') write.preference = state.requestedPreference
          ;(state.inTx ? state.pending : state.committed).push(write)
          if (!state.inTx && kind === 'user') state.userPreference = write.preference
        }
        return { rows: [] }
      }
      export const db = {
        execute,
        transaction: async (work) => {
          state.inTx = true
          state.pending = []
          const tx = { execute }
          try {
            const result = await work(tx)
            state.committed.push(...state.pending)
            for (const write of state.pending) {
              if (write.kind === 'user') state.userPreference = write.preference
            }
            return result
          } catch (error) {
            state.pending = []
            throw error
          } finally {
            state.inTx = false
            state.pending = []
          }
        },
      }
      export const schema = {}
      export const pool = {}
      export const env = {}
      export function registerRequestOrgResolver() {}
    `,
  ],
  [
    "mock:authz",
    `
      export async function getAuthz() {
        return { user: { orgId: '${ORG_ID}', id: '${USER_ID}' } }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/db.ts", "mock:db"],
  ["../../../lib/authz", "mock:authz"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    if (specifier.startsWith("@/")) {
      return {
        url: new URL(`${specifier.slice(2)}.ts`, new URL("../../../", import.meta.url)).href,
        shortCircuit: true,
        format: "module",
      };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?me-preference-audit-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  state.executed = [];
  state.queries = [];
  state.committed = [];
  state.pending = [];
  state.inTx = false;
  state.failOnText = undefined;
  state.userPreference = { locale: "en", navMode: "topbar" };
  state.requestedPreference = { locale: "en", navMode: "topbar" };
}

function patch(body: Record<string, unknown>): Promise<Response> {
  state.requestedPreference = {
    locale: body.locale === undefined ? state.userPreference.locale : (body.locale as string | null),
    navMode: body.navMode === undefined ? state.userPreference.navMode : (body.navMode as string | null),
  };
  return PATCH(
    new Request("http://openbooks.test/api/me", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("preference changes commit together with their audit record", async () => {
  reset();

  const response = await patch({ locale: "fr", navMode: "sidebar" });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    locale: "fr",
    navMode: "sidebar",
  });
  assert.deepEqual(
    state.committed.map((write) => write.kind),
    ["user", "audit"],
    "the preference row and audit evidence commit as one unit",
  );
  assert.equal(state.pending.length, 0);
});

test("a forced audit failure rolls back the preference row", async () => {
  reset();
  state.failOnText = "insert into audit_log";

  await assert.rejects(
    () => patch({ locale: "fr" }),
    /forced storage failure: insert into audit_log/,
  );

  assert.ok(
    state.executed.some((text) => text.includes("update users")),
    "the preference mutation was attempted",
  );
  assert.ok(
    state.executed.some((text) => text.includes("insert into audit_log")),
    "the audit mutation was attempted",
  );
  assert.deepEqual(
    state.userPreference,
    { locale: "en", navMode: "topbar" },
    "the user preference remains unchanged after the audit failure",
  );
  assert.deepEqual(state.committed, [], "the failed unit committed no user row or audit record");
});

test("profile PATCH joins every requested preference fragment in the user update", async () => {
  reset();

  const response = await patch({ locale: "fr", navMode: "topbar" });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    locale: "fr",
    navMode: "topbar",
  });
  assert.equal(state.queries.length, 2, "profile update and audit must both execute");
  const update = sqlText(state.queries[0]);
  assert.match(update, /update users set/);
  assert.match(update, /locale/);
  assert.match(update, /nav_mode/);
});
