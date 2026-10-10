import { registerHooks } from "node:module";

/**
 * One shared module-stub helper for web tests.
 *
 * Component and page tests run outside the bundler, so every test that
 * renders through `next/navigation`, reads server-side translations, checks
 * the caller's permission, or reads feature gates needs the same small set of
 * process-boundary doubles. They used to be hand-written `data:` modules in a
 * per-file `registerHooks` call; the shapes drifted apart while the behavior
 * under test stayed the same.
 *
 * `stubModules` registers one resolve hook covering the selected boundaries. An
 * option left out (or passed `false`) stubs nothing: the call only covers
 * what the test names, so it never shadows the test's own hook or replaces
 * a module the test expects to be real. Pass `true` for the most common
 * stub used across the suite, or a stricter shape (a source string, or the
 * pathname/permissions/enabled knobs) when the test needs different
 * behavior. A `database` source intercepts the native platform database through
 * both its public alias and its resolved relative imports, without replacing
 * domain or validation modules. Other boundaries (a per-test router script,
 * for example) stay in the test through `extra` or its own hook.
 *
 * Every source here, `extra` included, is served as a `data:` URL module.
 * A `data:` URL has no base path, so an `extra` source must be
 * self-contained: `node:` builtins resolve, but a bare package import (a
 * stub that itself imports from `next-intl`, for example) fails with
 * `ERR_UNSUPPORTED_RESOLVE_REQUEST`, as does any relative import. A stub
 * that must import another package keeps its own hook with a resolvable
 * base instead of going through `extra`.
 *
 * Call this before importing the module under test: module resolution hooks
 * only affect imports that happen after they are registered.
 */

export interface NavigationStubOptions {
  /** Value returned by the `usePathname` stub. Defaults to "/". */
  pathname?: string;
  /** Full replacement for the `useRouter` export. */
  routerSource?: string;
  /** Full replacement module source. Defaults to the shared mock below. */
  source?: string;
}

export interface AuthzStubOptions {
  /**
   * Permissions the stubbed operator holds. Defaults to allow-all (`*`),
   * which is what render-through tests need; pass an explicit list for a
   * scoped operator.
   */
  permissions?: string[];
  /** Full replacement module source. Defaults to the shared mock below. */
  source?: string;
}

export interface FeaturesStubOptions {
  /**
   * Feature keys reported as enabled. Defaults to every key enabled, which
   * is what render-through tests need; pass an explicit list to gate.
   */
  enabled?: string[];
  /** Full replacement module source. Defaults to the shared mock below. */
  source?: string;
}

export interface StubModulesOptions {
  /** Database boundary source, including native readers' relative imports. */
  database?: string;
  navigation?: boolean | string | NavigationStubOptions;
  intl?: boolean | string;
  authz?: boolean | string | AuthzStubOptions;
  features?: boolean | string | FeaturesStubOptions;
  /**
   * Additional exact-specifier to module-source stubs, same hook. Sources
   * must be self-contained (see above): no bare-package or relative imports.
   */
  extra?: Record<string, string>;
}

const NAVIGATION_DEFAULT_PATH = "/";
const PLATFORM_DB_URL = new URL("../../engine/src/platform/db.ts", import.meta.url).href;

function navigationSource(pathname: string, routerSource?: string): string {
  const safe = pathname.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return (
    (routerSource ?? `export function useRouter(){return{push(){},refresh(){},replace(){},back(){},forward(){}}}`) +
    `export function usePathname(){return '${safe}'}` +
    `export function useSearchParams(){return new URLSearchParams()}` +
    `export function redirect(url){throw new Error('REDIRECT:'+url)}` +
    `export function notFound(){throw new Error('NOT_FOUND')}`
  );
}

const INTL_SERVER_DEFAULT =
  // Key-echo translator with no catalog: `has` reports every key missing.
  `export async function getTranslations(){const t=(key)=>key;t.has=()=>false;return t}` +
  `export async function getMessages(){return {}}` +
  `export async function getLocale(){return 'en'}`;

function authzSource(permissions: string[] | null): string {
  const granted =
    permissions === null ? `new Set(['*'])` : `new Set(${JSON.stringify(permissions)})`;
  return (
    `export async function getAuthz(){return { permissions: ${granted} }}` +
    `export function can(authz,perm){const p=authz?.permissions;if(!p)return false;` +
    `if(typeof p.has==='function')return p.has('*')||p.has(perm);return p.includes(perm)}` +
    `export function assertCan(){}` +
    `export async function requirePermission(){return getAuthz()}` +
    `export async function guardPermission(){return getAuthz()}` +
    `export function guardSubsidiaryScope(){return null}` +
    `export function guardUnrestrictedScope(){return null}` +
    `export async function guardRootSubsidiaryScope(){return null}` +
    `export function subsidiariesInScope(){return []}`
  );
}

function featuresSource(enabled: string[] | null): string {
  const check =
    enabled === null
      ? `return true`
      : `return ${JSON.stringify(enabled)}.includes(key)`;
  return (
    `export async function orgFeatureState(){return {}}` +
    `export async function isFeatureEnabled(_orgId,key){${check}}` +
    `export async function subsidiaryFeatureEnabled(){return false}` +
    `export async function resolvedFeatureState(){return {}}` +
    `export function hiddenNavModules(){return new Set()}` +
    `export async function requireFeatureEnabled(){}` +
    `export async function featureDisableBlocked(){return false}`
  );
}

function virtual(source: string): { shortCircuit: boolean; url: string } {
  return {
    shortCircuit: true,
    url: "data:text/javascript," + encodeURIComponent(source),
  };
}

