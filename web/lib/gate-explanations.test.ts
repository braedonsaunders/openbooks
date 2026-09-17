import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Consolidated shared behavior for every "exists but gated" refusal:
// F-t13-002 (/admin/scripts 404), F-t13-003 (/api-docs 404),
// F-t13-008 (/platform/* silent home bounce), F-t12-001 (forbidden admin
// route silent home bounce), F-t03-012 (compliance setup-redirect vs 404).
// A gated route names its feature or permission on a real explanation page;
// only a genuinely nonexistent route 404s.

declare global {
  var __gateUser: {
    id: string;
    email: string;
    name: string;
    roles: ReadonlyArray<{ key: string; name: string }>;
    orgId: string;
    envKind: "production";
    productionOrgId: string;
    isSuperAdmin: boolean;
    homeUserId: string;
    homeOrgId: string;
  } | null;
  var __gateFeatures: Record<string, boolean>;
}

const NAV_MOCK = `
  export function redirect(url) { throw new Error('REDIRECT:' + url) }
  export function notFound() { throw new Error('NOT_FOUND') }
`;
const AUTH_MOCK = `
  export async function currentUser() { return globalThis.__gateUser }
`;
const SUBSIDIARIES_MOCK = `
  export async function allowedSubsidiaryIds() { return null }
`;
const AVAILABILITY_MOCK = `
  export async function extensionPermissionAvailability() { return { active: [], inactive: [] } }
  export function denyInactiveExtensionPermissions(set) { return set }
`;
const DB_MOCK = `
  export const db = { execute: async () => ({ rows: [] }) }
  export async function withBypassContext(fn) { return fn() }
  export async function withOrgContext(_org, fn) { return fn() }
`;
const FEATURES_MOCK = `
  export async function isFeatureEnabled(_orgId, key) { return globalThis.__gateFeatures[key] !== false }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "next/navigation") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript," + encodeURIComponent(NAV_MOCK) };
    }
    if (
      (specifier === "./auth" || specifier === "./subsidiaries") &&
      context.parentURL?.includes("lib/authz.ts")
    ) {
      const source = specifier === "./auth" ? AUTH_MOCK : SUBSIDIARIES_MOCK;
      return { shortCircuit: true, format: "module", url: "data:text/javascript," + encodeURIComponent(source) };
    }
    if (specifier === "@openbooks/engine/src/extensions/permission-availability.ts") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript," + encodeURIComponent(AVAILABILITY_MOCK) };
    }
    if (specifier === "@openbooks/engine/src/db.ts") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript," + encodeURIComponent(DB_MOCK) };
    }
    if (
      specifier === "./features" &&
      (context.parentURL?.includes("lib/feature-gates.ts") ||
        context.parentURL?.includes("lib/compliance.ts"))
    ) {
      return { shortCircuit: true, format: "module", url: "data:text/javascript," + encodeURIComponent(FEATURES_MOCK) };
    }
    return nextResolve(specifier, context);
  },
});

const { featureRequiredHref, parseFeatureRequiredParam, accessDeniedHref } =
  await import("./gate-targets.ts");
const { requirePermission } = await import("./authz.ts");
const { requireSuperAdmin } = await import("./super-admin.ts");
const { requireFeatureEnabled } = await import("./feature-gates.ts");
const { requireComplianceFeature, requireLienWaiverFeature } = await import("./compliance.ts");
hooks.deregister();

function fakeUser(isSuperAdmin: boolean): NonNullable<typeof globalThis.__gateUser> {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    email: "gate-probe@example.test",
    name: "Gate Probe",
    roles: [],
    orgId: "00000000-0000-4000-8000-000000000002",
    envKind: "production",
    productionOrgId: "00000000-0000-4000-8000-000000000002",
    isSuperAdmin,
    homeUserId: "00000000-0000-4000-8000-000000000001",
    homeOrgId: "00000000-0000-4000-8000-000000000002",
  };
}

async function redirectUrl(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    const match = /^REDIRECT:(.*)$/.exec((e as Error).message);
    if (match) return match[1]!;
    throw e;
  }
  throw new Error("expected a redirect, the gate resolved");
}

// --- pure destinations -------------------------------------------------------

test("feature-required href names the feature key", () => {
  assert.equal(featureRequiredHref("scripts"), "/feature-required?feature=scripts");
  assert.equal(
    featureRequiredHref("subcontractorCompliance"),
    "/feature-required?feature=subcontractorCompliance",
  );
});

test("feature param parsing accepts registry-shaped keys only", () => {
  assert.equal(parseFeatureRequiredParam("scripts"), "scripts");
  assert.equal(parseFeatureRequiredParam(["scripts"]), "scripts");
  assert.equal(parseFeatureRequiredParam(undefined), null);
  assert.equal(parseFeatureRequiredParam(""), null);
  assert.equal(parseFeatureRequiredParam("../admin"), null);
  assert.equal(parseFeatureRequiredParam("/admin/scripts"), null);
});

test("access-denied href carries the refusal context", () => {
  assert.equal(
    accessDeniedHref({ permission: "admin.users.manage" }),
    "/access-denied?permission=admin.users.manage",
  );
  assert.equal(accessDeniedHref({ scope: "platform" }), "/access-denied?scope=platform");
  assert.equal(accessDeniedHref(), "/access-denied");
});

// --- gate wiring (real gates, mocked identity/feature state) ----------------

test("F-t12-001: denied permission explains instead of bouncing home", async () => {
  globalThis.__gateUser = fakeUser(false);
  const url = await redirectUrl(() => requirePermission("admin.users.manage"));
  assert.equal(url, "/access-denied?permission=admin.users.manage");
  assert.ok(!url.endsWith("/"), "must not be the bare home bounce");
});

test("allowed permission still resolves (super admin holds every key)", async () => {
  globalThis.__gateUser = fakeUser(true);
  const authz = await requirePermission("admin.users.manage");
  assert.equal(authz.user.id, fakeUser(true).id);
});

test("F-t13-008: platform gate names the operator scope", async () => {
  globalThis.__gateUser = fakeUser(false);
  const url = await redirectUrl(() => requireSuperAdmin());
  assert.equal(url, "/access-denied?scope=platform");
});

test("super admin still passes the platform gate", async () => {
  globalThis.__gateUser = fakeUser(true);
  const authz = await requireSuperAdmin();
  assert.equal(authz.user.isSuperAdmin, true);
});

test("F-t13-002/003: disabled feature explains instead of 404ing", async () => {
  globalThis.__gateFeatures = { scripts: false, apiAccess: false };
  assert.equal(
    await redirectUrl(() => requireFeatureEnabled("org", "scripts")),
    "/feature-required?feature=scripts",
  );
  assert.equal(
    await redirectUrl(() => requireFeatureEnabled("org", "apiAccess")),
    "/feature-required?feature=apiAccess",
  );
});

test("enabled feature still resolves", async () => {
  globalThis.__gateFeatures = { scripts: true };
  assert.equal(await requireFeatureEnabled("org", "scripts"), undefined);
});

test("F-t03-012: compliance gates name the feature that is actually off", async () => {
  globalThis.__gateFeatures = { subcontractorCompliance: false, projects: true };
  assert.equal(
    await redirectUrl(() => requireComplianceFeature("org")),
    "/feature-required?feature=subcontractorCompliance",
  );
  globalThis.__gateFeatures = { subcontractorCompliance: true, projects: false };
  assert.equal(
    await redirectUrl(() => requireLienWaiverFeature("org")),
    "/feature-required?feature=projects",
  );
  globalThis.__gateFeatures = { subcontractorCompliance: true, projects: true };
  assert.equal(await requireComplianceFeature("org"), undefined);
  assert.equal(await requireLienWaiverFeature("org"), undefined);
});

// --- the named routes funnel through the shared gates ------------------------

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(webDir, path), "utf8");

test("scripts, api-docs, subcontracts and lien-waivers share one gate", () => {
  assert.match(read("app/(app)/admin/scripts/view.ts"), /requireFeatureEnabled\(authz\.user\.orgId, 'scripts'\)/);
  assert.match(read("app/(app)/api-docs/view.ts"), /requireFeatureEnabled\(authz\.user\.orgId, 'apiAccess'\)/);
  assert.match(read("app/(app)/admin/api-keys/view.ts"), /requireFeatureEnabled\(authz\.user\.orgId, 'apiAccess'\)/);
  assert.match(read("app/(app)/subcontracts/layout.tsx"), /requireFeatureEnabled\(authz\.user\.orgId, 'subcontracts'\)/);
  assert.match(
    read("app/(app)/compliance/lien-waivers/view.ts"),
    /requireFeatureEnabled\(authz\.user\.orgId, 'subcontractorCompliance'\)/,
  );
  assert.match(read("app/(app)/compliance/view.ts"), /requireComplianceFeature\(orgId\)/);
  assert.match(read("app/(app)/platform/layout.tsx"), /requireSuperAdmin\(\)/);
});

test("continuous-close redirect carries landing context (F-t13-007)", () => {
  assert.match(
    read("app/(app)/continuous-close/page.tsx"),
    /params\.set\('from', 'continuous-close'\)/,
  );
});

// --- catalog: explanation copy in all 7 locales -------------------------------

const messagesDir = join(webDir, "messages");
const shellCatalog = (locale: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(messagesDir, locale, "shell.json"), "utf8")) as Record<string, unknown>;
const KEYS = [
  "featureOffTitle",
  "featureOffDescription",
  "featureOnTitle",
  "featureOnDescription",
  "turnOnFeature",
  "askAdministrator",
  "deniedTitle",
  "deniedDescription",
  "operatorDescription",
];
const english = shellCatalog("en").routeState as Record<string, string>;
for (const key of KEYS) {
  assert.ok(english?.[key], `en shell.routeState must define ${key}`);
}
for (const locale of ["de", "es", "fr", "ja", "pt-BR", "zh"]) {
  test(`gate explanations are translated in ${locale}`, () => {
    const routeState = shellCatalog(locale).routeState as Record<string, string> | undefined;
    assert.ok(routeState, `${locale}/shell.json must define routeState`);
    for (const key of KEYS) {
      const value: unknown = routeState[key];
      assert.equal(typeof value, "string", `${locale} routeState.${key} must be a string`);
      assert.ok((value as string).trim().length > 0, `${locale} routeState.${key} must not be empty`);
      assert.notEqual(value, english[key], `${locale} routeState.${key} must not be English`);
    }
  });
}
