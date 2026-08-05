import { getRequestConfig } from "next-intl/server";
import { resolveLocale } from "../lib/locale";
import { DEFAULT_LOCALE, type Locale } from "./config";

type Messages = Record<string, unknown>;

// Statically analyzable per-locale loaders (no template dynamic imports —
// Turbopack must be able to see every catalog at build time).
const MESSAGE_LOADERS: Record<Locale, () => Promise<{ default: Messages }>> = {
  en: () => import("../messages/en"),
  fr: () => import("../messages/fr"),
  es: () => import("../messages/es"),
  de: () => import("../messages/de"),
  "pt-BR": () => import("../messages/pt-BR"),
  zh: () => import("../messages/zh"),
  ja: () => import("../messages/ja"),
};

/**
 * Deep-merge a locale's catalogs over the English source so a key missed in
 * one translation renders in English instead of leaking a raw key path.
 * English is the source of truth; translations may lag by at most a render.
 */
function withEnglishFallback(base: Messages, overlay: Messages): Messages {
  const out: Messages = { ...base };
  for (const [k, v] of Object.entries(overlay)) {
    const cur = out[k];
    out[k] =
      v && typeof v === "object" && cur && typeof cur === "object"
        ? withEnglishFallback(cur as Messages, v as Messages)
        : v;
  }
  return out;
}

export default getRequestConfig(async () => {
  const locale = await resolveLocale();
  const en = (await MESSAGE_LOADERS[DEFAULT_LOCALE]()).default;
  const messages =
    locale === DEFAULT_LOCALE
      ? en
      : withEnglishFallback(en, (await MESSAGE_LOADERS[locale]()).default);

  return {
    locale,
    messages: messages as any,
    // Stable server/client timezone. Monetary rendering uses the same resolved
    // locale through the shared client and server money formatters.
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
});
