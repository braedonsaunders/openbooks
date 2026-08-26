import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NextResponse } from "next/server";

const apiRoot = fileURLToPath(new URL("../app/api/", import.meta.url));

async function routeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.isFile() && entry.name === "route.ts" ? [path] : [];
  }));
  return nested.flat();
}

test("API routes never use the redirecting page authorization gate", async () => {
  const redirectGateImport = /import\s*\{[^}]*\brequirePermission\b[^}]*\}\s*from\s*["'][^"']*\/authz["']/s;
  const redirectGateCall = /(^|[^.\w])requirePermission\s*\(/m;
  const offenders: string[] = [];
  for (const file of await routeFiles(apiRoot)) {
    const source = await readFile(file, "utf8");
    if (redirectGateImport.test(source) || redirectGateCall.test(source)) {
      offenders.push(relative(apiRoot, file));
    }
  }
  assert.deepEqual(offenders, [], "API handlers must use guardPermission and return its JSON response");
});

type GateMode = "allowed" | "forbidden" | "unauthorized";
type GateResult = NextResponse | {
  user: { id: string; orgId: string };
  permissions: Set<string>;
  allowedSubsidiaryIds: null;
};

const stateKey = Symbol.for("openbooks.authz-route-contract-test");
interface RouteState {
  gate: GateResult;
  gateCalls: string[];
  dbCalls: number;
}
const allowedGate: GateResult = {
  user: { id: "user-1", orgId: "org-1" },
  permissions: new Set(["documents.manage"]),
  allowedSubsidiaryIds: null,
};
const routeState: RouteState = { gate: allowedGate, gateCalls: [], dbCalls: 0 };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for("openbooks.authz-route-contract-test")];
      export async function guardPermission(permission) {
        state.gateCalls.push(permission);
        return state.gate;
      }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for("openbooks.authz-route-contract-test")];
      export const db = {
        execute: async () => {
          state.dbCalls += 1;
          return { rows: [] };
        },
        transaction: async (work) => {
          state.dbCalls += 1;
          return work({
            execute: async () => {
              state.dbCalls += 1;
              return { rows: [] };
            },
          });
        },
      };
    `,
  ],
]);

const webRoot = new URL("../", import.meta.url);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "@openbooks/engine/src/db.ts") {
      return { shortCircuit: true, url: "mock:db" };
    }
    if (specifier === "../../../lib/authz") {
      return { shortCircuit: true, url: "mock:authz" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", shortCircuit: true, source };
    return nextLoad(url, context);
  },
});

const routeUrl = "../app/api/dunning/route.ts?authz-route-contract";
const { GET, POST } = (await import(routeUrl)) as typeof import(
  "../app/api/dunning/route.ts"
);
hooks.deregister();

function reset(mode: GateMode): void {
  routeState.gate = mode === "unauthorized"
    ? NextResponse.json({ error: "unauthorized" }, { status: 401 })
    : mode === "forbidden"
      ? NextResponse.json(
        { error: "missing permission: documents.manage" },
        { status: 403 },
      )
      : allowedGate;
  routeState.gateCalls.length = 0;
  routeState.dbCalls = 0;
}

async function assertJsonError(
  response: Response,
  status: 401 | 403,
  error: string,
): Promise<void> {
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/);
  assert.equal(response.headers.get("location"), null, "API denials must not redirect");
  assert.deepEqual(await response.json(), { error });
}

test("a signed-out GET returns a 401 JSON response without reaching the database", async () => {
  reset("unauthorized");

  const response = await GET();

  await assertJsonError(response, 401, "unauthorized");
  assert.deepEqual(routeState.gateCalls, ["documents.manage"]);
  assert.equal(routeState.dbCalls, 0);
});

test("a forbidden write returns a 403 JSON response without parsing or writing", async () => {
  reset("forbidden");
  const request = new Request("http://openbooks.test/api/dunning", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Blocked policy", stages: [] }),
  });

  const response = await POST(request);

  await assertJsonError(response, 403, "missing permission: documents.manage");
  assert.deepEqual(routeState.gateCalls, ["documents.manage"]);
  assert.equal(routeState.dbCalls, 0);
});

test("an allowed GET continues through the handler", async () => {
  reset("allowed");

  const response = await GET();

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { policies: [] });
  assert.deepEqual(routeState.gateCalls, ["documents.manage"]);
  assert.equal(routeState.dbCalls, 2);
});
