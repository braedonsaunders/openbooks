import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// F-t12-018 residual: the es bottom-nav AR/AP tabs both truncated to
// "Cuentas por…" — indistinguishable. Modules now carry a per-locale short
// label (nav.modulesShort) that the mobile tab bar prefers; locales and
// modules without one render exactly as before.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  return next(specifier, context);
} });

const { navPathname, resolveModuleShortLabel } = await import("./resolve.ts");

const nav = (locale: string): { modules: Record<string, string>; modulesShort?: Record<string, string> } =>
  JSON.parse(readFileSync(new URL(`../../messages/${locale}/nav.json`, import.meta.url), "utf8"));

test("F-t12-018: AR/AP shorts exist per locale and stay distinguishable", () => {
  for (const locale of ["en", "es", "fr"]) {
    const { modules, modulesShort } = nav(locale);
    assert.ok(modulesShort?.ap && modulesShort?.ar, `${locale} ships AR/AP shorts`);
    assert.notEqual(modulesShort.ap, modulesShort.ar, `${locale} shorts are distinguishable`);
    assert.ok(
      (modulesShort.ap as string).length < (modules.ap as string).length &&
        (modulesShort.ar as string).length < (modules.ar as string).length,
      `${locale} shorts are shorter than the full labels`,
    );
  }
  // The reported collision is gone: the two es shorts share no truncating prefix.
  const es = nav("es").modulesShort!;
  assert.ok(!es.ap!.startsWith("Cuentas por") && !es.ar!.startsWith("Cuentas por"), "es shorts drop the colliding prefix");
});

test("F-t12-018: short resolution falls back without changing existing labels", () => {
  const t = (key: string): string => {
    const table: Record<string, string> = {
      "modulesShort.ap": "Por pagar",
      "modulesShort.ar": "Por cobrar",
      "modules.ap": "Cuentas por pagar",
    };
    return table[key] ?? "";
  };
  assert.equal(resolveModuleShortLabel(t, "ar", "Cuentas por cobrar", true), "Por cobrar");
  assert.equal(
    resolveModuleShortLabel(t, "dashboard", "Panel", true),
    "Panel",
    "modules without a short keep the full label",
  );
  assert.equal(
    resolveModuleShortLabel(t, "ap", "Mis cuentas", false),
    "Mis cuentas",
    "tenant renames keep theirs verbatim",
  );
});

test("F-t12-018: missing shorts fall back even when the translator echoes keys", () => {
  const full = "Accounts Receivable";
  // next-intl answers a missing key with the key path itself (truthy), which
  // a bare `||` fallback would print raw (observed: "nav.module…" tabs).
  const echo = (key: string) => key;
  const namespacedEcho = (key: string) => `nav.${key}`;
  const throwing = (): string => {
    throw new Error("MISSING_MESSAGE");
  };
  assert.equal(resolveModuleShortLabel(echo, "dashboard", full, true), full, "bare echo falls back");
  assert.equal(resolveModuleShortLabel(namespacedEcho, "dashboard", full, true), full, "namespaced echo falls back");
  assert.equal(resolveModuleShortLabel(throwing, "dashboard", full, true), full, "throws fall back");
  // The `has` gate skips the lookup silently: t must not even be called.
  let called = 0;
  const counting = (): string => {
    called += 1;
    return "Por cobrar";
  };
  assert.equal(
    resolveModuleShortLabel(counting, "ar", "Cuentas por cobrar", true, () => false),
    "Cuentas por cobrar",
    "has=false keeps the full label",
  );
  assert.equal(called, 0, "absent shorts never reach the translator, so no MISSING_MESSAGE is logged");
  assert.equal(
    resolveModuleShortLabel(counting, "ar", "Cuentas por cobrar", true, () => true),
    "Por cobrar",
    "has=true resolves the short",
  );
  assert.equal(called, 1, "present shorts resolve with a single lookup");
});

test("navPathname strips query and fragment so gating sees the module path", () => {
  assert.equal(navPathname("/projects?tab=jobs"), "/projects");
  assert.equal(navPathname("/projects#summary"), "/projects");
  assert.equal(navPathname("/projects/jobs?tab=open#top"), "/projects/jobs");
  assert.equal(navPathname("/projects"), "/projects");
  assert.equal(navPathname("https://example.com/projects?tab=jobs"), "https://example.com/projects?tab=jobs");
});
