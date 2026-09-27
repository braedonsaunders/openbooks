import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Render proof for the shared gate explanations (/feature-required and
// /access-denied): real pages, real en catalogs, real RouteStateView — only
// identity, feature state and navigation are scripted. A mistyped catalog
// key or a broken prop 500s at runtime where tsc stays silent, so the copy
// itself is asserted in the markup.

const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir, "..", "..", "..");

declare global {
  var __pageAuthz: { user: { orgId: string }; permissions: string[] } | null;
  var __pageCanSetup: boolean;
  var __pageFeatures: Record<string, boolean>;
}

const shellEn = JSON.parse(readFileSync(join(root, "web", "messages", "en", "shell.json"), "utf8")) as Record<
  string,
  Record<string, unknown>
>;
const adminEn = JSON.parse(readFileSync(join(root, "web", "messages", "en", "admin.json"), "utf8")) as Record<
  string,
  unknown
>;
(globalThis as Record<string, unknown>).__i18nBundles = { shell: shellEn, admin: adminEn };

const INTL_MOCK = `
  function walk(ns, key) {
    const parts = String(ns).split('.').concat(String(key).split('.'));
    let node = globalThis.__i18nBundles;
    for (const part of parts) node = node?.[part];
    if (typeof node !== 'string') throw new Error('MISSING_MESSAGE:' + ns + '.' + key);
    return node;
  }
  function fmt(template, params) {
    return String(template).replace(/\\{(\\w+)\\}/g, (m, k) => (params?.[k] ?? m));
  }
  export async function getTranslations(ns) {
    return (key, params) => fmt(walk(ns, key), params);
  }
  export async function getMessages() {
    return globalThis.__i18nBundles;
  }
`;
const LINK_MOCK = `
  export default function Link(p) { return globalThis.React.createElement('a', { href: p.href }, p.children) }
`;
const AUTHZ_MOCK = `
  export async function getAuthz() { return globalThis.__pageAuthz }
  export function can(authz, perm) {
    if (perm === 'admin.setup.manage') return globalThis.__pageCanSetup;
    return authz.permissions.includes(perm);
  }
`;
const FEATURES_MOCK = `
  export const FEATURE_BY_KEY = globalThis.__featureByKey;
  export async function isFeatureEnabled(_orgId, key) { return globalThis.__pageFeatures[key] === true }
`;

const { stubModules } = await import("../../testing/stub-modules");
stubModules({
  navigation: true,
  intl: INTL_MOCK,
  authz: AUTHZ_MOCK,
  features: FEATURES_MOCK,
  extra: {
    "next/link": LINK_MOCK,
  },
});
// Real registry (pure data): the page's known-feature check runs against the
// same keys the gates enforce.
(globalThis as Record<string, unknown>).__featureByKey = (
  await import("@openbooks/engine/src/organization/feature-registry.ts")
).FEATURE_BY_KEY;
const React = await import("react");
Object.assign(globalThis, { React });
(globalThis as Record<string, unknown>).React = React;
const { renderToStaticMarkup } = await import("react-dom/server");

const FeatureRequiredPage = (await import("./feature-required/page.tsx")).default as (
  props: unknown,
) => Promise<React.ReactElement>;
const AccessDeniedPage = (await import("./access-denied/page.tsx")).default as (
  props: unknown,
) => Promise<React.ReactElement>;

function authz(): NonNullable<typeof globalThis.__pageAuthz> {
  return { user: { orgId: "org" }, permissions: [] };
}

async function render(
  Page: (props: unknown) => Promise<React.ReactElement>,
  searchParams: Record<string, string | string[] | undefined>,
): Promise<string> {
  const element = await Page({ searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(element);
}

// -- /feature-required -------------------------------------------------------

test("disabled scripts names the feature and links to Features", async () => {
  globalThis.__pageAuthz = authz();
  globalThis.__pageCanSetup = true;
  globalThis.__pageFeatures = { scripts: false };
  const html = await render(FeatureRequiredPage, { feature: "scripts" });
  assert.match(html, /data-route-state="feature-disabled"/);
  assert.match(html, /Scripts is turned off/);
  assert.match(html, /\/admin\/setup\/features/);
  assert.match(html, /Open Features/);
});

test("without setup authority the page names an administrator instead", async () => {
  globalThis.__pageAuthz = authz();
  globalThis.__pageCanSetup = false;
  globalThis.__pageFeatures = { scripts: false };
  const html = await render(FeatureRequiredPage, { feature: "scripts" });
  assert.match(html, /Scripts is turned off/);
  assert.doesNotMatch(html, /\/admin\/setup\/features/);
  assert.match(html, /ask your administrator/);
});

test("an already-enabled feature says so instead of lying", async () => {
  globalThis.__pageAuthz = authz();
  globalThis.__pageCanSetup = true;
  globalThis.__pageFeatures = { scripts: true };
  const html = await render(FeatureRequiredPage, { feature: "scripts" });
  assert.match(html, /already on/);
});

test("a crafted feature key is honestly nonexistent", async () => {
  globalThis.__pageAuthz = authz();
  globalThis.__pageCanSetup = true;
  globalThis.__pageFeatures = {};
  await assert.rejects(render(FeatureRequiredPage, { feature: "bogus123" }), /NOT_FOUND/);
  await assert.rejects(render(FeatureRequiredPage, {}), /NOT_FOUND/);
});

// -- /access-denied ----------------------------------------------------------

test("a refused permission is named with its remedy", async () => {
  globalThis.__pageAuthz = authz();
  const html = await render(AccessDeniedPage, { permission: "admin.users.manage" });
  assert.match(html, /data-route-state="forbidden"/);
  assert.match(html, /have access/);
  assert.match(html, /admin\.users\.manage/);
  assert.match(html, /ask your administrator/);
});

test("the platform scope gets operator copy, not a permission key", async () => {
  globalThis.__pageAuthz = authz();
  const html = await render(AccessDeniedPage, { scope: "platform" });
  assert.match(html, /platform operators/);
});

test("a bare visit with no context is honestly nonexistent", async () => {
  globalThis.__pageAuthz = authz();
  await assert.rejects(render(AccessDeniedPage, {}), /NOT_FOUND/);
});
