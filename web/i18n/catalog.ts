import "server-only";
import { createHash } from "node:crypto";
import { DEFAULT_LOCALE, type Locale } from "./config";

export type Messages = Record<string, unknown>;

// Statically analyzable per-locale loaders (no template dynamic imports —
// the bundler must be able to see every catalog at build time).
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

async function loadLocaleMessages(locale: Locale): Promise<Messages> {
  const en = (await MESSAGE_LOADERS[DEFAULT_LOCALE]()).default;
  return locale === DEFAULT_LOCALE ? en : withEnglishFallback(en, (await MESSAGE_LOADERS[locale]()).default);
}

// The catalogs are static, so production merges each locale once per process.
// Development re-reads them so edited messages appear without a restart.
const mergedCatalogs = new Map<Locale, Promise<Messages>>();

/** A locale's complete catalog, with English filling untranslated keys. */
export function localeMessages(locale: Locale): Promise<Messages> {
  if (process.env.NODE_ENV !== "production") return loadLocaleMessages(locale);
  let catalog = mergedCatalogs.get(locale);
  if (!catalog) {
    catalog = loadLocaleMessages(locale);
    mergedCatalogs.set(locale, catalog);
    catalog.catch(() => mergedCatalogs.delete(locale));
  }
  return catalog;
}

export type SerializedCatalog = { version: string; body: string };

const serialized = new WeakMap<Messages, SerializedCatalog>();

/** The catalog's JSON body and the content version that names it. */
export function serializeCatalog(messages: Messages): SerializedCatalog {
  let entry = serialized.get(messages);
  if (!entry) {
    const body = JSON.stringify(messages);
    entry = { version: createHash("sha256").update(body).digest("hex").slice(0, 20), body };
    serialized.set(messages, entry);
  }
  return entry;
}

/** The URL the browser loads a catalog version from; immutable per version. */
export function clientCatalogUrl(locale: Locale, version: string): string {
  return `/api/i18n/catalog?${new URLSearchParams({ locale, v: version })}`;
}

const PUBLISHED_CATALOGS = Symbol.for("openbooks.i18n.client-catalogs");

/**
 * Make a catalog version available to server rendering of client components,
 * which runs in this process after the root layout but cannot receive the
 * catalog through props without also sending it to the browser.
 */
export function publishClientCatalog(messages: Messages): SerializedCatalog {
  const catalog = serializeCatalog(messages);
  const store = globalThis as { [PUBLISHED_CATALOGS]?: Map<string, Messages> };
  (store[PUBLISHED_CATALOGS] ??= new Map()).set(catalog.version, messages);
  return catalog;
}
