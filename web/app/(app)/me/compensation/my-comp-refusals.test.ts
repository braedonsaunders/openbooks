import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// OM-08: /me/compensation collapsed two states into one refusal — a viewer
// whose person IS linked but has NO employment saw "no person is linked".
// The seams below stub I/O only (the database transport, feature switches,
// navigation, the server-only marker); translations ride the REAL en
// catalog, and the loader, refusal builder, and engine person reads are
// all real.
const hrmCatalog = JSON.parse(readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8")) as Record<
  string,
  Record<string, unknown>
>;
(globalThis as Record<string, unknown>).__myCompCatalogs = { hrm: hrmCatalog };

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export function useRouter() { return { push() {}, replace() {}, refresh() {} }; }
             export function redirect() { throw new Error("redirect"); }
             export function notFound() { throw new Error("not-found"); }`,
          ),
      };
    }
    if (specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function getTranslations(ns) {
              const catalogs = globalThis.__myCompCatalogs;
              const lookup = (key) => {
                let node = catalogs[ns];
                for (const part of String(key).split(".")) {
                  if (node !== null && typeof node === "object") node = node[part];
                  else return key;
                }
                return typeof node === "string" ? node : key;
              };
              const t = (key, params) => lookup(key);
              t.has = (key) => lookup(key) !== key;
              return t;
            }`,
          ),
      };
    }
    // Transport stub for the whole process: no path in this test may reach
    // a real database. The real module is re-exported untouched and only
    // `db` is overridden; planned pages are consumed in order and anything
    // unexpected reads empty.
    if (specifier === "@openbooks/engine/src/platform/db.ts") {
      // The workspace engine lives at <repo>/engine; every fleet gate runs
      // from the repo root, so the file URL is stable without resolution.
      const target = new URL("file://" + process.cwd() + "/engine/src/platform/db.ts").href;
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export * from ${JSON.stringify(target)};
             export const db = { execute: async () => {
               const plan = globalThis.__myCompDbPlan ?? [];
               return plan.length ? plan.shift() : { rows: [] };
             } };`,
          ),
      };
    }
    // NOTE: web/lib siblings import this as a relative './features', so
    // match the relative spellings as well as the absolute one.
    if (specifier.endsWith("/lib/features") || specifier === "./features" || specifier === "../features") {
      // Re-export the real module and override only the two switches the
      // loader reads; every other export stays the product code.
      const realFeatures = new URL("file://" + process.cwd() + "/web/lib/features.ts").href;
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export * from ${JSON.stringify(realFeatures)};
             export async function isFeatureEnabled() { return true; }
             export async function subsidiaryFeatureEnabled() { return false; }`,
          ),
      };
    }
    return next(specifier, context);
  },
});

const { loadMyCompensation, myCompRefusal } = await import("../../../../lib/hrm/compensation");
const { HrmAuthorizationError } = await import("@openbooks/engine/src/hrm/authorization.ts");

const NOT_LINKED = hrmCatalog.myComp?.notLinked as string;
const NO_EMPLOYMENT = hrmCatalog.myComp?.noEmployment as string;
assert.ok(typeof NOT_LINKED === "string" && NOT_LINKED.length > 0, "the en catalog carries the no-link copy");
assert.ok(typeof NO_EMPLOYMENT === "string" && NO_EMPLOYMENT.length > 0, "the en catalog carries the no-employment copy");
assert.notEqual(NO_EMPLOYMENT, NOT_LINKED, "the two refusals are distinct copy");

function authz() {
  return { user: { id: "user-1", orgId: "org-1" }, permissions: new Set<string>(), allowedSubsidiaryIds: null } as never;
}

function planDb(plan: { rows: unknown[] }[]): void {
  (globalThis as Record<string, unknown>).__myCompDbPlan = [...plan];
}

test("an unlinked login resolves null (the page shows the no-link refusal)", async () => {
  planDb([{ rows: [{ id: "user-1", partyId: null }] }]);
  assert.equal(await loadMyCompensation(authz()), null, "no person linked means no data, never a guessed row");
});

test("a linked login with no employment gets the no-employment refusal, never the no-link copy", async () => {
  // The engine re-reads the person row inside loadOwnEmploymentIds, so the
  // users page is planned twice: person, person, employments.
  const users = { rows: [{ id: "user-1", partyId: "party-1" }] };
  planDb([users, { ...users, rows: [...users.rows] }, { rows: [] }]);
  const data = await loadMyCompensation(authz());
  assert.ok(data !== null, "the loader carries the refusal as page state, not a 404 null");
  assert.equal(data.refusal?.message, NO_EMPLOYMENT, "the remedy names creating the employment");
  assert.notEqual(data.refusal?.message, NOT_LINKED, "nobody is told to link a person that is already linked");
  assert.equal(data.canRequest, false, "nothing can be filed without an employment");
});

test("a missing user row throws instead of collapsing into the no-link refusal", async () => {
  planDb([{ rows: [] }]);
  await assert.rejects(loadMyCompensation(authz()), HrmAuthorizationError, "an unestablished identity is an error, never a refusal");
});

test("the refusal builder names each cause distinctly", async () => {
  planDb([]);
  const linked = await myCompRefusal(authz(), "no-employment");
  assert.equal(linked.refusal?.message, NO_EMPLOYMENT, "explicit cause resolves the employment copy");
  const unlinked = await myCompRefusal(authz());
  assert.equal(unlinked.refusal?.message, NOT_LINKED, "the default stays the link-person copy");
});
