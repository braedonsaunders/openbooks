/**
 * Shipped locales. Adding a language = add its code here, create
 * web/messages/<code>/ with every namespace translated, and (optionally)
 * seed it as an org default. Locale resolution: users.locale (personal
 * choice) ?? orgs.settings.defaultLocale (tenant default) ?? DEFAULT_LOCALE.
 */
export const LOCALES = [
  { code: "en", label: "English" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "de", label: "Deutsch" },
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "zh", label: "中文" },
  { code: "ja", label: "日本語" },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];

export const LOCALE_CODES = LOCALES.map((l) => l.code) as readonly Locale[];

export const DEFAULT_LOCALE: Locale = "en";

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALE_CODES as readonly string[]).includes(v);
}
