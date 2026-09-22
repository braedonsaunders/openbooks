import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

const SOURCE = readFileSync(new URL("./search-read.ts", import.meta.url), "utf8");

test("search reader reuses the existing finder instead of a parallel index", () => {
  assert.match(SOURCE, /from "\.\.\/search"/);
  assert.match(SOURCE, /globalSearch\(context\.authz/);
  assert.doesNotMatch(SOURCE, /similarity\(|pg_trgm|document_lines|drizzle-orm/);
});

const stateKey = Symbol.for("openbooks.search-read-test");
interface SearchReadState {
  calls: Array<{ authz: unknown; rawQ: string }>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result: any;
  thrown: unknown;
}
const searchState: SearchReadState = {
  calls: [],
  result: { q: "needle", groups: [], total: 0 },
  thrown: null,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = searchState;

const mockSources = new Map<string, string>([
  [
    "mock:search",
    `
      const state = globalThis[Symbol.for('openbooks.search-read-test')]
      export async function globalSearch(authz, rawQ) {
        state.calls.push({ authz, rawQ })
        if (state.thrown) throw state.thrown
        return state.result
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([["../search", "mock:search"]]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { searchApplication } = (await import("./search-read.ts")) as typeof import("./search-read.ts");
hooks.deregister();

const CONTEXT = {
  authz: { user: { orgId: "org-1" }, permissions: new Set(["ap.read"]), allowedSubsidiaryIds: null },
} as unknown as Parameters<typeof searchApplication>[0];

function reset(result: SearchReadState["result"] = { q: "needle", groups: [], total: 0 }): void {
  searchState.calls = [];
  searchState.result = result;
  searchState.thrown = null;
}

test("search forwards trimmed q and the caller's authz to the finder", async () => {
  reset();
  await searchApplication(CONTEXT, { q: "  needle  " });
  assert.equal(searchState.calls.length, 1);
  assert.equal(searchState.calls[0]?.rawQ, "needle");
  assert.equal(searchState.calls[0]?.authz, CONTEXT.authz);
});

test("search caps total hits at limit preserving group order", async () => {
  reset({
    q: "needle",
    groups: [
      { type: "contact", labelKey: "contacts", hits: [{ id: "c1" }, { id: "c2" }] },
      { type: "transaction", labelKey: "transactions", hits: [{ id: "t1" }, { id: "t2" }] },
    ],
    total: 4,
  });
  const result = await searchApplication(CONTEXT, { q: "needle", limit: 3 });
  assert.equal(result.total, 3);
  assert.deepEqual(
    result.groups.map((group) => group.hits.map((hit) => hit.id)),
    [["c1", "c2"], ["t1"]],
  );
  assert.equal(searchState.calls[0]?.rawQ, "needle");
});

test("search refuses a blank q instead of returning []", async () => {
  reset();
  await assert.rejects(
    searchApplication(CONTEXT, { q: "   " }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "invalid_input",
  );
  assert.equal(searchState.calls.length, 0);
});

test("search lets the finder's refusal propagate instead of dropping it into []", async () => {
  reset();
  const refusal = Object.assign(new Error("forbidden"), { code: "forbidden", status: 403 });
  searchState.thrown = refusal;
  await assert.rejects(searchApplication(CONTEXT, { q: "needle" }), (error: unknown) => error === refusal);
});
