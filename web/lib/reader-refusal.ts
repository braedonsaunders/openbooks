import "server-only";
import { getLocale, getTranslations } from "next-intl/server";
import type { CatalogRefusal } from "@openbooks/engine/platform/catalog-refusal";
import {
  renderCatalogRefusal,
  type CatalogRefusalBody,
  type CatalogTranslator,
} from "./refusal-catalog";

/**
 * A catalog refusal in the request's language (server components, route
 * handlers and server actions). Outside a request it keeps its English text.
 */
export async function readerRefusal(
  refusal: CatalogRefusalBody | CatalogRefusal,
): Promise<{ message: string; remedy: string }> {
  let locale: string;
  let t: CatalogTranslator;
  try {
    [locale, t] = await Promise.all([
      getLocale(),
      getTranslations() as unknown as Promise<CatalogTranslator>,
    ]);
  } catch {
    return { message: refusal.message, remedy: refusal.remedy };
  }
  return renderCatalogRefusal(refusal as CatalogRefusalBody, t, locale);
}
