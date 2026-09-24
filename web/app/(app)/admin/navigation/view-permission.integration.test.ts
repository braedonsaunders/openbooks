import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Loader regression for /admin/navigation: the page edits organization
// navigation, so its loader must demand an admin key — the catalogue/hub key
// `admin.nav.manage`, keeping the pre-existing `admin.customization.manage`
// path working. Auth and navigation seams are scripted; Postgres is live.
const stateKey = Symbol.for("openbooks.nav-loader-permission-test");
interface LoaderState {
  user: { orgId: string; id: string } | null;
  permissions: Set<string>;
}
const loaderState: LoaderState = { user: null, permissions: new Set() };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = loaderState;

const mocks = new Map<string, string>([
  ["mock:nav-loader-auth", `
    const state = globalThis[Symbol.for('openbooks.nav-loader-permission-test')]
    export async function currentUser() { return state.user }
  `],
  ["mock:nav-loader-authz", `
    import { permissionSetCovers } from '@openbooks/engine/src/organization/permissions.ts';
    const state = globalThis[Symbol.for('openbooks.nav-loader-permission-test')]
    export async function getAuthz() {
      if (!state.user) return null
      return { user: state.user, permissions: state.permissions, allowedSubsidiaryIds: null }
    }
    export function can(authz, perm) { return permissionSetCovers(authz.permissions, perm) }
  `],
  ["mock:nav-loader-navigation", `
    export function redirect(to) { throw new Error('NEXT_REDIRECT:' + to) }
  `],
  ["mock:nav-loader-intl", `
    export async function getTranslations() { return (key) => key }
  `],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (context.parentURL?.includes("/admin/navigation/view.ts")) {
      if (specifier === "../../../../lib/auth") return { url: "mock:nav-loader-auth", shortCircuit: true };
      if (specifier === "../../../../lib/authz") return { url: "mock:nav-loader-authz", shortCircuit: true };
      if (specifier === "next/navigation") return { url: "mock:nav-loader-navigation", shortCircuit: true };
      if (specifier === "next-intl/server") return { url: "mock:nav-loader-intl", shortCircuit: true };
    }
    if (context.parentURL?.startsWith("mock:") && (specifier.startsWith("@openbooks/") || specifier === "next/server")) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      const testUrl = import.meta.url;
      const webRoot = testUrl.slice(0, testUrl.indexOf("/web/") + 5);
      return nextResolve(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mocks.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const viewUrl = "./view.ts?nav-loader-permission-test";
const { loadNavigationAdmin } = (await import(viewUrl)) as typeof import("./view.ts");
hooks.deregister();

const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");

async function freshOrgWithUser(): Promise<{ orgId: string; userId: string }> {
  const org = await withBypassContext(() => createScratchOrg());
  const userId = await withBypassContext(() => createScratchUser(org.orgId, "Nav Loader", "nav_loader_role"));
  return { orgId: org.orgId, userId };
}

function asUser(orgId: string, userId: string, permissions: string[]): void {
  loaderState.user = { orgId, id: userId };
  loaderState.permissions = new Set(permissions);
}

test("the nav loader redirects an unauthenticated visitor to login", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  await freshOrgWithUser().then(async ({ orgId }) => {
    try {
      loaderState.user = null;
      await assert.rejects(() => loadNavigationAdmin(), /NEXT_REDIRECT:\/login/);
    } finally {
      await dropScratchOrgReporting(orgId);
    }
  });
});

test("the nav loader names the refusal for a user with neither admin key", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId, userId } = await freshOrgWithUser();
  try {
    asUser(orgId, userId, ["reports.read"]);
    await assert.rejects(() => loadNavigationAdmin(), /NEXT_REDIRECT:\/access-denied\?permission=admin\.nav\.manage/);
  } finally {
    await dropScratchOrgReporting(orgId);
  }
});

test("the nav loader serves a holder of admin.nav.manage", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId, userId } = await freshOrgWithUser();
  try {
    asUser(orgId, userId, ["admin.nav.manage"]);
    const data = await loadNavigationAdmin();
    assert.ok(data);
    assert.ok(data.initial);
    assert.ok(Array.isArray(data.apps));
  } finally {
    await dropScratchOrgReporting(orgId);
  }
});

test("the nav loader keeps serving a holder of admin.customization.manage", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const { orgId, userId } = await freshOrgWithUser();
  try {
    asUser(orgId, userId, ["admin.customization.manage"]);
    const data = await loadNavigationAdmin();
    assert.ok(data);
  } finally {
    await dropScratchOrgReporting(orgId);
  }
});
