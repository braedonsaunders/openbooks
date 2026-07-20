/**
 * App menu layout. "topbar" = the default top menu bar with the same groups
 * available as dropdowns; "sidebar" = the optional left rail.
 *
 * Pure constants only — safe to import from client components (mirrors the
 * i18n/config.ts vs lib/locale.ts split). Server-only resolution lives in
 * nav-mode-resolve.ts.
 */

export const NAV_MODES = ["sidebar", "topbar"] as const;
export type NavMode = (typeof NAV_MODES)[number];
export const DEFAULT_NAV_MODE: NavMode = "topbar";

export function isNavMode(v: unknown): v is NavMode {
  return typeof v === "string" && (NAV_MODES as readonly string[]).includes(v);
}

export function effectiveNavMode(userMode: unknown, orgDefault: unknown): NavMode {
  if (isNavMode(userMode)) return userMode;
  if (isNavMode(orgDefault)) return orgDefault;
  return DEFAULT_NAV_MODE;
}
