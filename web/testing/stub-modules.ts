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
 * `stubModules` registers one resolve hook covering the four shapes. Each
 * option defaults to the most common stub used across the suite; a test that
 * needs a different behavior passes it in rather than writing a new hook.
 * Anything the four shapes do not cover (a capturing database stand-in, a
 * per-test router script) stays in the test through `extra` or its own hook.
 *
 * Call this before importing the module under test: module resolution hooks
 * only affect imports that happen after they are registered.
 */

export interface NavigationStubOptions {
  /** Value returned by the `usePathname` stub. Defaults to "/". */
  pathname?: string;
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
  navigation?: false | string | NavigationStubOptions;
  intl?: false | string;
  authz?: false | string | AuthzStubOptions;
  features?: false | string | FeaturesStubOptions;
  /** Additional exact-specifier to module-source stubs, same hook. */
  extra?: Record<string, string>;
}

const NAVIGATION_DEFAULT_PATH = "/";

function navigationSource(pathname: string): string {
  const safe = pathname.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return (
    `export function useRouter(){return{push(){},refresh(){},replace(){},back(){},forward(){}}}` +
    `export function usePathname(){return '${safe}'}` +
    `export function useSearchParams(){return new URLSearchParams()}` +
    `export function redirect(url){throw new Error('REDIRECT:'+url)}` +
    `export function notFound(){throw new Error('NOT_FOUND')}`
  );
}

const INTL_SERVER_DEFAULT =
  `export async function getTranslations(){return (key)=>key}` +
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

function stripExtension(specifier: string): string {
  return specifier.replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
}

function isAuthzSpecifier(specifier: string): boolean {
  const base = stripExtension(specifier);
  return (
    base === "@/lib/authz" ||
    base.endsWith("/lib/authz") ||
    /(^|\/)(\.\.?\/)+authz$/.test(base)
  );
}

function isFeaturesSpecifier(specifier: string): boolean {
  const base = stripExtension(specifier);
  return (
    base.endsWith("/lib/features") ||
    base.endsWith("/lib/feature-gates") ||
    /(^|\/)(\.\.?\/)+features?$/.test(base) ||
    /(^|\/)(\.\.?\/)+feature-gates$/.test(base)
  );
}

function resolveOptionSource(
  option: false | string | { source?: string } | undefined,
  fallback: () => string,
): string | null {
  if (option === false) return null;
  if (typeof option === "string") return option;
  if (option && typeof option.source === "string") return option.source;
  if (option === undefined) return fallback();
  return fallback();
}

export function stubModules(options: StubModulesOptions = {}): void {
  let navigation: string | null = null;
  if (options.navigation !== false) {
    if (typeof options.navigation === "string") {
      navigation = options.navigation;
    } else if (options.navigation?.source !== undefined) {
      navigation = options.navigation.source;
    } else {
      navigation = navigationSource(
        options.navigation?.pathname ?? NAVIGATION_DEFAULT_PATH,
      );
    }
  }
  const intl = resolveOptionSource(options.intl, () => INTL_SERVER_DEFAULT);
  let authz: string | null = null;
  if (options.authz !== false) {
    if (typeof options.authz === "string") authz = options.authz;
    else if (options.authz?.source !== undefined) authz = options.authz.source;
    else authz = authzSource(options?.authz?.permissions ?? null);
  }
  let features: string | null = null;
  if (options.features !== false) {
    if (typeof options.features === "string") features = options.features;
    else if (options.features?.source !== undefined) {
      features = options.features.source;
    } else features = featuresSource(options?.features?.enabled ?? null);
  }
  const extra = options.extra ?? {};

  registerHooks({
    resolve(specifier, context, next) {
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
      if (Object.hasOwn(extra, specifier)) {
        return virtual(extra[specifier]);
      }
      return next(specifier, context);
    },
  });
}
