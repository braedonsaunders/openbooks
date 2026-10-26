import { refusalArguments, type RefusalValues } from "@openbooks/engine/platform/catalog-refusal";

/**
 * Catalog-backed domain refusals in the reader's language.
 *
 * A domain refusal that names a catalog key (`catalogKey`, such as
 * `equity.eventExceedsVested`) and its typed figures renders its message and
 * remedy from `refusals.<catalogKey>.message|remedy` in the locale catalogs.
 * Every figure is formatted for the reader before the template sees it, and
 * field names resolve from the same catalog keys as the form labels, so a
 * remedy that names a field reads exactly as the field does. A refusal whose
 * key has no catalog entry keeps its own English text.
 */

export interface CatalogRefusalBody {
  code: string;
  catalogKey: string;
  values: RefusalValues;
  message: string;
  remedy: string;
}

/** A refusal (an error or its plain-data form) that renders from the catalogs. */
export function isCatalogRefusal(value: unknown): value is CatalogRefusalBody {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CatalogRefusalBody>;
  return (
    typeof candidate.catalogKey === "string" &&
    typeof candidate.message === "string" &&
    typeof candidate.remedy === "string" &&
    (candidate.values === undefined ||
      (typeof candidate.values === "object" && candidate.values !== null))
  );
}

/** A root translator: full catalog paths, with `has` to tell a missing entry from a present one. */
export interface CatalogTranslator {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
}

/** Message and remedy of a catalog refusal in a locale, through a root translator. */
export function renderCatalogRefusal(
  refusal: CatalogRefusalBody,
  t: CatalogTranslator,
  locale: string,
): { message: string; remedy: string } {
  const base = `refusals.${refusal.catalogKey}`;
  if (!t.has(`${base}.message`) || !t.has(`${base}.remedy`))
    return { message: refusal.message, remedy: refusal.remedy };
  const args = refusalArguments(refusal.values ?? {}, locale, (key, text) =>
    t.has(key) ? t(key) : text,
  );
  return { message: t(`${base}.message`, args), remedy: t(`${base}.remedy`, args) };
}
