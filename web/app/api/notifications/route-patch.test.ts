import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Route boundary suite: PATCH /api/notifications runs the real mark-read
// helper against a scripted database fake. A PATCH whose ids match nothing
// in scope (stale, foreign, or nonexistent) must 404 — never {ok:true}.

const stateKey = Symbol.for("openbooks.notifications-route-test");

interface NotificationsRouteState {
  /** Ids the fake UPDATE...RETURNING reports as flipped (still unread). */
  unreadIds: string[];
  /** Ids the caller owns but already read (counted, never flipped). */
  readIds: string[];
  /** Raw SQL texts the route sent, for predicate assertions. */
  calls: string[];
}

const routeState: NotificationsRouteState = { unreadIds: [], readIds: [], calls: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

/** Flatten a drizzle SQL chunk into its raw text for keyword assertions. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks)
        return sqlText(chunk);
      return "";
    })
    .join("");
}
(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksSqlTextNotifications = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.notifications-route-test')]
      const sqlText = globalThis.openbooksSqlTextNotifications
      export const db = {
        execute: (query) => {
          const text = sqlText(query)
          state.calls.push(text)
          if (/update\\s+notifications\\s+set\\s+read_at/i.test(text)) {
            return Promise.resolve({ rows: state.unreadIds.map((id) => ({ id })) })
          }
          if (/count\\(\\*\\)/i.test(text)) {
            return Promise.resolve({ rows: [{ n: state.unreadIds.length + state.readIds.length }] })
          }
          return Promise.resolve({ rows: [] })
        },
      }
    `,
  ],
  [
    "mock:authz",
    `
      export async function getAuthz() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["../../../lib/authz", "mock:authz"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    // The mark-read helper reaches the pool through a relative specifier;
    // keep it on the same fake as the route's own db import.
    if (
      typeof specifier === "string" &&
      specifier.endsWith("/platform/db.ts")
    ) {
      return { url: "mock:db", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) {
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?notifications-patch-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const KNOWN_ID = "00000000-0000-4000-8000-0000000000a1";
const READ_ID = "00000000-0000-4000-8000-0000000000a2";
const FOREIGN_ID = "00000000-0000-4000-8000-0000000000a3";
const MISSING_ID = "00000000-0000-4000-8000-0000000000a4";

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request("http://openbooks.test/api/notifications", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function reset(unread: string[], read: string[]): void {
  routeState.unreadIds = unread;
  routeState.readIds = read;
  routeState.calls = [];
}

test("PATCH marks matched ids and reports ok", async () => {
  reset([KNOWN_ID], []);

  const response = await patch({ ids: [KNOWN_ID] });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  const update = routeState.calls.find((text) =>
    /update\s+notifications\s+set\s+read_at/i.test(text),
  );
  assert.ok(update, "mark-read issues the conditional UPDATE");
  assert.match(update, /read_at is null/);
});

test("PATCH replays already-read own ids as ok with no change", async () => {
  // A second tab, a double click, a partly-read mark-all: the write flips
  // nothing because the rows are already read, but every id is the
  // caller's own — a harmless replay, not a refusal.
  reset([], [KNOWN_ID]);

  const response = await patch({ ids: [KNOWN_ID] });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("PATCH over a mixed own set (one unread, one already read) is ok", async () => {
  reset([KNOWN_ID], [READ_ID]);

  const response = await patch({ ids: [KNOWN_ID, READ_ID] });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("PATCH with a foreign id is 404, never {ok:true}", async () => {
  reset([KNOWN_ID], []);

  const response = await patch({ ids: [KNOWN_ID, FOREIGN_ID] });

  assert.equal(response.status, 404);
  const payload = (await response.json()) as { error?: string };
  assert.ok(payload.error, "the refusal names what happened");
  assert.deepEqual(
    Object.keys(payload).sort(),
    ["error"],
    "no ok:true alongside the refusal",
  );
});

test("PATCH with a nonexistent id is 404, never {ok:true}", async () => {
  reset([], []);

  const response = await patch({ ids: [MISSING_ID] });

  assert.equal(response.status, 404);
  const payload = (await response.json()) as { error?: string };
  assert.ok(payload.error, "the refusal names what happened");
});

test("PATCH mark-all stays idempotent when nothing is unread", async () => {
  reset([], []);

  const response = await patch({ all: true });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
