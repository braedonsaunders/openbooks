import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const state = { orgId: "org", grants: new Set<string>(["items.read"]) };
Object.assign(globalThis, { __inventoryViewPermissions: state });
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next-intl/server") return virtual("export async function getTranslations() { return (key) => key }");
    if (specifier === "@braedonsaunders/appkit-viewspec") return virtual("export const page = () => ({}); export const pageHeader = () => ({}); export const ref = () => () => ({}); export const widget = () => ({}); export const widgetBlock = () => ({})");
    if (specifier === "../../../lib/authz") return virtual(`
      export async function requirePermission() {
        const s = globalThis.__inventoryViewPermissions;
        return { user: { orgId: s.orgId, id: "actor" }, permissions: s.grants, allowedSubsidiaryIds: null };
      }
      // Exact-match check: the cases below use concrete grants, so the
      // production wildcard semantics change nothing about them.
      export function can(authz, perm) { return authz.permissions.has(perm) }
    `);
    if (specifier === "../../../lib/feature-gates") return virtual("export async function requireFeatureEnabled() { return undefined }");
    return next(specifier, context);
  },
});

const { loadInventory } = await import("./view.ts");

async function showsNewMovement(grants: string[]): Promise<unknown> {
  state.grants = new Set(grants);
  return (await loadInventory({})).showNewMovement;
}

test("the New-movement button follows the posting grant, not the manage grant", async () => {
  // An items.post-only user sees and can open the drawer; posting needs
  // items.post while the button used to demand items.manage.
  assert.equal(await showsNewMovement(["items.read", "items.post"]), true);
  // An items.manage-only user must not see a drawer they cannot submit —
  // the route would 403 on post.
  assert.equal(await showsNewMovement(["items.read", "items.manage"]), false);
  assert.equal(await showsNewMovement(["items.read"]), false);
  assert.equal(await showsNewMovement(["items.read", "items.reverse"]), false);
});
