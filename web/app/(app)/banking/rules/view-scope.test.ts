import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const state = { queries: 0 };
Object.assign(globalThis, { __bankRuleViewScopeState: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  format: "module" as const,
  url: `data:text/javascript,${encodeURIComponent(source)}`,
});
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {};");
    if (specifier === "next/navigation") return virtual(`export function forbidden() { throw Object.assign(new Error("forbidden"), { status: 403 }); }`);
    if (specifier === "next-intl/server") return virtual(`export async function getTranslations() { return (key) => key; }`);
    if (specifier === "@braedonsaunders/appkit-viewspec") return virtual(`
      export const page = () => ({}); export const pageHeader = () => ({});
      export const ref = () => ({}); export const widget = () => ({}); export const widgetBlock = () => ({});
    `);
    if (specifier === "@openbooks/engine/src/platform/db.ts") return virtual(`
      const state = globalThis.__bankRuleViewScopeState;
      export const db = { execute: async () => { state.queries += 1; return { rows: [] }; } };
      export async function withBypassContext(work) { return work(); }
      export async function ambientTenantOrgId() { return null; }
    `);
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/banking/rules/view")) {
      return virtual(`
        export async function requirePermission() {
          return { user: { orgId: "org-1", id: "reader-1" }, allowedSubsidiaryIds: new Set(["subsidiary-a"]) };
        }
        export function guardUnrestrictedScope(authz) {
          return authz.allowedSubsidiaryIds === null
            ? null
            : Response.json({ error: "requires unrestricted subsidiary access" }, { status: 403 });
        }
      `);
    }
    return next(specifier, context);
  },
});

const { loadBankingRules } = await import("./view.ts");
hooks.deregister();

test("restricted banking reader is refused before config pickers or a seed line are loaded", async () => {
  state.queries = 0;

  await assert.rejects(
    loadBankingRules({ rule: "new", fromLine: "11111111-1111-4111-8111-111111111111" }),
    (error: Error & { status?: number }) => error.status === 403,
  );
  assert.equal(state.queries, 0, "restricted requests perform no picker, rule, or seed-line reads");
});
