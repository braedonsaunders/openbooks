/**
 * App menu layout. "sidebar" = the default left rail (current shell);
 * "topbar" = NetSuite-style top menu bar with the rail's groups as dropdowns.
 *
 * Pure constants only — safe to import from client components (mirrors the
 * i18n/config.ts vs lib/locale.ts split). Server-only resolution lives in
 * nav-mode-resolve.ts.
 */

export const NAV_MODES = ["sidebar", "topbar"] as const;
export type NavMode = (typeof NAV_MODES)[number];
export const DEFAULT_NAV_MODE: NavMode = "sidebar";

export function isNavMode(v: unknown): v is NavMode {
  return typeof v === "string" && (NAV_MODES as readonly string[]).includes(v);
}

