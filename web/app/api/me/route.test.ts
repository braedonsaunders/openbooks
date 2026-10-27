import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { stubModules } from "../../../testing/stub-modules";
import test from "node:test";

// Route-boundary regression: a self-service preference update and its audit
// evidence must be one atomic database unit. The scripted database keeps
// writes issued through a transaction pending until the callback succeeds;
// an audit failure therefore proves whether the user row was rolled back.
const stateKey = Symbol.for("openbooks.me-route-test");
const ORG_ID = "00000000-0000-4000-8000-00000000a001";
const USER_ID = "00000000-0000-4000-8000-00000000a002";
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
  updateMatches: boolean;
  authzUser: {
    id: string;
    orgId: string;
    envKind: "production" | "sandbox" | "preview";
    homeUserId: string;
    homeOrgId: string;
  };
  userPreference: { locale: string | null; navMode: string | null };
  requestedPreference: { locale: string | null; navMode: string | null };
}

const state: RouteState = {
  executed: [],
  queries: [],
  committed: [],
  pending: [],
  inTx: false,
  updateMatches: true,
  authzUser: {
    id: USER_ID,
    orgId: ORG_ID,
    envKind: "production",
    homeUserId: USER_ID,
    homeOrgId: ORG_ID,
  },
  userPreference: { locale: "en", navMode: "topbar" },
  requestedPreference: { locale: "en", navMode: "topbar" },
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

/** Flatten drizzle SQL chunks into text for deterministic scripted replies. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown })?.value;
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.map(String).join("");
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk);
      return "";
    })
    .join("");
}
(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlTextMe = sqlText;
(globalThis as typeof globalThis & Record<string, unknown>).openbooksMeSqlText = sqlText;

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "@openbooks/engine/platform/db": `
      const state = globalThis[Symbol.for('openbooks.me-route-test')]
      const sqlText = globalThis.openbooksSqlTextMe
      const classify = (text) => text.includes('update users') ? 'user' : text.includes('insert into audit_log') ? 'audit' : null
      const execute = async (query, mode) => {
        const inMode = (result) => (mode === 'objects' ? result.rows : result)
        const text = sqlText(query)
        state.queries.push(query)
        state.executed.push(text)
        if (state.failOnText && text.includes(state.failOnText)) {
          throw new Error('forced storage failure: ' + state.failOnText)
        }
        const kind = classify(text)
        if (kind === 'user' && !state.updateMatches) return inMode({ rows: [], rowCount: 0 })
        if (kind) {
          if (kind !== 'user' || state.updateMatches) {
            const write = { kind }
            if (kind === 'user') write.preference = state.requestedPreference
            ;(state.inTx ? state.pending : state.committed).push(write)
            if (!state.inTx && kind === 'user') state.userPreference = write.preference
          }
        }
        return inMode(await (kind === 'user' ? { rows: state.updateMatches ? [{ id: state.authzUser.id }] : [] } : { rows: [] }))
      }
      const transaction = async (work) => {
          state.inTx = true
          state.pending = []
          try {
            const result = await work()
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
        }
      export async function withBypass(work) { return transaction(work) }
      export const db = {
        execute,
        transaction: async (work) => transaction(() => work({ execute })),
      }
      export const schema = {}
      export const pool = {}
      export const env = {}
      export function registerRequestOrgResolver() {}
    `,
    "../../../lib/authz": `
      export async function getAuthz() {
        return { user: globalThis[Symbol.for('openbooks.me-route-test')].authzUser }
      }
    `,
    "@/lib/authz": `
      export async function getAuthz() {
        return { user: globalThis[Symbol.for('openbooks.me-route-test')].authzUser }
      }
    `,
  },
});

const routeUrl = "./route.ts?me-preference-audit-test";
const { PATCH } = (await import(routeUrl)) as typeof import("./route.ts");

function reset(): void {
  state.executed = [];
  state.queries = [];
  state.committed = [];
  state.pending = [];
  state.inTx = false;
  state.updateMatches = true;
  state.authzUser = {
    id: USER_ID,
    orgId: ORG_ID,
    envKind: "production",
    homeUserId: USER_ID,
    homeOrgId: ORG_ID,
  };
  state.failOnText = undefined;
  state.userPreference = { locale: "en", navMode: "topbar" };
  state.requestedPreference = { locale: "en", navMode: "topbar" };
}

function patch(body: Record<string, unknown>): Promise<Response> {
  state.requestedPreference = {
    locale:
      body.locale === undefined ? state.userPreference.locale : (body.locale as string | null),
    navMode:
      body.navMode === undefined ? state.userPreference.navMode : (body.navMode as string | null),
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

test("a missing or inactive preference identity is refused with guidance and no audit", async () => {
  reset();
  state.updateMatches = false;

  const response = await patch({ locale: "de" });

  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: string; remedy: string };
  assert.match(body.error, /not saved/);
  assert.match(body.remedy, /Sign in again/);
  assert.equal(
    state.executed.some((text) => text.includes("insert into audit_log")),
    false,
    "no audit claims a change that did not happen",
  );
  assert.deepEqual(state.committed, []);
  assert.deepEqual(state.userPreference, { locale: "en", navMode: "topbar" });
});

test("a switched production super-admin updates and audits the home preference row", async () => {
  reset();
  const targetOrgId = "00000000-0000-4000-8000-00000000a099";
  state.authzUser = {
    id: USER_ID,
    orgId: targetOrgId,
    envKind: "production",
    homeUserId: USER_ID,
    homeOrgId: ORG_ID,
  };

  const response = await patch({ locale: "fr" });

  assert.equal(response.status, 200);
  const dialect = new PgDialect();
  assert.deepEqual(dialect.sqlToQuery(state.queries[0] as SQL).params, [
    "fr",
    USER_ID,
    USER_ID,
    ORG_ID,
  ]);
  assert.deepEqual(dialect.sqlToQuery(state.queries[1] as SQL).params, [
    ORG_ID,
    USER_ID,
    JSON.stringify({ locale: "fr" }),
    USER_ID,
  ]);
});