/** Add the shared authorization predicate used by route test doubles. */
export function withAuthzTestSurface(source: string): string {
  const additions: string[] = [];
  const hasExport = (name: string): boolean =>
    new RegExp(`\\bexport\\s+(?:(?:async)\\s+)?(?:function|const|let|var|class)\\s+${name}\\b`).test(source);
  if (!hasExport("can")) {
    additions.push(`export function can(authz, permission) { const permissions = authz?.permissions; return Boolean(permissions && (permissions.has?.('*') || permissions.has?.(permission) || permissions.includes?.('*') || permissions.includes?.(permission))); }`);
  }
  if (!hasExport("getAuthz") && hasExport("guardPermission")) {
    additions.push(`export async function getAuthz() { return guardPermission(); }`);
  }
  return additions.length === 0 ? source : `${source}\n${additions.join("\n")}`;
}

/** Add the transaction helpers shared by platform database test doubles. */
export function withPlatformDbTestSurface(source: string): string {
  const hasExport = (name: string): boolean =>
    new RegExp(`\\bexport\\s+(?:(?:async)\\s+)?(?:function|const|let|var|class)\\s+${name}\\b`).test(source);
  const sharedExports: Array<[string, string]> = [
    ["inExecutorTransaction", `export async function inExecutorTransaction(executor, fn) { return fn(executor) }`],
    ["ambientTenantOrgId", `export function ambientTenantOrgId() { return null }`],
    ["ambientBypassWithoutTransaction", `export function ambientBypassWithoutTransaction() { return false }`],
    ["withBypass", `export async function withBypass(fn) { return fn() }`],
    ["withBypassContext", `export async function withBypassContext(fn) { return fn() }`],
    ["currentRequestOrgResolver", `export function currentRequestOrgResolver() { return null }`],
    ["registerRequestOrgResolver", `export function registerRequestOrgResolver() {}`],
  ];
  const additions = sharedExports
    .filter(([name]) => !hasExport(name))
    .map(([, declaration]) => declaration);
  return additions.length === 0 ? source : `${source}\n${additions.join("\n")}`;
}

function isAuthzSpecifier(specifier: string): boolean {
  // Mirrors the conditions the suite's own hooks used: the house alias or a
  // path ending in /lib/authz. Bare relative spellings (`../authz`) and
  // explicit extensions are NOT covered on purpose — a test that stubs those
  // passes the exact specifier through `extra`, so this default can never
  // hijack an edge the test expected to be real.
  return specifier === "@/lib/authz" || specifier.endsWith("/lib/authz");
}

function isFeaturesSpecifier(specifier: string): boolean {
  // Same scoping rule as above: only the /lib/-suffixed family. Bare
  // relative spellings (`../features`) go through `extra` exactly.
  return (
    specifier.endsWith("/lib/features") || specifier.endsWith("/lib/feature-gates")
  );
}

function resolveOptionSource(
  option: boolean | string | { source?: string } | undefined,
  fallback: () => string,
): string | null {
  if (option === undefined || option === false) return null;
  if (option === true) return fallback();
  if (typeof option === "string") return option;
  if (typeof option.source === "string") return option.source;
  return fallback();
}

export function stubModules(options: StubModulesOptions = {}): void {
  let navigation: string | null = null;
  if (options.navigation !== undefined && options.navigation !== false) {
    if (options.navigation === true) {
      navigation = navigationSource(NAVIGATION_DEFAULT_PATH);
    } else if (typeof options.navigation === "string") {
      navigation = options.navigation;
    } else if (options.navigation.source !== undefined) {
      navigation = options.navigation.source;
    } else {
      navigation = navigationSource(
        options.navigation.pathname ?? NAVIGATION_DEFAULT_PATH,
        options.navigation.routerSource,
      );
    }
  }
  const intl = resolveOptionSource(options.intl, () => INTL_SERVER_DEFAULT);
  let authz: string | null = null;
  if (options.authz !== undefined && options.authz !== false) {
    if (options.authz === true) authz = authzSource(null);
    else if (typeof options.authz === "string") authz = options.authz;
    else if (options.authz.source !== undefined) authz = options.authz.source;
    else authz = authzSource(options.authz.permissions ?? null);
  }
  let features: string | null = null;
  if (options.features !== undefined && options.features !== false) {
    if (options.features === true) features = featuresSource(null);
    else if (typeof options.features === "string") features = options.features;
    else if (options.features.source !== undefined) {
      features = options.features.source;
    } else features = featuresSource(options.features.enabled ?? null);
  }
  const extra = options.extra ?? {};
  const platformDbOverride = options.database;

  registerHooks({
    resolve(specifier, context, next) {
      if (platformDbOverride !== undefined && specifier === "@openbooks/engine/src/platform/db.ts") {
        return virtual(platformDbOverride);
      }
      if (navigation !== null && specifier === "next/navigation") {
        return virtual(navigation);
      }
      if (intl !== null && specifier === "next-intl/server") {
        return virtual(intl);
      }
      if (authz !== null && isAuthzSpecifier(specifier)) {
        return virtual(authz);
      }
      if (features !== null && isFeaturesSpecifier(specifier)) {
        return virtual(features);
      }
      const override = extra[specifier];
      if (override !== undefined) {
        return virtual(override);
      }
      const resolved = next(specifier, context);
      // A declared database double also owns native readers' relative imports
      // of that same module. Validation and domain modules stay real.
      if (platformDbOverride !== undefined && resolved.url === PLATFORM_DB_URL
        && context.parentURL !== virtual(platformDbOverride).url) {
        return virtual(platformDbOverride);
      }
      return resolved;
    },
  });
}
